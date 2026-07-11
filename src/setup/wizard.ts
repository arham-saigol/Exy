import { confirm, input, password, select } from "@inquirer/prompts";
import { ConfigStore } from "../config/store.js";
import type { ExyPaths } from "../config/paths.js";
import type { DiscordConfig, ExyConfig, ExySecrets, HeartbeatConfig } from "../core/types.js";
import { sanitizeDiagnostic } from "../core/errors.js";
import { runCommand } from "../core/process.js";
import { ensureLayout } from "./layout.js";
import { installRuntimeDependencies, installSystemdService } from "./systemd.js";

export interface ZernioAccount {
  _id: string;
  username?: string;
  displayName?: string;
  isActive?: boolean;
}

export interface ZernioAccountListing {
  accounts: ZernioAccount[];
  hasAnalyticsAccess: boolean;
}

const DISCORD_ID = /^\d{5,30}$/u;

export function heartbeatForSetup(
  previousConfig: ExyConfig | undefined,
  nextDiscord: DiscordConfig,
  nextXAccountId: string,
): HeartbeatConfig {
  const previous = previousConfig?.heartbeat ?? { enabled: false, intervalMinutes: 30 };
  if (!previousConfig) return previous;
  const scopeChanged = previousConfig.discord.applicationId !== nextDiscord.applicationId
    || previousConfig.discord.guildId !== nextDiscord.guildId
    || previousConfig.discord.parentChannelId !== nextDiscord.parentChannelId
    || previousConfig.discord.authorizedUserId !== nextDiscord.authorizedUserId
    || previousConfig.providers.zernioAccountId !== nextXAccountId;
  return scopeChanged
    ? { enabled: false, intervalMinutes: previous.intervalMinutes }
    : previous;
}

function discordId(label: string) {
  return (value: string): true | string => DISCORD_ID.test(value.trim()) ? true : `${label} must be a Discord snowflake ID`;
}

async function askSecret(label: string, existing?: string): Promise<string> {
  const value = await password({
    message: existing ? `${label} (leave blank to keep the configured value)` : label,
    mask: "*",
  });
  if (value.trim()) return value.trim();
  if (existing) return existing;
  throw new Error(`${label} is required`);
}

async function parseResponse(response: Response, provider: string, secrets: readonly string[]): Promise<unknown> {
  const body = await response.json().catch(() => undefined) as { error?: unknown; message?: unknown } | undefined;
  if (!response.ok) {
    const detail = typeof body?.error === "string" ? body.error : typeof body?.message === "string" ? body.message : response.statusText;
    throw new Error(`${provider} returned ${response.status}: ${sanitizeDiagnostic(detail || "request failed", secrets)}`);
  }
  if (body === undefined) {
    throw new Error(`${provider} returned ${response.status}: ${sanitizeDiagnostic("response body was invalid or missing", secrets)}`);
  }
  return body;
}

export async function listZernioAccounts(
  apiKey: string,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<ZernioAccountListing> {
  const found = new Map<string, ZernioAccount>();
  let hasAnalyticsAccess: boolean | undefined;
  for (let page = 1; page <= 100; page += 1) {
    const url = new URL("https://zernio.com/api/v1/accounts");
    url.searchParams.set("platform", "twitter");
    url.searchParams.set("status", "connected");
    url.searchParams.set("page", String(page));
    url.searchParams.set("limit", "100");
    const response = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await parseResponse(response, "Zernio", [apiKey])) as {
      accounts?: ZernioAccount[];
      hasAnalyticsAccess?: boolean;
      pagination?: { pages?: number; totalPages?: number; hasNextPage?: boolean };
    };
    if (typeof body.hasAnalyticsAccess === "boolean") {
      if (hasAnalyticsAccess !== undefined && hasAnalyticsAccess !== body.hasAnalyticsAccess) {
        throw new Error("Zernio returned inconsistent analytics access across account pages");
      }
      hasAnalyticsAccess = body.hasAnalyticsAccess;
    }
    const accounts = body.accounts ?? [];
    for (const account of accounts) {
      if (account._id && account.isActive !== false) found.set(account._id, account);
    }
    const pages = body.pagination?.pages ?? body.pagination?.totalPages;
    if (body.pagination?.hasNextPage === false || (pages !== undefined && page >= pages) || accounts.length < 100) break;
  }
  return { accounts: [...found.values()], hasAnalyticsAccess: hasAnalyticsAccess === true };
}

async function setZernioAnalytics(apiKey: string, accountId: string, enabled: boolean): Promise<void> {
  const response = await fetch(`https://zernio.com/api/v1/accounts/${encodeURIComponent(accountId)}`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ xCapabilities: { analytics: enabled } }),
    signal: AbortSignal.timeout(15_000),
  });
  await parseResponse(response, "Zernio", [apiKey]);
}

