import { randomUUID } from "node:crypto";
import type { OpenAIChatGPTAuthPollResponse, OpenAIChatGPTAuthStartResponse } from "../shared/types";
import {
  defaultOpenAIChatGPTEndpoint,
  defaultOpenAIChatGPTIssuer,
  openAIChatGPTProfileId,
  type OpenAIChatGPTCredential,
  type OpenAIChatGPTCredentialStore
} from "./openai-chatgpt-credentials";

const defaultClientId = "app_EMoamEEZ73f0CkXaXp7hrann";
const defaultAttemptTtlMs = 10 * 60 * 1000;
const defaultPollIntervalSeconds = 5;
const pollingSafetyMarginMs = 3_000;

interface DeviceAuthAttempt {
  attemptId: string;
  deviceAuthId: string;
  userCode: string;
  intervalSeconds: number;
  expiresAtMs: number;
}

interface DeviceAuthStartBody {
  device_auth_id?: unknown;
  user_code?: unknown;
  interval?: unknown;
  expires_in?: unknown;
}

interface DeviceAuthTokenBody {
  authorization_code?: unknown;
  code_verifier?: unknown;
}

interface OpenAIChatGPTTokenResponse {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  id_token?: unknown;
  scope?: unknown;
  token_type?: unknown;
}

interface OpenAIChatGPTAuthServiceOptions {
  credentialStore: OpenAIChatGPTCredentialStore;
  issuer?: string;
  clientId?: string;
  endpoint?: string;
  userAgent?: string;
}

export class OpenAIChatGPTAuthService {
  private readonly credentialStore: OpenAIChatGPTCredentialStore;
  private readonly issuer: string;
  private readonly clientId: string;
  private readonly endpoint: string;
  private readonly userAgent: string;
  private readonly attempts = new Map<string, DeviceAuthAttempt>();

  constructor(options: OpenAIChatGPTAuthServiceOptions) {
    this.credentialStore = options.credentialStore;
    this.issuer = stripTrailingSlash(options.issuer?.trim() || defaultOpenAIChatGPTIssuer);
    this.clientId = options.clientId?.trim() || defaultClientId;
    this.endpoint = options.endpoint?.trim() || defaultOpenAIChatGPTEndpoint;
    this.userAgent = options.userAgent?.trim() || "agent-platform-prototype/0.0.0";
  }

