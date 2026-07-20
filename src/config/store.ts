import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import type { ExyConfig, ExySecrets, ModelPreference, ThinkingLevel } from "../core/types.js";
import { THINKING_LEVELS } from "../core/types.js";
import type { ExyPaths } from "./paths.js";

const ID_PATTERN = /^\d{5,30}$/;

export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}

function nonEmpty(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ConfigurationError(`${name} is required`);
  }
}

function discordId(value: unknown, name: string): asserts value is string {
  nonEmpty(value, name);
  if (!ID_PATTERN.test(value)) throw new ConfigurationError(`${name} must be a Discord snowflake ID`);
}

export function validateConfig(value: unknown): ExyConfig {
  if (!value || typeof value !== "object") throw new ConfigurationError("Configuration must be an object");
  const config = value as Partial<ExyConfig>;
  if (config.version !== 1) throw new ConfigurationError("Unsupported configuration version");
  if (!config.discord) throw new ConfigurationError("discord configuration is required");
  discordId(config.discord.applicationId, "Discord application ID");
  discordId(config.discord.authorizedUserId, "Discord authorized user ID");
  if (!config.providers || typeof config.providers !== "object") {
    throw new ConfigurationError("providers configuration is required");
  }
  nonEmpty(config.providers.zernioAccountId, "Zernio connected X account ID");
  if (typeof config.providers.zernioXAnalyticsEnabled !== "boolean") {
    throw new ConfigurationError("Zernio X analytics consent must be true or false");
  }
  if (!config.heartbeat || typeof config.heartbeat.enabled !== "boolean") {
    throw new ConfigurationError("heartbeat configuration is required");
  }
  if (!Number.isInteger(config.heartbeat.intervalMinutes) || config.heartbeat.intervalMinutes < 1) {
    throw new ConfigurationError("Heartbeat interval must be a positive whole number of minutes");
  }
  if (config.heartbeat.deliveryThreadId !== undefined) {
    discordId(config.heartbeat.deliveryThreadId, "Heartbeat delivery thread ID");
  }
  if (config.heartbeat.enabled && config.heartbeat.deliveryThreadId === undefined) {
    throw new ConfigurationError("Enabled heartbeat requires a delivery thread ID");
  }
  if (config.model) validateModelPreference(config.model);
  if (config.writingModel) {
    const writingModel = validateModelPreference(config.writingModel);
    if (writingModel.provider !== "opencode-go") {
      throw new ConfigurationError("Writing model provider must be OpenCode Go");
    }
  }
  return config as ExyConfig;
}

export function validateSecrets(value: unknown): ExySecrets {
  if (!value || typeof value !== "object") throw new ConfigurationError("Secrets must be an object");
  const secrets = value as Partial<ExySecrets>;
  nonEmpty(secrets.discordBotToken, "Discord bot token");
  nonEmpty(secrets.supermemoryApiKey, "Supermemory API key");
  nonEmpty(secrets.xquikApiKey, "Xquik API key");
  nonEmpty(secrets.zernioApiKey, "Zernio API key");
  nonEmpty(secrets.exaApiKey, "Exa API key");
  return secrets as ExySecrets;
}

export function validateModelPreference(value: unknown): ModelPreference {
  if (!value || typeof value !== "object") throw new ConfigurationError("Model preference must be an object");
  const model = value as Partial<ModelPreference>;
  nonEmpty(model.provider, "Model provider");
  nonEmpty(model.modelId, "Model ID");
  if (!THINKING_LEVELS.includes(model.reasoning as ThinkingLevel)) {
    throw new ConfigurationError("Unsupported reasoning level");
  }
  return model as ModelPreference;
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    if (error instanceof SyntaxError) throw new ConfigurationError(`${path} contains invalid JSON`);
    throw error;
  }
}

async function writeJsonAtomic(path: string, value: unknown, mode: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  const handle = await open(temporary, "wx", mode);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(temporary, mode);
  try {
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  await chmod(path, mode);
}

export class ConfigStore {
  private mutation: Promise<void> = Promise.resolve();

  constructor(readonly paths: ExyPaths) {}

  async hasConfig(): Promise<boolean> {
    return (await readJson(this.paths.configFile)) !== undefined;
  }

  async readConfig(): Promise<ExyConfig> {
    const value = await readJson(this.paths.configFile);
    if (value === undefined) throw new ConfigurationError(`Configuration not found: ${this.paths.configFile}`);
    return validateConfig(value);
  }

  async readConfigOrUndefined(): Promise<ExyConfig | undefined> {
    const value = await readJson(this.paths.configFile);
    return value === undefined ? undefined : validateConfig(value);
  }

  async writeConfig(config: ExyConfig): Promise<void> {
    await writeJsonAtomic(this.paths.configFile, validateConfig(config), 0o600);
  }

  async updateModel(model: ModelPreference): Promise<ExyConfig> {
    return this.updateConfig((config) => ({ ...config, model: validateModelPreference(model) }));
  }

  async updateWritingModel(model: ModelPreference): Promise<ExyConfig> {
    const preference = validateModelPreference(model);
    if (preference.provider !== "opencode-go") {
      throw new ConfigurationError("Writing model provider must be OpenCode Go");
    }
    return this.updateConfig((config) => ({ ...config, writingModel: preference }));
  }

  async updateConfig(update: (current: ExyConfig) => ExyConfig): Promise<ExyConfig> {
    let value!: ExyConfig;
    const operation = this.mutation.then(async () => {
      const current = await this.readConfig();
      value = validateConfig(update(current));
      await this.writeConfig(value);
    });
    this.mutation = operation.catch(() => undefined);
    await operation;
    return value;
  }

  async readSecrets(): Promise<ExySecrets> {
    const value = await readJson(this.paths.secretsFile);
    if (value === undefined) throw new ConfigurationError(`Secrets not found: ${this.paths.secretsFile}`);
    return validateSecrets(value);
  }

  async readSecretsOrUndefined(): Promise<ExySecrets | undefined> {
    const value = await readJson(this.paths.secretsFile);
    return value === undefined ? undefined : validateSecrets(value);
  }

  async writeSecrets(secrets: ExySecrets): Promise<void> {
    await writeJsonAtomic(this.paths.secretsFile, validateSecrets(secrets), 0o600);
  }
}
