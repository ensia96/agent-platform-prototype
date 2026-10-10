import type { Express, Response } from "express";
import { defaultAgentId } from "../kernel/context-builder";
import { KernelError, type Kernel } from "../kernel/kernel";
import type { OpenAIChatGPTAuthService } from "../providers/openai-chatgpt-auth";
import { openAIChatGPTProfileId } from "../providers/openai-chatgpt-credentials";
import type { ProviderRegistry } from "../providers/registry";
import type { StoreAdapter } from "../store/types";
import { toolSettingsSettingKey, ToolSettingsValidationError } from "../shared/tool-settings";
import type {
  AdapterRegistryItem,
  AgentListResponse,
  AppSettingsResponse,
  DaemonStatus,
  OpenAIChatGPTAuthPollResponse,
  OpenAIChatGPTLogoutResponse,
  PermissionListResponse,
  RunEvent,
  ToolListResponse,
  ToolSettings,
  ToolSettingsResponse
} from "../shared/types";
import { isTerminalRunEventType } from "../shared/types";
import { RunVO } from "@/kernel/run/vo";
import {
  extractSettingsPatch,
  normalizeSettingsPatch,
  optionalString,
  parseCreateAgentDefinition,
  parseExpectedAgentRevision,
  parseAgentDefinitionPatch,
  parseCreateSessionRequest,
  parsePermissionStatus,
  parseRunOptionsFromBody,
  parseSessionPatch,
  parseShellExecRequest,
  parseToolSettingsPatch,
  requestBodyObject,
  toolSettingsToJson
} from "./request-parsers";
import { OrderedRunEventReplay, planRunEventCursor, resolveRunEventCursor, runEventCursorControl } from "./run-event-replay";

export interface ApiRouteDependencies {
  dbPath: string;
  kernel: Kernel;
  openAIChatGPTAuth: OpenAIChatGPTAuthService;
  providers: ProviderRegistry;
  store: Pick<StoreAdapter, "listSettings" | "setSetting">;
  getDaemonStatus: () => DaemonStatus;
  getToolSettings: () => ToolSettings;
}

export function registerApiRoutes(app: Express, dependencies: ApiRouteDependencies): void {
  registerSystemRoutes(app, dependencies);
  registerAgentAndProviderRoutes(app, dependencies);
  registerToolAndSessionRoutes(app, dependencies);
  registerRunRoutes(app, dependencies);

  app.use("/api", (_req, res) => {
    res.status(404).json({ error: "API route not found." });
  });
}

function registerSystemRoutes(app: Express, dependencies: ApiRouteDependencies): void {
  const { dbPath, getDaemonStatus, getToolSettings, store } = dependencies;

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, dbPath, time: new Date().toISOString() });
  });

  app.get("/api/status", (_req, res) => {
    res.json(getDaemonStatus());
  });

  app.get("/api/settings", (_req, res) => {
    res.json(getSettingsResponse(dependencies));
  });

  app.patch("/api/settings", (req, res) => {
    const patch = extractSettingsPatch(req.body);
    if (!patch) {
      res.status(400).json({ error: "PATCH /api/settings expects a JSON object or { settings: object }." });
      return;
    }

    try {
      const updatedAt = new Date().toISOString();
      for (const [key, value] of Object.entries(normalizeSettingsPatch(patch))) {
        store.setSetting(key, value, updatedAt);
      }
    } catch (error) {
      if (sendToolSettingsValidationError(error, res)) {
        return;
      }
      throw error;
    }
    res.json(getSettingsResponse(dependencies));
  });

  app.get("/api/tool-settings", (_req, res, next) => {
    try {
      const response: ToolSettingsResponse = { settings: getToolSettings() };
      res.json(response);
    } catch (error) {
      if (sendToolSettingsValidationError(error, res)) {
        return;
      }
      next(error);
    }
  });

  app.patch("/api/tool-settings", (req, res, next) => {
    try {
      const settings = parseToolSettingsPatch(req.body, getToolSettings());
      store.setSetting(toolSettingsSettingKey, toolSettingsToJson(settings), new Date().toISOString());
      const response: ToolSettingsResponse = { settings };
      res.json(response);
    } catch (error) {
      if (sendToolSettingsValidationError(error, res)) {
        return;
      }
      next(error);
    }
  });
}

