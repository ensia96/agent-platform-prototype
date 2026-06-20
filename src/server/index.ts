import "dotenv/config";
import express, { type NextFunction, type Request, type Response } from "express";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultAgentId } from "../kernel/context-builder";
import { RunEventBus } from "../kernel/event-bus";
import { Kernel, KernelError } from "../kernel/kernel";
import { OpenAIChatGPTAuthService } from "../providers/openai-chatgpt-auth";
import {
  defaultOpenAIChatGPTEndpoint,
  defaultOpenAIChatGPTIssuer,
  openAIChatGPTProfileId,
  OpenAIChatGPTCredentialStore
} from "../providers/openai-chatgpt-credentials";
import { createDefaultProviderRegistry } from "../providers/registry";
import { SQLiteStore } from "../store/sqlite";
import type {
  AdapterRegistryItem,
  AgentListResponse,
  AppSettingsResponse,
  DaemonStatus,
  JsonObject,
  JsonValue,
  OpenAIChatGPTAuthPollResponse,
  OpenAIChatGPTLogoutResponse,
  ReasoningEffort,
  RunOptions,
  RunEvent
} from "../shared/types";

const defaultPort = 8787;
const moduleDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(moduleDir, "..", "..");
const packageJsonPath = resolve(projectRoot, "package.json");
const dashboardDistDir = resolve(projectRoot, "dist", "client");
const dashboardIndexPath = resolve(dashboardDistDir, "index.html");
const dashboardBuildMissingMessage = "Dashboard build missing. Run npm run build or npm run dev.";
const startedAtMs = Date.now();
const startedAt = new Date(startedAtMs).toISOString();
const version = readPackageVersion(packageJsonPath);
const port = parsePort(process.env.PORT);
const dbPath = resolveDbPath(process.env.AGENT_PLATFORM_DB_PATH ?? process.env.DB_PATH);
const runtimeDir = resolveRuntimeDir(process.env.AGENT_PLATFORM_RUNTIME_DIR);
const mode = process.env.NODE_ENV || "development";
const shouldServeDashboard = mode === "production" || process.env.AGENT_PLATFORM_DAEMON === "1";

type AgentDefinitionPatch = {
  name?: string;
  description?: string | null;
  systemPrompt?: string;
  modelProfileId?: string | null;
  defaultRunOptions?: RunOptions | null;
  skillIds?: string[];
  toolIds?: string[];
  metadata?: JsonObject;
};

const store = new SQLiteStore({ dbPath });
const eventBus = new RunEventBus();
const openAIChatGPTCredentials = new OpenAIChatGPTCredentialStore({ runtimeDir });
const openAIChatGPTAuth = new OpenAIChatGPTAuthService({
  credentialStore: openAIChatGPTCredentials,
  issuer: process.env.OPENAI_CHATGPT_AUTH_ISSUER || defaultOpenAIChatGPTIssuer,
  endpoint: process.env.OPENAI_CHATGPT_ENDPOINT || defaultOpenAIChatGPTEndpoint,
  clientId: process.env.OPENAI_CHATGPT_CLIENT_ID
});
const providers = createDefaultProviderRegistry(process.env, { openAIChatGPTCredentials });
const kernel = new Kernel({ store, eventBus, providers });
const app = express();

app.use(express.json());

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, dbPath, time: new Date().toISOString() });
});

app.get("/api/status", (_req, res) => {
  res.json(getDaemonStatus());
});

app.get("/api/settings", (_req, res) => {
  res.json(getSettingsResponse());
});

app.patch("/api/settings", (req, res) => {
  const patch = extractSettingsPatch(req.body);
  if (!patch) {
    res.status(400).json({ error: "PATCH /api/settings expects a JSON object or { settings: object }." });
    return;
  }

  const updatedAt = new Date().toISOString();
  for (const [key, value] of Object.entries(patch)) {
    store.setSetting(key, value, updatedAt);
  }
  res.json(getSettingsResponse());
});

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
    res.json(buildContextPreview(sessionId, body));
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
    res.json(withOpenAIChatGPTProfile(result));
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
      profile: getOpenAIChatGPTProfile()
    };
    res.json(response);
  } catch (error) {
    next(error);
  }
});

