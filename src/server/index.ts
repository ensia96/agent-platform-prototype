import "dotenv/config";
import express, { type NextFunction, type Request, type Response } from "express";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RunEventBus } from "../kernel/event-bus";
import { Kernel, KernelError } from "../kernel/kernel";
import { OpenAIChatGPTAuthService } from "../providers/openai-chatgpt-auth";
import {
  defaultOpenAIChatGPTEndpoint,
  defaultOpenAIChatGPTIssuer,
  OpenAIChatGPTCredentialStore
} from "../providers/openai-chatgpt-credentials";
import { createDefaultProviderRegistry } from "../providers/registry";
import { normalizeToolSettings, toolSettingsSettingKey } from "../shared/tool-settings";
import type { DaemonStatus, ToolSettings } from "../shared/types";
import { SQLiteStore } from "../store/sqlite";
import { createDefaultToolRegistry } from "../tools/registry";
import { registerApiRoutes } from "./routes";

const defaultPort = 8787;
const moduleDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(moduleDir, "..", "..");
const defaultSessionWorkingDirectory = resolve(homedir());
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

const store = new SQLiteStore({ dbPath, defaultWorkingDirectory: defaultSessionWorkingDirectory });
const eventBus = new RunEventBus();
const openAIChatGPTCredentials = new OpenAIChatGPTCredentialStore({ runtimeDir });
const openAIChatGPTAuth = new OpenAIChatGPTAuthService({
  credentialStore: openAIChatGPTCredentials,
  issuer: process.env.OPENAI_CHATGPT_AUTH_ISSUER || defaultOpenAIChatGPTIssuer,
  endpoint: process.env.OPENAI_CHATGPT_ENDPOINT || defaultOpenAIChatGPTEndpoint,
  clientId: process.env.OPENAI_CHATGPT_CLIENT_ID
});
const providers = createDefaultProviderRegistry(process.env, { openAIChatGPTCredentials });
const tools = createDefaultToolRegistry({ getShellSettings: () => getToolSettings().shell });
const kernel = new Kernel({ store, eventBus, providers, tools, toolExecutionCwd: defaultSessionWorkingDirectory });
const app = express();

app.use(express.json());
registerApiRoutes(app, {
  dbPath,
  kernel,
  openAIChatGPTAuth,
  providers,
  store,
  getDaemonStatus,
  getToolSettings
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

function getToolSettings(): ToolSettings {
  return normalizeToolSettings(store.listSettings()[toolSettingsSettingKey]);
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
