import { spawn } from "node:child_process";
import { isAbsolute, relative, resolve } from "node:path";
import type { JsonObject, ShellExecOutput } from "../shared/types";
import type { RegisteredTool, ToolExecutionContext, ToolInputValidationContext } from "./types";
import { ToolInputError } from "./types";

export const shellExecToolId = "shell.exec";
export const shellExecDefaultTimeoutMs = 60_000;
export const shellExecMaxTimeoutMs = 300_000;
export const shellExecMaxOutputChars = 64_000;
const maxEventDeltaChars = 8_000;

interface NormalizedShellExecInput {
  command: string;
  cwd: string;
  timeoutMs: number;
}

type OutputStream = "stdout" | "stderr";

type TextRedactor = (text: string) => string;

export function createShellExecTool(env: NodeJS.ProcessEnv = process.env): RegisteredTool {
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
        defaultTimeoutMs: shellExecDefaultTimeoutMs,
        maxTimeoutMs: shellExecMaxTimeoutMs,
        maxOutputChars: shellExecMaxOutputChars,
        cwdPolicy: "workspace-root-subtree",
        shell: true,
        permissionHook: "manual-invocation-allowed-placeholder",
        warning: "Runs real local shell commands. Automatic model tool calls and approval policy are not enabled yet."
      }
    },
    executor: {
      validateInput(input, context) {
        return shellExecInputToJson(validateShellExecInput(input, context));
      },
      toPublicInput(input, context) {
        const normalized = validateShellExecInput(input, context);
        return shellExecInputToJson({ ...normalized, command: redact(normalized.command) });
      },
      execute(input, context) {
        return executeShellExec(validateShellExecInput(input, context), context, redact);
      }
    }
  };
}

function validateShellExecInput(input: JsonObject, context: ToolInputValidationContext): NormalizedShellExecInput {
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

  const timeoutMs = parseTimeoutMs(input.timeoutMs);
  return {
    command,
    cwd: resolveWorkspaceCwd(context.workspaceRoot, typeof cwdValue === "string" ? cwdValue : undefined),
    timeoutMs
  };
}

function parseTimeoutMs(value: unknown): number {
  if (value === undefined || value === null || value === "") {
    return shellExecDefaultTimeoutMs;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) {
    throw new ToolInputError("shell.exec field 'timeoutMs' must be an integer number of milliseconds.");
  }
  if (value <= 0) {
    throw new ToolInputError("shell.exec field 'timeoutMs' must be greater than 0.");
  }
  if (value > shellExecMaxTimeoutMs) {
    throw new ToolInputError(`shell.exec field 'timeoutMs' must be ${shellExecMaxTimeoutMs}ms or less.`);
  }
  return value;
}

function resolveWorkspaceCwd(workspaceRoot: string, cwd: string | undefined): string {
  const root = resolve(workspaceRoot);
  const cwdText = cwd?.trim();
  const resolvedCwd = cwdText ? (isAbsolute(cwdText) ? resolve(cwdText) : resolve(root, cwdText)) : root;
  if (!isInsideOrEqual(root, resolvedCwd)) {
    throw new ToolInputError("shell.exec cwd must stay inside the workspace root.");
  }
  return resolvedCwd;
}

function isInsideOrEqual(parent: string, child: string): boolean {
  const pathFromParent = relative(parent, child);
  return pathFromParent === "" || (!pathFromParent.startsWith("..") && !isAbsolute(pathFromParent));
}

async function executeShellExec(
  input: NormalizedShellExecInput,
  context: ToolExecutionContext,
  redact: TextRedactor
): Promise<JsonObject> {
  const startedAtMs = Date.now();
  const stdout = createOutputLimiter("stdout", shellExecMaxOutputChars, redact);
  const stderr = createOutputLimiter("stderr", shellExecMaxOutputChars, redact);
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
      cwd: { type: "string", description: "Optional working directory. Must resolve inside the workspace root." },
      timeoutMs: { type: "integer", minimum: 1, maximum: shellExecMaxTimeoutMs, default: shellExecDefaultTimeoutMs }
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