app.get("/api/sessions", (_req, res) => {
  res.json(kernel.listSessions());
});

app.post("/api/sessions", (req, res) => {
  const title = typeof req.body?.title === "string" ? req.body.title : undefined;
  res.status(201).json(kernel.createSession(title));
});

app.post("/api/sessions/:id/context/preview", (req, res, next) => {
  try {
    res.json(buildContextPreview(req.params.id, requestBodyObject(req.body)));
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

app.use("/api", (_req, res) => {
  res.status(404).json({ error: "API route not found." });
});

if (shouldServeDashboard) {
  app.use(express.static(dashboardDistDir, { index: false }));
  app.get("*", (req, res) => {
    if (!dashboardBuildExists()) {
      sendDashboardBuildMissing(req, res);
      return;
    }

    res.sendFile(dashboardIndexPath);
  });
}

app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const status = error instanceof KernelError ? error.statusCode : 500;
  const message = error instanceof Error ? error.message : "Unknown error";
  if (status >= 500) {
    console.error(error);
  }
  res.status(status).json({ error: message });
});

const server = app.listen(port, "127.0.0.1", () => {
  console.log(`Agent platform prototype server listening on http://127.0.0.1:${port}`);
  console.log(`SQLite database: ${dbPath}`);
});

let shuttingDown = false;

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

function shutdown(signal: NodeJS.Signals): void {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  console.log(`Received ${signal}; closing HTTP server...`);

  const forceExit = setTimeout(() => {
    console.error("HTTP server did not close within 10s; exiting.");
    process.exit(1);
  }, 10_000);
  forceExit.unref();

  server.close((error) => {
    clearTimeout(forceExit);
    if (error) {
      console.error("Failed to close HTTP server", error);
      process.exit(1);
    }
    console.log("HTTP server closed.");
    process.exit(0);
  });
}

function getDaemonStatus(): DaemonStatus {
  return {
    status: "ok",
    version,
    pid: process.pid,
    startedAt,
    uptimeSeconds: Math.max(0, Math.floor((Date.now() - startedAtMs) / 1000)),
    mode,
    port,
    dbPath
  };
}

function withOpenAIChatGPTProfile(response: OpenAIChatGPTAuthPollResponse): OpenAIChatGPTAuthPollResponse {
  return response.status === "connected" ? { ...response, profile: getOpenAIChatGPTProfile() } : response;
}

function getOpenAIChatGPTProfile() {
  const profile = providers.list().providers.find((item) => item.id === openAIChatGPTProfileId);
  if (!profile) {
    throw new Error("OpenAI ChatGPT provider profile is not registered.");
  }
  return profile;
}

function getSettingsResponse(): AppSettingsResponse {
  return {
    settings: store.listSettings(),
    providerProfiles: providers.list().providers,
    adapters: getAdapterRegistry()
  };
}

function buildContextPreview(sessionId: string, body: Record<string, unknown>) {
  const runOptions = parseRunOptionsFromBody(body);
  return kernel.previewContext(sessionId, {
    agentId: optionalString(body.agentId),
    provider: optionalString(body.provider),
    providerProfileId: optionalString(body.providerProfileId),
    runOptions,
    text: optionalString(body.text)
  });
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

function dashboardBuildExists(): boolean {
  return existsSync(dashboardIndexPath);
}

function sendDashboardBuildMissing(req: Request, res: Response): void {
  res.status(503);
  res.setHeader("Cache-Control", "no-store");

  if (req.accepts(["html", "json"]) === "json") {
    res.json({
      error: "dashboard_build_missing",
      message: dashboardBuildMissingMessage
    });
    return;
  }

  res.type("html").send(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Dashboard build missing</title>
  </head>
  <body>
    <main style="font-family: system-ui, sans-serif; max-width: 720px; margin: 4rem auto; line-height: 1.5;">
      <h1>Dashboard build missing</h1>
      <p>${dashboardBuildMissingMessage}</p>
    </main>
  </body>
</html>`);
}

function extractSettingsPatch(body: unknown): JsonObject | null {
  const candidate = isPlainObject(body) && isPlainObject(body.settings) ? body.settings : body;
  if (!isPlainObject(candidate)) {
    return null;
  }

  const patch: JsonObject = {};
  for (const [key, value] of Object.entries(candidate)) {
    if (!isValidSettingKey(key) || !isJsonValue(value)) {
      return null;
    }
    patch[key] = value;
  }
  return patch;
}

function parseAgentDefinitionPatch(body: unknown): AgentDefinitionPatch {
  if (!isPlainObject(body)) {
    throw new KernelError("PATCH /api/agents/:id expects a JSON object.", 400);
  }

  const allowedKeys = new Set([
    "name",
    "description",
    "systemPrompt",
    "modelProfileId",
    "defaultRunOptions",
    "skillIds",
    "toolIds",
    "metadata"
  ]);
  for (const key of Object.keys(body)) {
    if (!allowedKeys.has(key)) {
      throw new KernelError(`Unsupported agent definition field '${key}'.`, 400);
    }
  }

  const patch: AgentDefinitionPatch = {};
  if ("name" in body) {
    if (typeof body.name !== "string") {
      throw new KernelError("Agent field 'name' must be a string.", 400);
    }
    const name = body.name.trim();
    if (!name || name.length > 120) {
      throw new KernelError("Agent field 'name' must be 1-120 characters.", 400);
    }
    patch.name = name;
  }

  if ("description" in body) {
    if (body.description === null || body.description === undefined) {
      patch.description = null;
    } else if (typeof body.description === "string") {
      const description = body.description.trim();
      if (description.length > 1000) {
        throw new KernelError("Agent field 'description' must be 1000 characters or fewer.", 400);
      }
      patch.description = description || null;
    } else {
      throw new KernelError("Agent field 'description' must be a string or null.", 400);
    }
  }

  if ("systemPrompt" in body) {
    if (typeof body.systemPrompt !== "string") {
      throw new KernelError("Agent field 'systemPrompt' must be a string.", 400);
    }
    if (!body.systemPrompt.trim() || body.systemPrompt.length > 20_000) {
      throw new KernelError("Agent field 'systemPrompt' must be 1-20000 characters.", 400);
    }
    patch.systemPrompt = body.systemPrompt;
  }

  if ("modelProfileId" in body) {
    if (body.modelProfileId === null || body.modelProfileId === undefined || body.modelProfileId === "") {
      patch.modelProfileId = null;
    } else if (typeof body.modelProfileId === "string") {
      const modelProfileId = body.modelProfileId.trim();
      if (modelProfileId.length > 120) {
        throw new KernelError("Agent field 'modelProfileId' must be 120 characters or fewer.", 400);
      }
      patch.modelProfileId = modelProfileId || null;
    } else {
      throw new KernelError("Agent field 'modelProfileId' must be a string or null.", 400);
    }
  }

  if ("defaultRunOptions" in body) {
    patch.defaultRunOptions = body.defaultRunOptions === null ? null : parseRunOptionsValue(body.defaultRunOptions) ?? {};
  }

  if ("skillIds" in body) {
    patch.skillIds = parseStringList(body.skillIds, "skillIds");
  }
  if ("toolIds" in body) {
    patch.toolIds = parseStringList(body.toolIds, "toolIds");
  }

  if ("metadata" in body) {
    if (!isPlainObject(body.metadata) || !isJsonValue(body.metadata)) {
      throw new KernelError("Agent field 'metadata' must be a JSON object.", 400);
    }
    if (containsSensitiveKey(body.metadata)) {
      throw new KernelError("Agent metadata must not contain credential, token, secret, or API key fields.", 400);
    }
    patch.metadata = body.metadata;
  }

  return patch;
}

function parseRunOptionsFromBody(body: Record<string, unknown> | undefined): RunOptions | undefined {
  const rawOptions = body?.runOptions ?? body?.options;
  return parseRunOptionsValue(rawOptions);
}

function parseRunOptionsValue(rawOptions: unknown): RunOptions | undefined {
  if (rawOptions === undefined || rawOptions === null) {
    return undefined;
  }
  if (!isPlainObject(rawOptions)) {
    throw new KernelError("Run options must be a JSON object.", 400);
  }

  const options: RunOptions = {};
  if ("model" in rawOptions) {
    if (rawOptions.model !== null && rawOptions.model !== undefined) {
      if (typeof rawOptions.model !== "string") {
        throw new KernelError("Run option 'model' must be a string.", 400);
      }
      const model = rawOptions.model.trim();
      if (model.length > 200) {
        throw new KernelError("Run option 'model' must be 200 characters or fewer.", 400);
      }
      if (model) {
        options.model = model;
      }
    }
  }

  if ("reasoningEffort" in rawOptions) {
    if (rawOptions.reasoningEffort !== null && rawOptions.reasoningEffort !== undefined && rawOptions.reasoningEffort !== "") {
      if (!isReasoningEffort(rawOptions.reasoningEffort)) {
        throw new KernelError("Run option 'reasoningEffort' must be one of minimal, low, medium, high, xhigh.", 400);
      }
      options.reasoningEffort = rawOptions.reasoningEffort;
    }
  }

  if ("temperature" in rawOptions) {
    if (rawOptions.temperature !== null && rawOptions.temperature !== undefined && rawOptions.temperature !== "") {
      if (typeof rawOptions.temperature !== "number" || !Number.isFinite(rawOptions.temperature)) {
        throw new KernelError("Run option 'temperature' must be a finite number.", 400);
      }
      if (rawOptions.temperature < 0 || rawOptions.temperature > 2) {
        throw new KernelError("Run option 'temperature' must be between 0 and 2.", 400);
      }
      options.temperature = rawOptions.temperature;
    }
  }

  return options;
}

function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return value === "minimal" || value === "low" || value === "medium" || value === "high" || value === "xhigh";
}

function isValidSettingKey(key: string): boolean {
  return key.trim().length > 0 && key.length <= 128;
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null) {
    return true;
  }

  if (typeof value === "string" || typeof value === "boolean") {
    return true;
  }

  if (typeof value === "number") {
    return Number.isFinite(value);
  }

  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }

  if (isPlainObject(value)) {
    return Object.values(value).every(isJsonValue);
  }

  return false;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requestBodyObject(body: unknown): Record<string, unknown> {
  return isPlainObject(body) ? body : {};
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parseStringList(value: unknown, fieldName: string): string[] {
  if (!Array.isArray(value)) {
    throw new KernelError(`Agent field '${fieldName}' must be an array of strings.`, 400);
  }
  if (value.length > 100) {
    throw new KernelError(`Agent field '${fieldName}' must contain 100 IDs or fewer.`, 400);
  }
  const output: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") {
      throw new KernelError(`Agent field '${fieldName}' must be an array of strings.`, 400);
    }
    const trimmed = item.trim();
    if (!trimmed) {
      continue;
    }
    if (trimmed.length > 120) {
      throw new KernelError(`Agent field '${fieldName}' IDs must be 120 characters or fewer.`, 400);
    }
    if (!output.includes(trimmed)) {
      output.push(trimmed);
    }
  }
  return output;
}

function containsSensitiveKey(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(containsSensitiveKey);
  }
  if (!isPlainObject(value)) {
    return false;
  }
  return Object.entries(value).some(([key, nested]) => isSensitiveMetadataKey(key) || containsSensitiveKey(nested));
}

function isSensitiveMetadataKey(key: string): boolean {
  return /authorization|cookie|token|secret|api[_-]?key|credential|password|refresh|access/i.test(key);
}

function parsePort(value: string | undefined): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : defaultPort;
}

function resolveDbPath(value: string | undefined): string {
  const configuredPath = value?.trim();
  return configuredPath ? resolve(process.cwd(), configuredPath) : resolve(process.cwd(), "data", "app.db");
}

function resolveRuntimeDir(value: string | undefined): string {
  const configuredPath = value?.trim();
  return configuredPath ? resolve(process.cwd(), configuredPath) : resolve(process.cwd(), ".agent-platform");
}

function readPackageVersion(packagePath: string): string {
  try {
    const packageJson = JSON.parse(readFileSync(packagePath, "utf8")) as { version?: unknown };
    return typeof packageJson.version === "string" ? packageJson.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}
