import "dotenv/config";
import express, { type NextFunction, type Request, type Response } from "express";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RunEventBus } from "../kernel/event-bus";
import { Kernel, KernelError } from "../kernel/kernel";
import { createDefaultProviderRegistry } from "../providers/registry";
import { SQLiteStore } from "../store/sqlite";
import type {
  AdapterRegistryItem,
  AppSettingsResponse,
  CreateRunRequest,
  DaemonStatus,
  JsonObject,
  JsonValue,
  ProviderProfileSummary,
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
const mode = process.env.NODE_ENV || "development";
const shouldServeDashboard = mode === "production" || process.env.AGENT_PLATFORM_DAEMON === "1";

const store = new SQLiteStore({ dbPath });
const eventBus = new RunEventBus();
const providers = createDefaultProviderRegistry(process.env);
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

app.get("/api/sessions", (_req, res) => {
  res.json(kernel.listSessions());
});

app.post("/api/sessions", (req, res) => {
  const title = typeof req.body?.title === "string" ? req.body.title : undefined;
  res.status(201).json(kernel.createSession(title));
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
    const body = req.body as Partial<CreateRunRequest> | undefined;
    const text = typeof body?.text === "string" ? body.text : "";
    const provider = typeof body?.provider === "string" ? body.provider : undefined;
    res.status(202).json(kernel.startRun(req.params.id, text, provider));
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

function getSettingsResponse(): AppSettingsResponse {
  return {
    settings: store.listSettings(),
    providerProfiles: getProviderProfiles(process.env),
    adapters: getAdapterRegistry()
  };
}

function getProviderProfiles(env: NodeJS.ProcessEnv): ProviderProfileSummary[] {
  const hasOpenAIKey = Boolean(env.OPENAI_API_KEY?.trim());
  return [
    {
      id: "mock",
      name: "Mock streaming provider",
      type: "mock",
      source: "built-in",
      status: "available",
      enabled: true
    },
    {
      id: "openai-compatible",
      name: "OpenAI-compatible provider",
      type: "openai-compatible",
      source: "env",
      status: hasOpenAIKey ? "configured" : "missing-credential",
      enabled: hasOpenAIKey,
      baseUrl: env.OPENAI_BASE_URL?.trim() || "https://api.openai.com/v1",
      model: env.OPENAI_MODEL?.trim() || "gpt-4o-mini",
      credentialRef: "env:OPENAI_API_KEY"
    }
  ];
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

function parsePort(value: string | undefined): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : defaultPort;
}

function resolveDbPath(value: string | undefined): string {
  const configuredPath = value?.trim();
  return configuredPath ? resolve(process.cwd(), configuredPath) : resolve(process.cwd(), "data", "app.db");
}

function readPackageVersion(packagePath: string): string {
  try {
    const packageJson = JSON.parse(readFileSync(packagePath, "utf8")) as { version?: unknown };
    return typeof packageJson.version === "string" ? packageJson.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}