  async startDeviceAuth(): Promise<OpenAIChatGPTAuthStartResponse> {
    this.deleteExpiredAttempts();

    const response = await fetch(`${this.issuer}/api/accounts/deviceauth/usercode`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": this.userAgent
      },
      body: JSON.stringify({ client_id: this.clientId })
    });

    if (!response.ok) {
      throw new Error(`OpenAI ChatGPT device authorization start failed (${response.status}): ${await responseText(response)}`);
    }

    const body = (await response.json()) as DeviceAuthStartBody;
    const deviceAuthId = requiredString(body.device_auth_id, "device_auth_id");
    const userCode = requiredString(body.user_code, "user_code");
    const intervalSeconds = positiveInteger(body.interval, defaultPollIntervalSeconds);
    const ttlMs = positiveInteger(body.expires_in, defaultAttemptTtlMs / 1000) * 1000;
    const attemptId = randomUUID();
    const expiresAtMs = Date.now() + ttlMs;

    this.attempts.set(attemptId, {
      attemptId,
      deviceAuthId,
      userCode,
      intervalSeconds,
      expiresAtMs
    });

    return {
      providerProfileId: openAIChatGPTProfileId,
      method: "device",
      attemptId,
      verificationUrl: `${this.issuer}/codex/device`,
      userCode,
      instruction: `Open the verification URL and enter code ${userCode}.`,
      intervalSeconds,
      expiresAt: new Date(expiresAtMs).toISOString()
    };
  }

  async pollDeviceAuth(attemptId: string): Promise<OpenAIChatGPTAuthPollResponse> {
    this.deleteExpiredAttempts();

    const attempt = this.attempts.get(attemptId);
    if (!attempt) {
      return {
        providerProfileId: openAIChatGPTProfileId,
        status: "expired",
        message: "No pending OpenAI ChatGPT auth attempt was found. Start a new connection flow."
      };
    }

    const response = await fetch(`${this.issuer}/api/accounts/deviceauth/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": this.userAgent
      },
      body: JSON.stringify({
        device_auth_id: attempt.deviceAuthId,
        user_code: attempt.userCode
      })
    });

    if (response.status === 403 || response.status === 404) {
      return {
        providerProfileId: openAIChatGPTProfileId,
        status: "pending",
        message: "Authorization is still pending in the browser/device page.",
        retryAfterMs: attempt.intervalSeconds * 1000 + pollingSafetyMarginMs
      };
    }

    if (!response.ok) {
      return {
        providerProfileId: openAIChatGPTProfileId,
        status: "failed",
        message: `Device authorization polling failed (${response.status}): ${await responseText(response)}`
      };
    }

    const body = (await response.json()) as DeviceAuthTokenBody;
    const authorizationCode = requiredString(body.authorization_code, "authorization_code");
    const codeVerifier = requiredString(body.code_verifier, "code_verifier");
    const tokens = await exchangeAuthorizationCode({
      issuer: this.issuer,
      clientId: this.clientId,
      authorizationCode,
      codeVerifier
    });

    const credential = credentialFromTokenResponse(tokens, {
      issuer: this.issuer,
      endpoint: this.endpoint
    });
    await this.credentialStore.write(credential);
    this.attempts.delete(attemptId);

    return {
      providerProfileId: openAIChatGPTProfileId,
      status: "connected",
      message: "OpenAI ChatGPT OAuth credential was saved to the local runtime credential store."
    };
  }

  async logout(): Promise<void> {
    this.attempts.clear();
    await this.credentialStore.remove();
  }

  private deleteExpiredAttempts(): void {
    const now = Date.now();
    for (const [attemptId, attempt] of this.attempts) {
      if (attempt.expiresAtMs <= now) {
        this.attempts.delete(attemptId);
      }
    }
  }
}

export interface RefreshOpenAIChatGPTCredentialOptions {
  issuer?: string;
  clientId?: string;
  endpoint?: string;
}

export async function refreshOpenAIChatGPTCredential(
  credential: OpenAIChatGPTCredential,
  options: RefreshOpenAIChatGPTCredentialOptions = {}
): Promise<OpenAIChatGPTCredential> {
  const issuer = stripTrailingSlash(options.issuer?.trim() || credential.issuer || defaultOpenAIChatGPTIssuer);
  const clientId = options.clientId?.trim() || defaultClientId;
  const response = await fetch(`${issuer}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: credential.refresh,
      client_id: clientId
    }).toString()
  });

  if (!response.ok) {
    throw new Error(`OpenAI ChatGPT token refresh failed (${response.status}): ${await responseText(response)}`);
  }

  const tokens = (await response.json()) as OpenAIChatGPTTokenResponse;
  return credentialFromTokenResponse(tokens, {
    issuer,
    endpoint: options.endpoint?.trim() || credential.endpoint,
    fallbackRefresh: credential.refresh,
    fallbackAccountId: credential.accountId
  });
}

