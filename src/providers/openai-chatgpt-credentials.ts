import { readFileSync } from "node:fs";
import { chmod, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

export const openAIChatGPTProfileId = "openai-chatgpt";
export const openAIChatGPTCredentialRef = "file:openai-chatgpt";
export const defaultOpenAIChatGPTIssuer = "https://auth.openai.com";
export const defaultOpenAIChatGPTEndpoint = "https://chatgpt.com/backend-api/codex/responses";
export const defaultOpenAIChatGPTModel = "gpt-5.5";

export interface OpenAIChatGPTCredential {
  type: "oauth";
  access: string;
  refresh: string;
  expiresAt: number;
  accountId?: string;
  scope?: string;
  tokenType?: string;
  issuer?: string;
  endpoint?: string;
  updatedAt: string;
}

export type OpenAIChatGPTCredentialInspection =
  | { kind: "missing" }
  | { kind: "invalid"; message: string }
  | { kind: "present"; credential: OpenAIChatGPTCredential; expired: boolean };

export interface OpenAIChatGPTCredentialStoreOptions {
  runtimeDir?: string;
}

export class OpenAIChatGPTCredentialStore {
  readonly credentialsDir: string;
  readonly credentialPath: string;

  constructor(options: OpenAIChatGPTCredentialStoreOptions = {}) {
    const runtimeDir = options.runtimeDir?.trim() || resolve(process.cwd(), ".agent-platform");
    this.credentialsDir = join(runtimeDir, "credentials");
    this.credentialPath = join(this.credentialsDir, "openai-chatgpt.json");
  }

  async inspect(): Promise<OpenAIChatGPTCredentialInspection> {
    try {
      const raw = await readFile(this.credentialPath, "utf8");
      const parsed = parseCredential(JSON.parse(raw));
      return {
        kind: "present",
        credential: parsed,
        expired: isCredentialExpired(parsed)
      };
    } catch (error) {
      if (isSystemError(error) && error.code === "ENOENT") {
        return { kind: "missing" };
      }
      return { kind: "invalid", message: error instanceof Error ? error.message : String(error) };
    }
  }

  inspectSync(): OpenAIChatGPTCredentialInspection {
    try {
      const raw = readFileSync(this.credentialPath, "utf8");
      const parsed = parseCredential(JSON.parse(raw));
      return {
        kind: "present",
        credential: parsed,
        expired: isCredentialExpired(parsed)
      };
    } catch (error) {
      if (isSystemError(error) && error.code === "ENOENT") {
        return { kind: "missing" };
      }
      return { kind: "invalid", message: error instanceof Error ? error.message : String(error) };
    }
  }

  async read(): Promise<OpenAIChatGPTCredential | null> {
    const inspection = await this.inspect();
    return inspection.kind === "present" ? inspection.credential : null;
  }

  readSync(): OpenAIChatGPTCredential | null {
    const inspection = this.inspectSync();
    return inspection.kind === "present" ? inspection.credential : null;
  }

  async write(credential: OpenAIChatGPTCredential): Promise<void> {
    await mkdir(this.credentialsDir, { recursive: true, mode: 0o700 });
    await writeFile(this.credentialPath, `${JSON.stringify(credential, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await chmod(this.credentialPath, 0o600).catch(() => undefined);
  }

  async remove(): Promise<void> {
    try {
      await unlink(this.credentialPath);
    } catch (error) {
      if (!isSystemError(error) || error.code !== "ENOENT") {
        throw error;
      }
    }
  }
}

export function isCredentialExpired(credential: OpenAIChatGPTCredential, now = Date.now()): boolean {
  return !Number.isFinite(credential.expiresAt) || credential.expiresAt <= now;
}

function parseCredential(value: unknown): OpenAIChatGPTCredential {
  if (!isRecord(value)) {
    throw new Error("OpenAI ChatGPT credential file must contain a JSON object.");
  }

  const access = stringField(value, "access");
  const refresh = stringField(value, "refresh");
  const expiresAt = numberField(value, "expiresAt");
  const updatedAt = optionalStringField(value, "updatedAt") ?? new Date(0).toISOString();

  return {
    type: "oauth",
    access,
    refresh,
    expiresAt,
    updatedAt,
    accountId: optionalStringField(value, "accountId"),
    scope: optionalStringField(value, "scope"),
    tokenType: optionalStringField(value, "tokenType"),
    issuer: optionalStringField(value, "issuer"),
    endpoint: optionalStringField(value, "endpoint")
  };
}

function stringField(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  if (typeof field !== "string" || !field.trim()) {
    throw new Error(`OpenAI ChatGPT credential field '${key}' must be a non-empty string.`);
  }
  return field;
}

function optionalStringField(value: Record<string, unknown>, key: string): string | undefined {
  const field = value[key];
  return typeof field === "string" && field.trim() ? field : undefined;
}

function numberField(value: Record<string, unknown>, key: string): number {
  const field = value[key];
  if (typeof field !== "number" || !Number.isFinite(field)) {
    throw new Error(`OpenAI ChatGPT credential field '${key}' must be a finite number.`);
  }
  return field;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSystemError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