export async function runSetup(paths: ExyPaths): Promise<void> {
  if (process.platform === "linux" && process.getuid?.() !== 0) {
    throw new Error("Ubuntu service setup must run with sudo/root: sudo exy setup");
  }
  const serviceWasActive = process.platform === "linux"
    && (await runCommand("systemctl", ["is-active", "--quiet", "exy.service"])).exitCode === 0;
  console.log("Exy setup — safe to rerun; blank secret answers preserve existing values.\n");
  await installRuntimeDependencies();
  await ensureLayout(paths);

  const store = new ConfigStore(paths);
  const previousConfig = await store.readConfigOrUndefined();
  const previousSecrets = await store.readSecretsOrUndefined();

  const discordBotToken = await askSecret("Discord bot token", previousSecrets?.discordBotToken);
  const applicationId = await input({
    message: "Discord application/client ID",
    default: previousConfig?.discord.applicationId,
    validate: discordId("Application ID"),
  });
  const guildId = await input({
    message: "Discord guild ID",
    default: previousConfig?.discord.guildId,
    validate: discordId("Guild ID"),
  });
  const parentChannelId = await input({
    message: "Discord parent channel ID",
    default: previousConfig?.discord.parentChannelId,
    validate: discordId("Parent channel ID"),
  });
  const authorizedUserId = await input({
    message: "Authorized Discord user ID",
    default: previousConfig?.discord.authorizedUserId,
    validate: discordId("Authorized user ID"),
  });

  const supermemoryApiKey = await askSecret("Supermemory API key", previousSecrets?.supermemoryApiKey);
  const xquikApiKey = await askSecret("Xquik API key", previousSecrets?.xquikApiKey);
  const zernioApiKey = await askSecret("Zernio API key", previousSecrets?.zernioApiKey);
  const exaApiKey = await askSecret("Exa API key", previousSecrets?.exaApiKey);

  console.log("\nChecking Zernio and loading connected X accounts…");
  let accountListing: ZernioAccountListing;
  try {
    accountListing = await listZernioAccounts(zernioApiKey);
  } catch (error) {
    throw new Error(sanitizeDiagnostic(error, [zernioApiKey]));
  }
  const xAccounts = accountListing.accounts;
  if (xAccounts.length === 0) {
    throw new Error("Zernio returned no healthy connected X/Twitter accounts. Connect one in Zernio, then rerun setup.");
  }
  const selectedAccountId = await select({
    message: "Connected X account for Exy",
    choices: xAccounts.map((account) => ({
      name: `${account.displayName ?? account.username ?? account._id}${account.username ? ` (${account.username})` : ""}`,
      value: account._id,
    })),
    default: xAccounts.some((account) => account._id === previousConfig?.providers.zernioAccountId)
      ? previousConfig?.providers.zernioAccountId
      : undefined,
  });
  const selectedAccount = xAccounts.find((account) => account._id === selectedAccountId)!;

  console.log(
    "Zernio X analytics may incur X API pass-through charges. Exy will never enable that metered capability silently.",
  );
  const analyticsEnabled = await confirm({
    message: "Enable Zernio analytics sync for this X account?",
    default: previousConfig?.providers.zernioXAnalyticsEnabled ?? false,
  });
  if (analyticsEnabled && !accountListing.hasAnalyticsAccess) {
    throw new Error(
      "The selected Zernio account does not report analytics add-on access. Enable the add-on in Zernio or rerun setup with analytics disabled.",
    );
  }
  const accountChanged = previousConfig?.providers.zernioAccountId !== selectedAccountId;
  const previousAccountId = previousConfig?.providers.zernioAccountId;
  if (accountChanged && previousAccountId && previousConfig?.providers.zernioXAnalyticsEnabled) {
    const previousKey = previousSecrets?.zernioApiKey ?? zernioApiKey;
    try {
      await setZernioAnalytics(previousKey, previousAccountId, false);
    } catch (error) {
      throw new Error(
        `Could not disable metered analytics on the previously selected X account (${previousAccountId}). `
        + `Disable it in Zernio or restore access, then rerun setup. ${sanitizeDiagnostic(error, [previousKey, zernioApiKey])}`,
      );
    }
  }
  // Always reconcile provider state. This makes reruns converge after a prior
  // attempt was interrupted between disabling the old account and configuring
  // the selected one.
  try {
    await setZernioAnalytics(zernioApiKey, selectedAccountId, analyticsEnabled);
  } catch (error) {
    throw new Error(sanitizeDiagnostic(error, [zernioApiKey]));
  }

  const secrets: ExySecrets = {
    discordBotToken,
    supermemoryApiKey,
    xquikApiKey,
    zernioApiKey,
    exaApiKey,
  };
  const discord: DiscordConfig = {
    applicationId: applicationId.trim(),
    guildId: guildId.trim(),
    parentChannelId: parentChannelId.trim(),
    authorizedUserId: authorizedUserId.trim(),
  };
  const config: ExyConfig = {
    version: 1,
    discord,
    providers: {
      zernioAccountId: selectedAccountId,
      zernioXAnalyticsEnabled: analyticsEnabled,
      ...(selectedAccount.username ? { zernioAccountUsername: selectedAccount.username } : {}),
    },
    heartbeat: heartbeatForSetup(previousConfig, discord, selectedAccountId),
    ...(previousConfig?.model ? { model: previousConfig.model } : {}),
  };

  await store.writeSecrets(secrets);
  await store.writeConfig(config);
  if (process.platform === "linux") await installSystemdService(paths);

  console.log("\nSetup complete.");
  console.log(`Configuration: ${paths.configFile}`);
  console.log(`Data:          ${paths.dataDir}`);
  const sudo = process.platform === "linux" ? "sudo " : "";
  console.log(`Next authenticate ChatGPT and select a model: ${sudo}exy login`);
  console.log(serviceWasActive
    ? `Apply the updated configuration:               ${sudo}exy restart`
    : `Then start the gateway:                     ${sudo}exy start`);
  console.log("No GitHub token was requested because the supported public skills.sh workflow does not require one.");
}
