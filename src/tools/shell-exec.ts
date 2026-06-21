import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { defaultShellToolSettings, normalizeShellToolSettings } from "../shared/tool-settings";
import type { JsonObject, ShellExecOutput, ShellToolSettings } from "../shared/types";
import type { RegisteredTool, ToolExecutionContext, ToolInputValidationContext } from "./types";
import { ToolInputError } from "./types";

export const shellExecToolId = "shell.exec";
const maxEventDeltaChars = 8_000;

export interface ShellExecToolOptions {
  env?: NodeJS.ProcessEnv;
  getShellSettings?: () => ShellToolSettings;
}

interface NormalizedShellExecInput {
  command: string;
  cwd: string;
  timeoutMs: number;
}

type OutputStream = "stdout" | "stderr";

type TextRedactor = (text: string) => string;

export function createShellExecTool(optionsOrEnv?: ShellExecToolOptions | NodeJS.ProcessEnv): RegisteredTool {
  const options = optionsOrEnv === undefined ? {} : isShellExecToolOptions(optionsOrEnv) ? optionsOrEnv : { env: optionsOrEnv };
  const env = options.env ?? process.env;
  const getShellSettings = () => normalizeShellToolSettings(options.getShellSettings?.() ?? defaultShellToolSettings);
  const redact = createSensitiveTextRedactor(env);
  return {
    definition: {
      id: shellExecToolId,
      name: "Shell Exec",
      description: "Execute a local shell command manually and record stdout/stderr as structured tool output.",
      source: "builtin",
      inputSchema: shellExecInputSchema(),
      outputSchema: shellExecOutputSchema(),
      metadata: {
        cwdPolicy: "execution-context-home-default",
        shell: true,
        permissionHook: "allow-ask-deny-policy",
        warning:
          "Runs real local shell commands. cwd defaults to the runtime execution context (currently the user's home directory). Manual invocations pass through the user-edited Tool Settings permission policy first."
      }
    },
    executor: {
      validateInput(input, context) {
        return shellExecInputToJson(validateShellExecInput(input, context, getShellSettings()));
      },
      toPublicInput(input, context) {
        const normalized = validateShellExecInput(input, context, getShellSettings());
        return shellExecInputToJson({ ...normalized, command: redact(normalized.command) });
      },
      execute(input, context) {
        const shellSettings = getShellSettings();
        const normalized = validateShellExecInput(input, context, shellSettings);
        return executeShellExec(normalized, context, redact, shellSettings.maxOutputChars);
      }
    }
  };
}

function isShellExecToolOptions(value: ShellExecToolOptions | NodeJS.ProcessEnv): value is ShellExecToolOptions {
  return "env" in value || "getShellSettings" in value;
}

function validateShellExecInput(
  input: JsonObject,
  context: ToolInputValidationContext,
  shellSettings: Required<ShellToolSettings>
): NormalizedShellExecInput {
  const command = typeof input.command === "string" ? input.command.trim() : "";
  if (!command) {
    throw new ToolInputError("shell.exec requires a non-empty 'command' string.");
  }
  if (command.length > 20_000) {
    throw new ToolInputError("shell.exec command must be 20000 characters or fewer.");
  }

  const cwdValue = input.cwd;
  if (cwdValue !== undefined && cwdValue !== null && typeof cwdValue !== "string") {
    throw new ToolInputError("shell.exec field 'cwd' must be a string when provided.");
  }

  const timeoutMs = parseTimeoutMs(input.timeoutMs, shellSettings);
  return {
    command,
    cwd: resolveExecutionCwd(context.cwd, typeof cwdValue === "string" ? cwdValue : undefined),
    timeoutMs
  };
}

function parseTimeoutMs(value: unknown, shellSettings: Required<ShellToolSettings>): number {
  if (value === undefined || value === null || value === "") {
    return shellSettings.defaultTimeoutMs;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) {
    throw new ToolInputError("shell.exec field 'timeoutMs' must be an integer number of milliseconds.");
  }
  if (value <= 0) {
    throw new ToolInputError("shell.exec field 'timeoutMs' must be greater than 0.");
  }
  if (value > shellSettings.maxTimeoutMs) {
    throw new ToolInputError(`shell.exec field 'timeoutMs' must be ${shellSettings.maxTimeoutMs}ms or less by Tool Settings shell.maxTimeoutMs.`);
  }
  return value;
}

function resolveExecutionCwd(defaultCwd: string, cwd: string | undefined): string {
  const root = resolve(defaultCwd);
  const cwdText = cwd?.trim();
  const resolvedCwd = cwdText ? (isAbsolute(cwdText) ? resolve(cwdText) : resolve(root, cwdText)) : root;
  assertExistingDirectory(resolvedCwd);
  return resolvedCwd;
}

function assertExistingDirectory(cwd: string): void {
  let stat;
  try {
    stat = statSync(cwd);
  } catch {
    throw new ToolInputError(`shell.exec cwd does not exist: ${cwd}`);
  }
  if (!stat.isDirectory()) {
    throw new ToolInputError(`shell.exec cwd is not a directory: ${cwd}`);
  }
}

