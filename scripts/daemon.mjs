#!/usr/bin/env node
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtimeDir = join(projectRoot, ".agent-platform");
const logsDir = join(runtimeDir, "logs");
const pidPath = join(runtimeDir, "daemon.pid");
const metaPath = join(runtimeDir, "daemon.json");
const logPath = join(logsDir, "daemon.log");

const defaultPort = 8787;
const startTimeoutMs = 10_000;
const stopTimeoutMs = 10_000;
const pollIntervalMs = 250;

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

async function main() {
  const command = process.argv[2] ?? "help";

  switch (command) {
    case "start":
      await startDaemon();
      return;
    case "stop":
      await stopDaemon();
      return;
    case "status":
      await printDaemonStatus();
      return;
    case "help":
    case "--help":
    case "-h":
      printHelp();
      return;
    default:
      console.error(`Unknown command: ${command}`);
      printHelp();
      process.exitCode = 1;
  }
}

async function startDaemon() {
  await ensureRuntimeDirs();
  const state = await readDaemonState();
  const port = configuredPort(state.meta?.port);
  const url = daemonUrl(port);

  if (state.pid !== null) {
    const pidAlive = isProcessAlive(state.pid);
    const status = await fetchDaemonStatus(port);

    if (pidAlive && status.ok && Number(status.body.pid) === state.pid) {
      printRunning(status.body, state.meta, "Agent platform daemon is already running.");
      return;
    }

    if (!pidAlive) {
      console.log(`Removing stale daemon pid ${state.pid}; the process is no longer running.`);
      await cleanupRuntimeMetadata();
    } else if (status.ok) {
      console.error(
        `Refusing to start another daemon: ${url}/api/status reports pid ${status.body.pid}, but ${displayPath(
          pidPath
        )} records pid ${state.pid}.`
      );
      console.error(`Run 'npm run status' for details before starting a new daemon.`);
      process.exitCode = 1;
      return;
    } else {
      console.error(
        `Refusing to start another daemon: recorded pid ${state.pid} is still alive, but ${url}/api/status is not reachable.`
      );
      console.error(`Inspect ${displayPath(logPath)} or run 'npm run stop' before retrying.`);
      process.exitCode = 1;
      return;
    }
  } else {
    const status = await fetchDaemonStatus(port);
    if (status.ok) {
      printRunning(status.body, null, "Agent platform API is already reachable; not starting a duplicate daemon.");
      console.log(`No pid file exists at ${displayPath(pidPath)}, so 'npm run stop' will not manage this process.`);
      return;
    }
  }

  await resolveTsxBin();
  const startedAt = new Date().toISOString();
  const dbPath = resolveDbPath(process.env.AGENT_PLATFORM_DB_PATH ?? process.env.DB_PATH);
  const command = process.execPath;
  const args = ["--import", "tsx", "src/server/index.ts"];
  const meta = {
    pid: null,
    port,
    url,
    dbPath,
    startedAt,
    cwd: projectRoot,
    command: `node ${args.join(" ")}`,
    logPath: displayPath(logPath)
  };

  const logHandle = await open(logPath, "a");
  let child;
  try {
    await logHandle.appendFile(`\n[${startedAt}] Starting agent platform daemon on ${url}\n`);
    child = spawn(command, args, {
      cwd: projectRoot,
      detached: true,
      env: {
        ...process.env,
        AGENT_PLATFORM_DAEMON: "1",
        NODE_ENV: process.env.NODE_ENV || "production",
        PORT: String(port)
      },
      stdio: ["ignore", logHandle.fd, logHandle.fd]
    });
  } finally {
    await logHandle.close();
  }

  if (!child.pid) {
    throw new Error("Failed to start daemon process: child pid is unavailable.");
  }

  child.unref();
  meta.pid = child.pid;
  await writeFile(pidPath, `${child.pid}\n`, "utf8");
  await writeFile(metaPath, `${JSON.stringify(meta, null, 2)}\n`, "utf8");

  console.log(`Starting agent platform daemon in the background (pid ${child.pid})...`);
  const readyStatus = await waitForDaemonStatus(port, child.pid, startTimeoutMs);
  if (readyStatus.ok) {
    printRunning(readyStatus.body, meta, "Agent platform daemon started.");
    return;
  }

  if (!isProcessAlive(child.pid)) {
    await cleanupRuntimeMetadata();
    console.error(`Daemon process exited before it became ready. See ${displayPath(logPath)}.`);
    process.exitCode = 1;
    return;
  }

  console.error(
    `Daemon pid ${child.pid} started, but ${url}/api/status did not become ready within ${startTimeoutMs / 1000}s.`
  );
  console.error(`See ${displayPath(logPath)} for details.`);
  process.exitCode = 1;
}

