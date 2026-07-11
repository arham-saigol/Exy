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

interface DiscordRole {
  id?: string;
  permissions?: string;
}

interface DiscordOverwrite {
  id?: string;
  type?: number;
  allow?: string;
  deny?: string;
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

function asPermission(value: unknown): bigint {
  if (typeof value !== "string" || !/^\d+$/u.test(value)) return 0n;
  return BigInt(value);
}

function effectiveChannelPermissions(
  guildId: string,
  botId: string,
  memberRoleIds: readonly string[],
  roles: readonly DiscordRole[],
  overwrites: readonly DiscordOverwrite[],
): bigint {
  let permissions = asPermission(roles.find((role) => role.id === guildId)?.permissions);
  for (const role of roles) {
    if (role.id && memberRoleIds.includes(role.id)) permissions |= asPermission(role.permissions);
  }
  if ((permissions & (1n << 3n)) !== 0n) return (1n << 53n) - 1n;

  const apply = (deny: bigint, allow: bigint) => {
    permissions = (permissions & ~deny) | allow;
  };
  const everyone = overwrites.find((overwrite) => overwrite.type === 0 && overwrite.id === guildId);
  if (everyone) apply(asPermission(everyone.deny), asPermission(everyone.allow));

  let roleDeny = 0n;
  let roleAllow = 0n;
  for (const overwrite of overwrites) {
    if (overwrite.type === 0 && overwrite.id && memberRoleIds.includes(overwrite.id)) {
      roleDeny |= asPermission(overwrite.deny);
      roleAllow |= asPermission(overwrite.allow);
    }
  }
  apply(roleDeny, roleAllow);
  const member = overwrites.find((overwrite) => overwrite.type === 1 && overwrite.id === botId);
  if (member) apply(asPermission(member.deny), asPermission(member.allow));
  return permissions;
}

export async function checkDiscordScope(config: ExyConfig, secrets: ExySecrets): Promise<CheckResult> {
  const token = secrets.discordBotToken;
  try {
    const bot = await discordJson("https://discord.com/api/v10/users/@me", token) as { id?: unknown };
    if (typeof bot.id !== "string") throw new Error("Discord did not return the bot identity");
    const [guild, channel, member, roles] = await Promise.all([
      discordJson(`https://discord.com/api/v10/guilds/${config.discord.guildId}`, token),
      discordJson(`https://discord.com/api/v10/channels/${config.discord.parentChannelId}`, token),
      discordJson(`https://discord.com/api/v10/guilds/${config.discord.guildId}/members/${bot.id}`, token),
      discordJson(`https://discord.com/api/v10/guilds/${config.discord.guildId}/roles`, token),
    ]);
    if (!guild || typeof guild !== "object") throw new Error("Configured Discord guild is unavailable");
    if (!channel || typeof channel !== "object") throw new Error("Configured Discord parent channel is unavailable");
    const channelRecord = channel as { guild_id?: unknown; type?: unknown; permission_overwrites?: unknown };
    if (channelRecord.guild_id !== config.discord.guildId) throw new Error("Configured channel does not belong to the configured guild");
    if (channelRecord.type !== 0 && channelRecord.type !== 5) throw new Error("Configured parent channel must be a guild text or announcement channel");
    const memberRoles = Array.isArray((member as { roles?: unknown }).roles)
      ? (member as { roles: unknown[] }).roles.filter((value): value is string => typeof value === "string")
      : [];
    const roleList = Array.isArray(roles) ? roles as DiscordRole[] : [];
    const overwrites = Array.isArray(channelRecord.permission_overwrites)
      ? channelRecord.permission_overwrites as DiscordOverwrite[]
      : [];
    const permissions = effectiveChannelPermissions(config.discord.guildId, bot.id, memberRoles, roleList, overwrites);
    const required = [
      ["View Channel", 1n << 10n],
      ["Send Messages", 1n << 11n],
      ["Read Message History", 1n << 16n],
      ["Create Public Threads", 1n << 35n],
      ["Send Messages in Threads", 1n << 38n],
    ] as const;
    const missing = required.filter(([, bit]) => (permissions & bit) === 0n).map(([name]) => name);
    return missing.length === 0
      ? { name: "Discord guild/channel permissions", ok: true, detail: "configured scope is accessible" }
      : { name: "Discord guild/channel permissions", ok: false, detail: `missing: ${missing.join(", ")}` };
  } catch (error) {
    return { name: "Discord guild/channel permissions", ok: false, detail: sanitizeDiagnostic(error, [token]) };
  }
}

export async function checkDiscordAuthorizedUser(config: ExyConfig, secrets: ExySecrets): Promise<CheckResult> {
  const token = secrets.discordBotToken;
  try {
    const user = await discordJson(`https://discord.com/api/v10/users/${config.discord.authorizedUserId}`, token) as { id?: unknown };
    if (user.id !== config.discord.authorizedUserId) throw new Error("Discord did not return the configured authorized user");
    try {
      await discordJson(
        `https://discord.com/api/v10/guilds/${config.discord.guildId}/members/${config.discord.authorizedUserId}`,
        token,
      );
      return { name: "Discord authorized user", ok: true, detail: "user identity and guild membership verified" };
    } catch (error) {
      const detail = sanitizeDiagnostic(error, [token]);
      if (/HTTP 403:/u.test(detail)) {
        return {
          name: "Discord authorized user",
          ok: true,
          detail: "user identity exists; guild membership could not be queried without Discord's Server Members Intent",
        };
      }
      throw error;
    }
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
    checkDiscordScope(config, secrets),
    checkDiscordAuthorizedUser(config, secrets),
    checkSupermemory(secrets),
    checkXquik(secrets),
    checkZernio(config, secrets),
    checkExa(secrets),
  ]);
}
