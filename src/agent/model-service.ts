import { chmod, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import {
  getSupportedThinkingLevels,
  type Api,
  type AuthEvent,
  type AuthPrompt,
  type Model,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { sanitizeDiagnostic } from "../core/errors.js";
import type { ModelPreference, ThinkingLevel } from "../core/types.js";

const OPENCODE_GO_MODELS_URL = "https://opencode.ai/zen/go/v1/models";

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

export async function fetchOpenCodeGoModelIds(
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<string[]> {
  const response = await fetchImpl(OPENCODE_GO_MODELS_URL, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(20_000),
  });
  const body = await response.json().catch(() => undefined) as {
    data?: Array<{ id?: unknown }>;
    error?: unknown;
    message?: unknown;
  } | undefined;
  if (!response.ok) {
    const detail = typeof body?.error === "string"
      ? body.error
      : typeof body?.message === "string" ? body.message : response.statusText;
    throw new Error(`OpenCode Go returned HTTP ${response.status}: ${sanitizeDiagnostic(detail || "model lookup failed")}`);
  }
  if (!Array.isArray(body?.data)) throw new Error("OpenCode Go returned an invalid model list");
  const ids = [...new Set(body.data.flatMap((entry) => typeof entry.id === "string" && entry.id.trim() ? [entry.id.trim()] : []))];
  if (ids.length === 0) throw new Error("OpenCode Go returned an empty model catalog");
  return ids;
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

export function assertSuccessfulOpenCodeValidation(result: {
  stopReason: string;
  errorMessage?: string;
}): void {
  if (result.stopReason === "error" || result.stopReason === "aborted") {
    throw new Error(result.errorMessage?.trim() || `OpenCode Go key validation stopped with ${result.stopReason}`);
  }
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
  private readonly runtimePromise: Promise<ModelRuntime>;

  constructor(readonly authFile: string, modelsFile?: string) {
    this.runtimePromise = ModelRuntime.create({
      authPath: authFile,
      modelsPath: modelsFile ?? null,
      // Exy pins Pi and validates OpenCode's live catalog separately. Avoid
      // selecting a non-durable network overlay that may vanish after restart.
      allowModelNetwork: false,
    });
  }

  get modelRuntime(): Promise<ModelRuntime> {
    return this.runtimePromise;
  }

  async loginWithDeviceCode(callbacks: LoginCallbacks): Promise<void> {
    await this.ensurePrivateAuthDirectory();
    const runtime = await this.runtimePromise;
    await runtime.login("openai-codex", "oauth", {
      prompt: async (prompt) => selectDeviceCode(prompt),
      notify: (event) => notifyLogin(event, callbacks),
      ...(callbacks.signal ? { signal: callbacks.signal } : {}),
    });
    await this.finishCredentialWrite();
  }

  async hasCodexAuthentication(): Promise<boolean> {
    return this.hasAuthentication("openai-codex");
  }

  async hasAuthentication(provider: string): Promise<boolean> {
    const runtime = await this.runtimePromise;
    return (await runtime.checkAuth(provider)) !== undefined;
  }

  async validateCodexAuthentication(): Promise<boolean> {
    return this.validateAuthentication("openai-codex");
  }

  async validateAuthentication(provider: string): Promise<boolean> {
    const runtime = await this.runtimePromise;
    return (await runtime.getAuth(provider)) !== undefined;
  }

  async storeOpenCodeGoApiKey(apiKey: string): Promise<void> {
    const key = apiKey.trim();
    if (key === "") throw new Error("OpenCode Go API key is required");
    await this.ensurePrivateAuthDirectory();
    const runtime = await this.runtimePromise;
    await runtime.login("opencode-go", "api_key", {
      prompt: async (prompt) => {
        if (prompt.type !== "secret" && prompt.type !== "text") {
          throw new Error(`Pi requested an unsupported OpenCode Go login prompt: ${prompt.type}`);
        }
        return key;
      },
      notify: () => undefined,
    });
    await this.finishCredentialWrite();
  }

  async validateOpenCodeGoApiKey(
    apiKey: string,
    currentModelIds: readonly string[],
    signal?: AbortSignal,
  ): Promise<void> {
    const runtime = await this.runtimePromise;
    const current = new Set(currentModelIds);
    const probes = runtime.getModels("opencode-go").filter((model) => current.has(model.id)).map(toSelectableModel);
    const probe = probes.find((model) => model.id === "mimo-v2.5") ?? probes[0];
    if (!probe) throw new Error("OpenCode Go returned no model that this Pi version can use to validate the key");
    const reasoning = probe.reasoningLevels.includes("off") ? "off" : probe.reasoningLevels[0];
    if (!reasoning) throw new Error(`Pi reported no supported reasoning level for opencode-go/${probe.id}`);
    const result = await runtime.completeSimple(probe.model, {
      systemPrompt: "Return only OK.",
      messages: [{ role: "user", content: "OK", timestamp: Date.now() }],
    }, {
      apiKey: apiKey.trim(),
      maxTokens: 4,
      maxRetries: 0,
      ...(reasoning === "off" ? {} : { reasoning }),
      ...(signal ? { signal } : {}),
    });
    assertSuccessfulOpenCodeValidation(result);
  }

  async listProviderModels(provider: string): Promise<SelectableModel[]> {
    const runtime = await this.runtimePromise;
    const available = (await runtime.getAvailable(provider)).map(toSelectableModel);
    if (provider !== "opencode-go") return available;
    const current = new Set(await fetchOpenCodeGoModelIds());
    return available.filter((model) => current.has(model.id));
  }

  async listCodexModels(): Promise<SelectableModel[]> {
    return this.listProviderModels("openai-codex");
  }

  async listOpenCodeGoModels(): Promise<SelectableModel[]> {
    return this.listProviderModels("opencode-go");
  }

  async resolvePreference(preference: ModelPreference): Promise<SelectableModel> {
    return validatePreference(await this.listProviderModels(preference.provider), preference);
  }

  async resolveWritingPreference(preference: ModelPreference): Promise<SelectableModel> {
    if (preference.provider !== "opencode-go") {
      throw new Error("The writing subagent model must use OpenCode Go");
    }
    return validatePreference(await this.listOpenCodeGoModels(), preference);
  }

  private async ensurePrivateAuthDirectory(): Promise<void> {
    await mkdir(dirname(this.authFile), { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") await chmod(dirname(this.authFile), 0o700);
  }

  private async finishCredentialWrite(): Promise<void> {
    if (process.platform !== "win32") await chmod(this.authFile, 0o600);
  }
}

function selectDeviceCode(prompt: AuthPrompt): string {
  if (prompt.type !== "select") {
    throw new Error(`Pi unexpectedly requested a ${prompt.type} prompt during Codex device-code login`);
  }
  const selected = prompt.options.find((option) =>
    option.id === "device_code" || /device[ -]?code/iu.test(`${option.label} ${option.description ?? ""}`),
  );
  if (!selected) throw new Error("This installed Pi version does not expose device-code login");
  return selected.id;
}

function notifyLogin(event: AuthEvent, callbacks: LoginCallbacks): void {
  if (event.type === "device_code") {
    callbacks.onDeviceCode({
      verificationUri: event.verificationUri,
      userCode: event.userCode,
      ...(event.expiresInSeconds === undefined ? {} : { expiresInSeconds: event.expiresInSeconds }),
    });
    return;
  }
  if (event.type === "progress" || event.type === "info") callbacks.onProgress?.(event.message);
  if (event.type === "auth_url") callbacks.onProgress?.(`Open ${event.url}`);
}