async function stopDaemon() {
  const state = await readDaemonState();
  if (state.pid === null) {
    if (state.meta) {
      await cleanupRuntimeMetadata();
      console.log(`Removed stale daemon metadata without a pid file.`);
    }
    console.log("Agent platform daemon is not running.");
    return;
  }

  const port = configuredPort(state.meta?.port);
  const pidAlive = isProcessAlive(state.pid);
  const status = await fetchDaemonStatus(port);

  if (!pidAlive) {
    console.log(`Removing stale daemon pid ${state.pid}; the process is no longer running.`);
    await cleanupRuntimeMetadata();
    return;
  }

  if (status.ok && Number(status.body.pid) !== state.pid) {
    console.error(
      `Not sending SIGTERM: ${daemonUrl(port)}/api/status reports pid ${status.body.pid}, but ${displayPath(
        pidPath
      )} records pid ${state.pid}.`
    );
    console.error("The pid file appears stale and was removed. Re-run status if needed.");
    await cleanupRuntimeMetadata();
    process.exitCode = 1;
    return;
  }

  console.log(`Stopping agent platform daemon pid ${state.pid} with SIGTERM...`);
  try {
    process.kill(state.pid, "SIGTERM");
  } catch (error) {
    if (isSystemError(error) && error.code === "ESRCH") {
      await cleanupRuntimeMetadata();
      console.log(`Daemon pid ${state.pid} was already gone; cleaned up runtime metadata.`);
      return;
    }
    throw error;
  }

  const stopped = await waitForProcessExit(state.pid, stopTimeoutMs);
  if (!stopped) {
    console.error(`Daemon pid ${state.pid} did not exit within ${stopTimeoutMs / 1000}s.`);
    console.error("No force kill was sent. Inspect the process or log before retrying.");
    console.error(`Log: ${displayPath(logPath)}`);
    process.exitCode = 1;
    return;
  }

  await cleanupRuntimeMetadata();
  console.log("Agent platform daemon stopped.");
}

async function printDaemonStatus() {
  const state = await readDaemonState();
  const port = configuredPort(state.meta?.port);
  const status = await fetchDaemonStatus(port);

  if (state.pid === null) {
    if (status.ok) {
      printRunning(status.body, null, "Agent platform API is reachable, but no daemon pid file exists.");
      process.exitCode = 1;
      return;
    }

    if (state.meta) {
      await cleanupRuntimeMetadata();
      console.log("Removed stale daemon metadata without a pid file.");
    }
    console.log("Agent platform daemon is not running.");
    process.exitCode = 1;
    return;
  }

  const pidAlive = isProcessAlive(state.pid);
  if (pidAlive && status.ok && Number(status.body.pid) === state.pid) {
    printRunning(status.body, state.meta, "Agent platform daemon is running.");
    return;
  }

  if (!pidAlive) {
    console.log(`Stale daemon pid found: ${state.pid} is no longer running.`);
    await cleanupRuntimeMetadata();
    console.log(`Removed ${displayPath(pidPath)} and ${displayPath(metaPath)}.`);
    process.exitCode = 1;
    return;
  }

  if (status.ok) {
    console.log(
      `Stale daemon pid found: ${displayPath(pidPath)} records pid ${state.pid}, but /api/status reports pid ${status.body.pid}.`
    );
    await cleanupRuntimeMetadata();
    console.log(`Removed ${displayPath(pidPath)} and ${displayPath(metaPath)}.`);
    process.exitCode = 1;
    return;
  }

  console.log(`Recorded daemon pid ${state.pid} is alive, but ${daemonUrl(port)}/api/status is not reachable.`);
  console.log(`Status error: ${status.error}`);
  console.log(`Log: ${displayPath(logPath)}`);
  process.exitCode = 1;
}