async function executeShellExec(
  input: NormalizedShellExecInput,
  context: ToolExecutionContext,
  redact: TextRedactor,
  maxOutputChars: number
): Promise<JsonObject> {
  const startedAtMs = Date.now();
  const stdout = createOutputLimiter("stdout", maxOutputChars, redact);
  const stderr = createOutputLimiter("stderr", maxOutputChars, redact);
  let timedOut = false;
  let closed = false;
  let exitCode: number | null = null;

  const child = spawn(input.command, {
    cwd: input.cwd,
    shell: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
    windowsHide: true
  });

  const abort = () => {
    if (!closed) {
      child.kill("SIGTERM");
    }
  };
  context.signal.addEventListener("abort", abort, { once: true });

  let forceKillTimeout: ReturnType<typeof setTimeout> | null = null;

  const timeout = setTimeout(() => {
    timedOut = true;
    abort();
    forceKillTimeout = setTimeout(() => {
      if (!closed) {
        child.kill("SIGKILL");
      }
    }, 1_000);
    forceKillTimeout.unref();
  }, input.timeoutMs);
  timeout.unref();

  const onData = (stream: OutputStream, chunk: Buffer | string): void => {
    const limiter = stream === "stdout" ? stdout : stderr;
    const appended = limiter.append(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk);
    if (!appended) {
      return;
    }

    for (const delta of splitDelta(appended, maxEventDeltaChars)) {
      void context.emit({
        invocationId: context.invocation.id,
        toolId: shellExecToolId,
        type: stream === "stdout" ? "tool.stdout.delta" : "tool.stderr.delta",
        createdAt: new Date().toISOString(),
        payload: {
          callId: context.invocation.id,
          stream,
          text: delta
        }
      });
    }
  };

  child.stdout?.on("data", (chunk: Buffer) => onData("stdout", chunk));
  child.stderr?.on("data", (chunk: Buffer) => onData("stderr", chunk));

  try {
    await new Promise<void>((resolvePromise, rejectPromise) => {
      child.once("error", rejectPromise);
      child.once("close", (code) => {
        closed = true;
        exitCode = code;
        resolvePromise();
      });
    });
  } finally {
    clearTimeout(timeout);
    if (forceKillTimeout) {
      clearTimeout(forceKillTimeout);
    }
    context.signal.removeEventListener("abort", abort);
  }

  const durationMs = Date.now() - startedAtMs;
  const output: ShellExecOutput = {
    command: redact(input.command),
    cwd: input.cwd,
    exitCode,
    stdout: stdout.text,
    stderr: stderr.text,
    durationMs,
    timedOut,
    stdoutTruncated: stdout.truncated,
    stderrTruncated: stderr.truncated
  };
  return output;
}

function shellExecInputToJson(input: NormalizedShellExecInput): JsonObject {
  return {
    command: input.command,
    cwd: input.cwd,
    timeoutMs: input.timeoutMs
  };
}

function createOutputLimiter(stream: OutputStream, maxChars: number, redact: TextRedactor): { text: string; truncated: boolean; append(raw: string): string } {
  return {
    text: "",
    truncated: false,
    append(raw: string): string {
      if (this.truncated || raw.length === 0) {
        return "";
      }

      const next = redact(raw);
      const remaining = maxChars - this.text.length;
      if (next.length <= remaining) {
        this.text += next;
        return next;
      }

      const marker = `\n[${stream} output truncated after ${maxChars} characters]\n`;
      const sliceLength = Math.max(0, remaining - marker.length);
      const appended = `${next.slice(0, sliceLength)}${marker.slice(0, remaining - sliceLength)}`;
      this.text += appended;
      this.truncated = true;
      return appended;
    }
  };
}

function splitDelta(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) {
    return [text];
  }

  const chunks: string[] = [];
  for (let index = 0; index < text.length; index += maxChars) {
    chunks.push(text.slice(index, index + maxChars));
  }
  return chunks;
}

function createSensitiveTextRedactor(env: NodeJS.ProcessEnv): TextRedactor {
  const sensitiveValues = Object.entries(env)
    .filter(([key, value]) => isSensitiveName(key) && typeof value === "string" && value.length >= 8)
    .map(([, value]) => value as string)
    .sort((a, b) => b.length - a.length);

  return (text: string): string => {
    let output = text;
    for (const value of sensitiveValues) {
      output = output.split(value).join("[REDACTED]");
    }
    return output.replace(
      /((?:authorization|cookie|token|secret|api[_-]?key|credential|password|refresh|access)(?:[_-]?\w*)?\s*[:=]\s*)(["']?)[^\s"'`]+/gi,
      "$1$2[REDACTED]"
    );
  };
}

function isSensitiveName(name: string): boolean {
  return /authorization|cookie|token|secret|api[_-]?key|credential|password|refresh|access/i.test(name);
}

function shellExecInputSchema(): JsonObject {
  return {
    type: "object",
    additionalProperties: false,
    required: ["command"],
    properties: {
      command: { type: "string", minLength: 1, description: "Shell command string executed through the local shell." },
      cwd: {
        type: "string",
        description:
          "Optional working directory. Defaults to the runtime execution cwd (currently the user's home directory). Relative values resolve from that default; absolute values are used as-is."
      },
      timeoutMs: {
        type: "integer",
        minimum: 1,
        description:
          "Optional timeout in milliseconds. Omit to use Tool Settings shell.defaultTimeoutMs; values must not exceed Tool Settings shell.maxTimeoutMs."
      }
    }
  };
}

function shellExecOutputSchema(): JsonObject {
  return {
    type: "object",
    required: ["exitCode", "stdout", "stderr", "durationMs", "timedOut"],
    properties: {
      exitCode: { type: ["integer", "null"] },
      stdout: { type: "string" },
      stderr: { type: "string" },
      durationMs: { type: "integer" },
      timedOut: { type: "boolean" },
      stdoutTruncated: { type: "boolean" },
      stderrTruncated: { type: "boolean" }
    }
  };
}
