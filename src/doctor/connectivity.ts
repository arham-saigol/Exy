import type { ExyConfig, ExySecrets } from "../core/types.js";
import { sanitizeDiagnostic } from "../core/errors.js";

export interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

async function jsonRequest(
  name: string,
  url: string,
  init: RequestInit,
  validate: (body: unknown) => boolean = () => true,
  secrets: readonly string[] = [],
): Promise<CheckResult> {
  try {
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
    const body = await response.json().catch(() => undefined) as { error?: unknown; message?: unknown } | undefined;
    if (!response.ok) {
      const message = typeof body?.error === "string" ? body.error : typeof body?.message === "string" ? body.message : response.statusText;
      return { name, ok: false, detail: `HTTP ${response.status}: ${sanitizeDiagnostic(message || "request failed", secrets)}` };
    }
    return validate(body)
      ? { name, ok: true, detail: "connected" }
      : { name, ok: false, detail: "provider returned an unexpected response" };
  } catch (error) {
    return { name, ok: false, detail: sanitizeDiagnostic(error, secrets) };
  }
}

export async function checkDiscord(secrets: ExySecrets): Promise<CheckResult> {
  return jsonRequest(
    "Discord",
    "https://discord.com/api/v10/users/@me",
    { headers: { Authorization: `Bot ${secrets.discordBotToken}` } },
    (body) => Boolean(body && typeof body === "object" && "id" in body),
    [secrets.discordBotToken],
  );
}

export async function checkDiscordIntent(config: ExyConfig, secrets: ExySecrets): Promise<CheckResult> {
  const result = await jsonRequest(
    "Discord Message Content intent",
    "https://discord.com/api/v10/oauth2/applications/@me",
    { headers: { Authorization: `Bot ${secrets.discordBotToken}` } },
    (body) => {
      if (!body || typeof body !== "object") return false;
      if ((body as { id?: unknown }).id !== config.discord.applicationId) return false;
      const flags = Number((body as { flags?: unknown }).flags ?? 0);
      const gatewayMessageContent = 1 << 18;
      const gatewayMessageContentLimited = 1 << 19;
      return (flags & (gatewayMessageContent | gatewayMessageContentLimited)) !== 0;
    },
    [secrets.discordBotToken],
  );
  if (!result.ok && result.detail === "provider returned an unexpected response") {
    result.detail = "enable Message Content Intent in the Discord Developer Portal";
  }
  return result;
}

async function discordJson(url: string, token: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: { Authorization: `Bot ${token}` },
    signal: AbortSignal.timeout(15_000),
  });
  const body = await response.json().catch(() => undefined) as { error?: unknown; message?: unknown } | undefined;
  if (!response.ok) {
    const message = typeof body?.message === "string" ? body.message : typeof body?.error === "string" ? body.error : response.statusText;
    throw new Error(`HTTP ${response.status}: ${sanitizeDiagnostic(message || "request failed", [token])}`);
  }
  return body;
}

export async function checkDiscordAuthorizedUser(config: ExyConfig, secrets: ExySecrets): Promise<CheckResult> {
  const token = secrets.discordBotToken;
  try {
    const user = await discordJson(`https://discord.com/api/v10/users/${config.discord.authorizedUserId}`, token) as { id?: unknown };
    if (user.id !== config.discord.authorizedUserId) throw new Error("Discord did not return the configured authorized user");
    return { name: "Discord authorized user", ok: true, detail: "user identity verified" };
  } catch (error) {
    return { name: "Discord authorized user", ok: false, detail: sanitizeDiagnostic(error, [token]) };
  }
}

export async function checkSupermemory(secrets: ExySecrets): Promise<CheckResult> {
  return jsonRequest("Supermemory", "https://api.supermemory.ai/v4/search", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secrets.supermemoryApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      q: "Exy connectivity check",
      containerTag: "exy:connectivity",
      searchMode: "memories",
      limit: 2,
    }),
  }, undefined, [secrets.supermemoryApiKey]);
}

export async function checkXquik(secrets: ExySecrets): Promise<CheckResult> {
  return jsonRequest("Xquik", "https://xquik.com/api/v1/account", {
    headers: { "x-api-key": secrets.xquikApiKey },
  }, undefined, [secrets.xquikApiKey]);
}

export async function checkZernio(config: ExyConfig, secrets: ExySecrets): Promise<CheckResult> {
  const accountId = config.providers.zernioAccountId;
  const path = accountId
    ? `/accounts/${encodeURIComponent(accountId)}/health`
    : "/accounts/health?platform=twitter";
  return jsonRequest("Zernio", `https://zernio.com/api/v1${path}`, {
    headers: { Authorization: `Bearer ${secrets.zernioApiKey}` },
  }, (body) => zernioHealthIsUsable(body, config.providers.zernioXAnalyticsEnabled), [secrets.zernioApiKey]);
}

export function zernioHealthIsUsable(body: unknown, requireAnalytics: boolean): boolean {
  if (!body || typeof body !== "object") return false;
  const health = body as {
    status?: unknown;
    tokenStatus?: { valid?: unknown };
    permissions?: { canPost?: unknown; canFetchAnalytics?: unknown; missingRequired?: unknown };
  };
  return health.status === "healthy"
    && health.tokenStatus?.valid === true
    && health.permissions?.canPost === true
    && (!requireAnalytics || health.permissions.canFetchAnalytics === true)
    && Array.isArray(health.permissions.missingRequired)
    && health.permissions.missingRequired.length === 0;
}

export async function checkExa(secrets: ExySecrets): Promise<CheckResult> {
  return jsonRequest("Exa", "https://api.exa.ai/search", {
    method: "POST",
    headers: { "x-api-key": secrets.exaApiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ query: "Exa", type: "fast", numResults: 1 }),
  }, undefined, [secrets.exaApiKey]);
}

export async function checkAllProviders(config: ExyConfig, secrets: ExySecrets): Promise<CheckResult[]> {
  return Promise.all([
    checkDiscord(secrets),
    checkDiscordIntent(config, secrets),
    checkDiscordAuthorizedUser(config, secrets),
    checkSupermemory(secrets),
    checkXquik(secrets),
    checkZernio(config, secrets),
    checkExa(secrets),
  ]);
}