async function exchangeAuthorizationCode(input: {
  issuer: string;
  clientId: string;
  authorizationCode: string;
  codeVerifier: string;
}): Promise<OpenAIChatGPTTokenResponse> {
  const response = await fetch(`${input.issuer}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: input.authorizationCode,
      redirect_uri: `${input.issuer}/deviceauth/callback`,
      client_id: input.clientId,
      code_verifier: input.codeVerifier
    }).toString()
  });

  if (!response.ok) {
    throw new Error(`OpenAI ChatGPT token exchange failed (${response.status}): ${await responseText(response)}`);
  }

  return (await response.json()) as OpenAIChatGPTTokenResponse;
}

function credentialFromTokenResponse(
  tokens: OpenAIChatGPTTokenResponse,
  options: { issuer: string; endpoint?: string; fallbackRefresh?: string; fallbackAccountId?: string }
): OpenAIChatGPTCredential {
  const access = requiredString(tokens.access_token, "access_token");
  const refresh = typeof tokens.refresh_token === "string" && tokens.refresh_token.trim() ? tokens.refresh_token : options.fallbackRefresh;
  if (!refresh) {
    throw new Error("OpenAI ChatGPT token response did not include a refresh token.");
  }

  const expiresInSeconds = positiveInteger(tokens.expires_in, 3600);
  const accountId = extractAccountId(tokens) || options.fallbackAccountId;

  return {
    type: "oauth",
    access,
    refresh,
    expiresAt: Date.now() + expiresInSeconds * 1000,
    updatedAt: new Date().toISOString(),
    ...(accountId ? { accountId } : {}),
    ...(typeof tokens.scope === "string" && tokens.scope.trim() ? { scope: tokens.scope } : {}),
    ...(typeof tokens.token_type === "string" && tokens.token_type.trim() ? { tokenType: tokens.token_type } : {}),
    issuer: options.issuer,
    ...(options.endpoint ? { endpoint: options.endpoint } : {})
  };
}

function extractAccountId(tokens: OpenAIChatGPTTokenResponse): string | undefined {
  const idTokenClaims = typeof tokens.id_token === "string" ? parseJwtClaims(tokens.id_token) : undefined;
  const accessTokenClaims = typeof tokens.access_token === "string" ? parseJwtClaims(tokens.access_token) : undefined;
  return accountIdFromClaims(idTokenClaims) ?? accountIdFromClaims(accessTokenClaims);
}

function parseJwtClaims(token: string): Record<string, unknown> | undefined {
  const [, payload] = token.split(".");
  if (!payload) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as unknown;
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function accountIdFromClaims(claims: Record<string, unknown> | undefined): string | undefined {
  if (!claims) {
    return undefined;
  }

  if (typeof claims.chatgpt_account_id === "string" && claims.chatgpt_account_id.trim()) {
    return claims.chatgpt_account_id;
  }

  const nestedAuth = claims["https://api.openai.com/auth"];
  if (isRecord(nestedAuth) && typeof nestedAuth.chatgpt_account_id === "string" && nestedAuth.chatgpt_account_id.trim()) {
    return nestedAuth.chatgpt_account_id;
  }

  const organizations = claims.organizations;
  if (Array.isArray(organizations)) {
    const first = organizations.find(isRecord);
    if (first && typeof first.id === "string" && first.id.trim()) {
      return first.id;
    }
  }

  return undefined;
}

async function responseText(response: Response): Promise<string> {
  const body = await response.text().catch(() => "");
  const trimmed = redactSensitiveText(body.trim());
  return trimmed.length > 500 ? `${trimmed.slice(0, 500)}…` : trimmed || response.statusText;
}

function redactSensitiveText(value: string): string {
  return value
    .replace(/(Authorization\s*[:=]\s*Bearer\s+)[^\s"']+/gi, "$1[REDACTED]")
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi, "$1[REDACTED]")
    .replace(/("(?:access|refresh|id)_?token"\s*:\s*")[^"]+(")/gi, "$1[REDACTED]$2")
    .replace(/("(?:access|refresh|id)"\s*:\s*")[^"]+(")/gi, "$1[REDACTED]$2")
    .replace(/("(?:accountId|account_id|chatgpt_account_id|email)"\s*:\s*")[^"]+(")/gi, "$1[REDACTED]$2")
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, "[REDACTED_API_KEY]")
    .replace(/\b[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[REDACTED_JWT]");
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`OpenAI ChatGPT response field '${field}' is missing or invalid.`);
  }
  return value;
}

function positiveInteger(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number.parseInt(value, 10) : NaN;
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