function registerAgentAndProviderRoutes(app: Express, dependencies: ApiRouteDependencies): void {
  const { kernel, openAIChatGPTAuth, providers } = dependencies;

  app.get("/api/agents", (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const response: AgentListResponse = {
      agents: kernel.listAgentDefinitions(),
      defaultAgentId
    };
    res.json(response);
  });

  app.get("/api/agents/:id", (req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    try {
      res.json(kernel.getAgentDefinition(req.params.id));
    } catch (error) {
      next(error);
    }
  });

  app.patch("/api/agents/:id", (req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    try {
      const patch = parseAgentDefinitionPatch(req.body);
      if (patch.expectedRevision === undefined) {
        throw new KernelError("Agent patch requires expectedRevision.", 400);
      }
      const { expectedRevision, ...fields } = patch;
      res.json(
        kernel.updateAgentDefinition({
          id: req.params.id,
          expectedRevision,
          ...fields,
          updatedAt: new Date().toISOString()
        })
      );
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/agents", (req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    try {
      res.status(201).json(kernel.createAgentDefinition(parseCreateAgentDefinition(req.body)));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/agents/:id/clone", (req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    try {
      res.status(201).json(kernel.cloneAgentDefinition(req.params.id, parseExpectedAgentRevision(req.body)));
    } catch (error) {
      next(error);
    }
  });

  app.delete("/api/agents/:id", (req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    try {
      kernel.deleteAgentDefinition(req.params.id, parseExpectedAgentRevision(req.body));
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/context/preview", async (req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    try {
      const body = requestBodyObject(req.body);
      const sessionId = optionalString(body.sessionId);
      if (!sessionId) {
        throw new KernelError("Context preview requires body field 'sessionId'.", 400);
      }
      res.json(await buildContextPreview(kernel, sessionId, body));
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/providers", (_req, res) => {
    res.json(providers.list());
  });

  app.get("/api/providers/:id/models", async (req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    try {
      const catalog = await providers.getModelCatalog(req.params.id, { refresh: req.query.refresh === "1" });
      if (!catalog) {
        res.status(404).json({ error: "unknown_profile", message: `Provider profile '${req.params.id}' was not found.` });
        return;
      }
      res.json(catalog);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/providers/:id/test", async (req, res, next) => {
    try {
      const result = await providers.testProfile(req.params.id);
      if (!result) {
        res.status(404).json({ error: "unknown_profile", message: `Provider profile '${req.params.id}' was not found.` });
        return;
      }
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/providers/openai-chatgpt/auth/start", async (_req, res, next) => {
    try {
      res.status(201).json(await openAIChatGPTAuth.startDeviceAuth());
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/providers/openai-chatgpt/auth/poll", async (req, res, next) => {
    try {
      const attemptId = typeof req.body?.attemptId === "string" ? req.body.attemptId.trim() : "";
      if (!attemptId) {
        res.status(400).json({ error: "missing_attempt_id", message: "Body field 'attemptId' is required." });
        return;
      }

      const result = await openAIChatGPTAuth.pollDeviceAuth(attemptId);
      if (result.status === "connected") {
        providers.invalidateModelCatalog(openAIChatGPTProfileId);
      }
      res.json(withOpenAIChatGPTProfile(result, providers));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/providers/openai-chatgpt/logout", async (_req, res, next) => {
    try {
      await openAIChatGPTAuth.logout();
      providers.invalidateModelCatalog(openAIChatGPTProfileId);
      const response: OpenAIChatGPTLogoutResponse = {
        providerProfileId: openAIChatGPTProfileId,
        ok: true,
        profile: getOpenAIChatGPTProfile(providers)
      };
      res.json(response);
    } catch (error) {
      next(error);
    }
  });
}

function registerToolAndSessionRoutes(app: Express, dependencies: ApiRouteDependencies): void {
  const { kernel } = dependencies;

  app.get("/api/tools", (_req, res) => {
    const response: ToolListResponse = { tools: kernel.listTools() };
    res.json(response);
  });

  app.get("/api/permissions", (req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    try {
      const status = parsePermissionStatus(req.query.status);
      const response: PermissionListResponse = { permissions: kernel.listPermissionRequests(status) };
      res.json(response);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/permissions/:id/approve", async (req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    try {
      const response = await kernel.approvePermissionRequest(req.params.id);
      res.json(response);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/permissions/:id/deny", (req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    try {
      res.json(kernel.denyPermissionRequest(req.params.id));
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/sessions", (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json(kernel.listSessions());
  });

  app.post("/api/sessions", (req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    try {
      res.status(201).json(kernel.createSession(parseCreateSessionRequest(requestBodyObject(req.body))));
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/sessions/:id", (req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    try {
      res.json(kernel.getSession(req.params.id));
    } catch (error) {
      next(error);
    }
  });

  app.patch("/api/sessions/:id", (req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    try {
      const patch = parseSessionPatch(req.body);
      res.json(kernel.updateSession(req.params.id, patch));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/sessions/:id/context/preview", async (req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    try {
      res.json(await buildContextPreview(kernel, req.params.id, requestBodyObject(req.body)));
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/sessions/:id/context/segments", (req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    try {
      res.json(kernel.listContextSegments(req.params.id));
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/sessions/:id/subsessions", (req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    try { res.json(kernel.listSubsessions(req.params.id)); } catch (error) { next(error); }
  });

  app.get("/api/sessions/:id/context/segments/:segmentId", (req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    try {
      res.json(kernel.getContextSegment(req.params.id, req.params.segmentId));
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/sessions/:id/context/segments/:segmentId/messages", (req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    try {
      res.json(kernel.listContextSegmentMessages(req.params.id, req.params.segmentId));
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/sessions/:id/context/artifacts/:artifactId", (req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    try {
      res.json(kernel.getContextArtifact(req.params.id, req.params.artifactId));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/sessions/:id/context/compact", async (req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    try {
      res.json(await kernel.compactSession(req.params.id));
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/sessions/:id/messages", (req, res, next) => {
    try {
      res.setHeader("Cache-Control", "no-store");
      res.json(kernel.listActiveMessages(req.params.id));
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/sessions/:id/runs", (req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    try {
      res.json(kernel.listPublicRuns(req.params.id, req.query.active === "1"));
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/sessions/:id/runs/active", (req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    try {
      res.json(kernel.listPublicRuns(req.params.id, true));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/sessions/:id/tools/shell.exec", async (req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    try {
      const input = parseShellExecRequest(requestBodyObject(req.body));
      if (req.query.async === "1") {
        const response = kernel.startToolInvocation(req.params.id, "shell.exec", input, { caller: "manual" });
        res.status(response.state === "running" ? 202 : 200).json(response);
        return;
      }
      res.status(200).json(await kernel.invokeTool(req.params.id, "shell.exec", input, { caller: "manual" }));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/sessions/:id/runs", async (req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    try {
      const body = req.body as Record<string, unknown> | undefined;
      const text = typeof body?.text === "string" ? body.text : "";
      const agentId = typeof body?.agentId === "string" ? body.agentId : undefined;
      const provider = typeof body?.provider === "string" ? body.provider : undefined;
      const providerProfileId = typeof body?.providerProfileId === "string" ? body.providerProfileId : undefined;
      const runOptions = parseRunOptionsFromBody(body);
      res.status(202).json(await kernel.startRun(req.params.id, text, { agentId, provider, providerProfileId, runOptions }));
    } catch (error) {
      next(error);
    }
  });
}

function registerRunRoutes(app: Express, dependencies: ApiRouteDependencies): void {
  const { kernel } = dependencies;

  app.get("/api/runs/:id", (req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    try {
      res.json(kernel.getPublicRun(req.params.id));
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/runs/:id/events", (req, res, next) => {
    try {
      const runId = req.params.id;
      const run = kernel.getRun(runId);
      let requestedAfter: number;
      try {
        requestedAfter = resolveRunEventCursor(req.query.after, req.get("Last-Event-ID"));
      } catch (error) {
        throw new KernelError(error instanceof Error ? error.message : "Invalid event cursor.", 400);
      }
      const cursorPlan = planRunEventCursor(requestedAfter, kernel.getLatestRunEventSeq(runId), new RunVO.Status(run.status).isTerminal());
      if (cursorPlan.noContent) {
        res.setHeader("Cache-Control", "no-store");
        res.status(204).end();
        return;
      }

      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
      res.flushHeaders?.();
      res.write("retry: 1000\n\n");
      if (cursorPlan.canonicalized) {
        // Named SSE events update EventSource's Last-Event-ID without entering the client's onmessage run-event reducer.
        res.write(runEventCursorControl(cursorPlan.after));
      }

      let closed = false;
      let ping: ReturnType<typeof setInterval> | null = null;
      let unsubscribe: () => void = () => undefined;
      const close = (endResponse: boolean): void => {
        if (closed) {
          return;
        }
        closed = true;
        if (ping) {
          clearInterval(ping);
          ping = null;
        }
        unsubscribe();
        if (endResponse && !res.writableEnded) {
          res.end();
        }
      };
      const send = (event: RunEvent): void => {
        if (closed || res.writableEnded) {
          return;
        }
        res.write(`id: ${event.seq}\n`);
        res.write(`data: ${JSON.stringify(event)}\n\n`);
        if (isTerminalRunEventType(event.type)) {
          close(true);
        }
      };

      const replay = new OrderedRunEventReplay(runId, cursorPlan.after, send);
      unsubscribe = kernel.subscribeRunEvents(runId, (event) => replay.pushLive(event));
      req.once("close", () => close(false));
      replay.replay(kernel.listRunEvents(runId, cursorPlan.after));

      if (!closed && new RunVO.Status(kernel.getRun(runId).status).isTerminal()) {
        close(true);
      }

      if (!closed) {
        ping = setInterval(() => {
          if (!res.writableEnded) {
            res.write(": ping\n\n");
          }
        }, 15_000);
      }
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/runs/:id/cancel", (req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    try {
      kernel.cancelRun(req.params.id);
      res.json(kernel.getPublicRun(req.params.id));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/runs/:id/resume", (req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    try {
      kernel.resumeRun(req.params.id);
      res.json(kernel.getPublicRun(req.params.id));
    } catch (error) {
      next(error);
    }
  });
}

function getSettingsResponse(dependencies: ApiRouteDependencies): AppSettingsResponse {
  return {
    settings: dependencies.store.listSettings(),
    providerProfiles: dependencies.providers.list().providers,
    adapters: getAdapterRegistry()
  };
}

function sendToolSettingsValidationError(error: unknown, res: Response): boolean {
  if (!(error instanceof ToolSettingsValidationError)) {
    return false;
  }
  res.status(400).json({
    error: error.message,
    issues: error.issues.map((issue) => ({
      field: issue.field,
      lineNumber: issue.lineNumber,
      pattern: issue.pattern,
      message: issue.message
    }))
  });
  return true;
}

function buildContextPreview(kernel: Kernel, sessionId: string, body: Record<string, unknown>) {
  const runOptions = parseRunOptionsFromBody(body);
  return kernel.previewContext(sessionId, {
    agentId: optionalString(body.agentId),
    provider: optionalString(body.provider),
    providerProfileId: optionalString(body.providerProfileId),
    runOptions,
    text: optionalString(body.text)
  });
}

function withOpenAIChatGPTProfile(
  response: OpenAIChatGPTAuthPollResponse,
  providers: ProviderRegistry
): OpenAIChatGPTAuthPollResponse {
  return response.status === "connected" ? { ...response, profile: getOpenAIChatGPTProfile(providers) } : response;
}

function getOpenAIChatGPTProfile(providers: ProviderRegistry) {
  const profile = providers.list().providers.find((item) => item.id === openAIChatGPTProfileId);
  if (!profile) {
    throw new Error("OpenAI ChatGPT provider profile is not registered.");
  }
  return profile;
}

function getAdapterRegistry(): AdapterRegistryItem[] {
  return [
    {
      id: "opencode",
      name: "OpenCode",
      status: "planned",
      description: "Local OpenCode adapter placeholder."
    },
    {
      id: "claude-code",
      name: "Claude Code",
      status: "not-installed",
      description: "Claude Code adapter registry entry placeholder."
    },
    {
      id: "codex",
      name: "Codex",
      status: "not-installed",
      description: "Codex CLI adapter registry entry placeholder."
    },
    {
      id: "gemini-cli",
      name: "Gemini CLI",
      status: "not-installed",
      description: "Gemini CLI adapter registry entry placeholder."
    }
  ];
}