async function readDaemonState() {
  const [pid, meta] = await Promise.all([readPid(), readMeta()]);
  return { pid, meta };
}

async function readPid() {
  try {
    const value = await readFile(pidPath, "utf8");
    const pid = Number.parseInt(value.trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch (error) {
    if (isSystemError(error) && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function readMeta() {
  try {
    const value = await readFile(metaPath, "utf8");
    return JSON.parse(value);
  } catch (error) {
    if (isSystemError(error) && error.code === "ENOENT") {
      return null;
    }
    if (error instanceof SyntaxError) {
      return null;
    }
    throw error;
  }
}

async function fetchDaemonStatus(port, timeoutMs = 1_000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  timeout.unref?.();

  try {
    const response = await fetch(`${daemonUrl(port)}/api/status`, {
      headers: { Accept: "application/json" },
      signal: controller.signal
    });

    if (!response.ok) {
      return { ok: false, error: `${response.status} ${response.statusText}` };
    }

    const body = await response.json();
    return { ok: true, body };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timeout);
  }
}

async function waitForDaemonStatus(port, expectedPid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = { ok: false, error: "not checked yet" };

  while (Date.now() < deadline) {
    lastStatus = await fetchDaemonStatus(port, 1_000);
    if (lastStatus.ok && Number(lastStatus.body.pid) === expectedPid) {
      return lastStatus;
    }
    if (!isProcessAlive(expectedPid)) {
      return lastStatus;
    }
    await delay(pollIntervalMs);
  }

  if (lastStatus.ok) {
    return {
      ok: false,
      error: `/api/status responded with pid ${lastStatus.body.pid}, expected ${expectedPid}`
    };
  }
  return lastStatus;
}

async function waitForProcessExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) {
      return true;
    }
    await delay(pollIntervalMs);
  }
  return !isProcessAlive(pid);
}

function printRunning(status, meta, heading) {
  const port = parsePort(status.port, configuredPort(meta?.port));
  console.log(heading);
  console.log(`  pid: ${status.pid}`);
  console.log(`  url: ${daemonUrl(port)}`);
  console.log(`  startedAt: ${status.startedAt ?? meta?.startedAt ?? "unknown"}`);
  console.log(`  uptimeSeconds: ${status.uptimeSeconds ?? "unknown"}`);
  console.log(`  dbPath: ${status.dbPath ?? meta?.dbPath ?? "unknown"}`);
  console.log(`  log: ${meta?.logPath ?? displayPath(logPath)}`);
}

async function ensureRuntimeDirs() {
  await mkdir(logsDir, { recursive: true });
}

async function cleanupRuntimeMetadata() {
  await Promise.all([
    rm(pidPath, { force: true }),
    rm(metaPath, { force: true })
  ]);
}

async function resolveTsxBin() {
  const bin = join(projectRoot, "node_modules", ".bin", process.platform === "win32" ? "tsx.cmd" : "tsx");
  try {
    await access(bin, constants.X_OK);
    return bin;
  } catch {
    throw new Error(`Cannot execute ${displayPath(bin)}. Run 'npm install' before starting the daemon.`);
  }
}

function configuredPort(metaPort) {
  return parsePort(process.env.PORT, parsePort(metaPort, defaultPort));
}

function parsePort(value, fallback) {
  const parsed = typeof value === "number" ? value : Number.parseInt(value ?? "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function daemonUrl(port) {
  return `http://127.0.0.1:${port}`;
}

function resolveDbPath(value) {
  const configuredPath = value?.trim();
  return configuredPath ? resolve(projectRoot, configuredPath) : resolve(projectRoot, "data", "app.db");
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isSystemError(error) && error.code === "EPERM";
  }
}

function displayPath(path) {
  const display = relative(projectRoot, path);
  return display.startsWith("..") ? path : display || ".";
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function isSystemError(error) {
  return typeof error === "object" && error !== null && "code" in error;
}

function printHelp() {
  console.log(`Agent platform local daemon

Usage:
  npm run start    Start the local daemon in the background
  npm run status   Check pid file and GET /api/status
  npm run stop     Send SIGTERM and clean daemon pid/metadata after exit

Runtime files:
  ${displayPath(pidPath)}
  ${displayPath(metaPath)}
  ${displayPath(logPath)}
`);
}
