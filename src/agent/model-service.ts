import { chmod, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { getSupportedThinkingLevels, type Api, type Model } from "@earendil-works/pi-ai";
import { OPENAI_CODEX_DEVICE_CODE_LOGIN_METHOD } from "@earendil-works/pi-ai/oauth";
import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { ModelPreference, ThinkingLevel } from "../core/types.js";

export interface DeviceCodeNotice {
  verificationUri: string;
  userCode: string;
  expiresInSeconds?: number;
}

export interface LoginCallbacks {
  onDeviceCode(notice: DeviceCodeNotice): void;
  onProgress?(message: string): void;
  signal?: AbortSignal;
}

export interface SelectableModel {
  provider: string;
  id: string;
  name: string;
  reasoningLevels: ThinkingLevel[];
  model: Model<Api>;
}

export function toSelectableModel(model: Model<Api>): SelectableModel {
  return {
    provider: model.provider,
    id: model.id,
    name: model.name,
    reasoningLevels: getSupportedThinkingLevels(model) as ThinkingLevel[],
    model,
  };
}

export function validatePreference(models: SelectableModel[], preference: ModelPreference): SelectableModel {
  const selected = models.find(
    (model) => model.provider === preference.provider && model.id === preference.modelId,
  );
  if (!selected) {
    throw new Error(`The configured model ${preference.provider}/${preference.modelId} is not exposed by Pi`);
  }
  if (!selected.reasoningLevels.includes(preference.reasoning)) {
    throw new Error(
      `Reasoning level ${preference.reasoning} is not supported by ${preference.provider}/${preference.modelId}`,
    );
  }
  return selected;
}

export class PiModelService {
  readonly authStorage: AuthStorage;
  readonly registry: ModelRegistry;

  constructor(readonly authFile: string, modelsFile?: string) {
    this.authStorage = AuthStorage.create(authFile);
    this.registry = modelsFile
      ? ModelRegistry.create(this.authStorage, modelsFile)
      : ModelRegistry.inMemory(this.authStorage);
  }

  async loginWithDeviceCode(callbacks: LoginCallbacks): Promise<void> {
    await mkdir(dirname(this.authFile), { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") await chmod(dirname(this.authFile), 0o700);

    await this.authStorage.login("openai-codex", {
      onSelect: async (prompt) => {
        const supported = prompt.options.some((option) => option.id === OPENAI_CODEX_DEVICE_CODE_LOGIN_METHOD);
        if (!supported) throw new Error("This installed Pi version does not expose device-code login");
        return OPENAI_CODEX_DEVICE_CODE_LOGIN_METHOD;
      },
      onDeviceCode: (notice) => callbacks.onDeviceCode(notice),
      onAuth: () => {
        throw new Error("Pi unexpectedly selected browser OAuth instead of device-code login");
      },
      onPrompt: async () => "",
      onProgress: (message) => callbacks.onProgress?.(message),
      ...(callbacks.signal ? { signal: callbacks.signal } : {}),
    });

    if (process.platform !== "win32") await chmod(this.authFile, 0o600);
    this.registry.refresh();
  }

  hasCodexAuthentication(): boolean {
    return this.authStorage.hasAuth("openai-codex");
  }

  async validateCodexAuthentication(): Promise<boolean> {
    return (await this.authStorage.getApiKey("openai-codex")) !== undefined;
  }

  listCodexModels(): SelectableModel[] {
    this.registry.refresh();
    return this.registry
      .getAvailable()
      .filter((model) => model.provider === "openai-codex")
      .map(toSelectableModel);
  }

  resolvePreference(preference: ModelPreference): SelectableModel {
    return validatePreference(this.listCodexModels(), preference);
  }
}
