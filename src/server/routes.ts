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
import {
  extractSettingsPatch,
  normalizeSettingsPatch,
  optionalString,
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
    const response: AgentListResponse = {
      agents: kernel.listAgentDefinitions(),
      defaultAgentId
    };
    res.json(response);
  });

  app.get("/api/agents/:id", (req, res, next) => {
    try {
      res.json(kernel.getAgentDefinition(req.params.id));
    } catch (error) {
      next(error);
    }
  });

  app.patch("/api/agents/:id", (req, res, next) => {
    try {
      const patch = parseAgentDefinitionPatch(req.body);
      res.json(
        kernel.updateAgentDefinition({
          id: req.params.id,
          ...patch,
          updatedAt: new Date().toISOString()
        })
      );
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/context/preview", (req, res, next) => {
    try {
      const body = requestBodyObject(req.body);
      const sessionId = optionalString(body.sessionId);
      if (!sessionId) {
        throw new KernelError("Context preview requires body field 'sessionId'.", 400);
      }
      res.json(buildContextPreview(kernel, sessionId, body));
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/providers", (_req, res) => {
    res.json(providers.list());
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
      res.json(withOpenAIChatGPTProfile(result, providers));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/providers/openai-chatgpt/logout", async (_req, res, next) => {
    try {
      await openAIChatGPTAuth.logout();
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
    try {
      const status = parsePermissionStatus(req.query.status);
      const response: PermissionListResponse = { permissions: kernel.listPermissionRequests(status) };
      res.json(response);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/permissions/:id/approve", async (req, res, next) => {
    try {
      res.json(await kernel.approvePermissionRequest(req.params.id));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/permissions/:id/deny", (req, res, next) => {
    try {
      res.json(kernel.denyPermissionRequest(req.params.id));
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/sessions", (_req, res) => {
    res.json(kernel.listSessions());
  });

  app.post("/api/sessions", (req, res, next) => {
    try {
      res.status(201).json(kernel.createSession(parseCreateSessionRequest(requestBodyObject(req.body))));
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/sessions/:id", (req, res, next) => {
    try {
      res.json(kernel.getSession(req.params.id));
    } catch (error) {
      next(error);
    }
  });

  app.patch("/api/sessions/:id", (req, res, next) => {
    try {
      const patch = parseSessionPatch(req.body);
      res.json(kernel.updateSessionWorkingDirectory(req.params.id, patch.workingDirectory));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/sessions/:id/context/preview", (req, res, next) => {
    try {
      res.json(buildContextPreview(kernel, req.params.id, requestBodyObject(req.body)));
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/sessions/:id/messages", (req, res, next) => {
    try {
      res.json(kernel.listMessages(req.params.id));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/sessions/:id/tools/shell.exec", async (req, res, next) => {
    try {
      const input = parseShellExecRequest(requestBodyObject(req.body));
      res.json(await kernel.invokeTool(req.params.id, "shell.exec", input, { caller: "manual" }));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/sessions/:id/runs", (req, res, next) => {
    try {
      const body = req.body as Record<string, unknown> | undefined;
      const text = typeof body?.text === "string" ? body.text : "";
      const agentId = typeof body?.agentId === "string" ? body.agentId : undefined;
      const provider = typeof body?.provider === "string" ? body.provider : undefined;
      const providerProfileId = typeof body?.providerProfileId === "string" ? body.providerProfileId : undefined;
      const runOptions = parseRunOptionsFromBody(body);
      res.status(202).json(kernel.startRun(req.params.id, text, { agentId, provider, providerProfileId, runOptions }));
    } catch (error) {
      next(error);
    }
  });
}

function registerRunRoutes(app: Express, dependencies: ApiRouteDependencies): void {
  const { kernel } = dependencies;

  app.get("/api/runs/:id/events", (req, res, next) => {
    try {
      const runId = req.params.id;
      kernel.getRun(runId);

      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
      res.flushHeaders?.();
      res.write("retry: 1000\n\n");

      const seenEventIds = new Set<string>();
      const send = (event: RunEvent): void => {
        if (seenEventIds.has(event.id) || res.writableEnded) {
          return;
        }
        seenEventIds.add(event.id);
        res.write(`id: ${event.seq}\n`);
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      };

      const unsubscribe = kernel.subscribeRunEvents(runId, send);
      for (const event of kernel.listRunEvents(runId)) {
        send(event);
      }

      const ping = setInterval(() => {
        if (!res.writableEnded) {
          res.write(": ping\n\n");
        }
      }, 15_000);

      req.on("close", () => {
        clearInterval(ping);
        unsubscribe();
      });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/runs/:id/cancel", (req, res, next) => {
    try {
      res.json(kernel.cancelRun(req.params.id));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/runs/:id/resume", (req, res, next) => {
    try {
      res.json(kernel.resumeRun(req.params.id));
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
