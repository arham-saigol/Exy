import { password, select } from "@inquirer/prompts";
import { chmod } from "node:fs/promises";
import { ConfigStore } from "../config/store.js";
import type { ExyPaths } from "../config/paths.js";
import {
  fetchOpenCodeGoModelIds,
  PiModelService,
  type SelectableModel,
} from "../agent/model-service.js";
export { fetchOpenCodeGoModelIds } from "../agent/model-service.js";
import type { ModelPreference, ThinkingLevel } from "../core/types.js";
import { sanitizeDiagnostic } from "../core/errors.js";
import { runCommand } from "../core/process.js";
import { checkAllProviders } from "../doctor/connectivity.js";
import { ensureLayout } from "../setup/layout.js";

async function restoreServiceOwnership(paths: ExyPaths): Promise<void> {
  if (process.platform !== "linux" || process.getuid?.() !== 0) return;
  const result = await runCommand("chown", ["-R", "exy:exy", paths.configDir, paths.dataDir]);
  if (result.exitCode !== 0) throw new Error("Could not restore exy service ownership after login");
}

function preferredReasoning(model: SelectableModel): ThinkingLevel {
  const reasoning = (["medium", "high", "off"] as const).find((level) => model.reasoningLevels.includes(level))
    ?? model.reasoningLevels[0];
  if (!reasoning) throw new Error(`Pi reported no supported reasoning levels for ${model.provider}/${model.id}`);
  return reasoning;
}

export async function synchronizeOpenCodeMainPreference(
  store: Pick<ConfigStore, "readConfig" | "updateModel">,
  selected: ModelPreference,
  supported: readonly SelectableModel[],
): Promise<"initialized" | "replaced-stale" | "unchanged"> {
  const current = (await store.readConfig()).model;
  const currentIsSelectable = current?.provider === "opencode-go"
    && supported.some((model) =>
      model.id === current.modelId && model.reasoningLevels.includes(current.reasoning),
    );
  if (current && (current.provider !== "opencode-go" || currentIsSelectable)) return "unchanged";
  await store.updateModel(selected);
  return current ? "replaced-stale" : "initialized";
}

async function loginCodex(pi: PiModelService, store: ConfigStore): Promise<ModelPreference> {
  console.log("Starting Pi's OpenAI Codex device-code login for ChatGPT Plus/Pro…\n");
  await pi.loginWithDeviceCode({
    onDeviceCode: ({ verificationUri, userCode, expiresInSeconds }) => {
      console.log(`Open ${verificationUri}`);
      console.log(`Enter code: ${userCode}`);
      if (expiresInSeconds) console.log(`The code expires in about ${Math.ceil(expiresInSeconds / 60)} minutes.`);
      console.log("Waiting for authorization…\n");
    },
    onProgress: (message) => console.log(message),
  });

  const models = await pi.listCodexModels();
  if (models.length === 0) throw new Error("Pi authentication succeeded but Pi exposed no OpenAI Codex models");
  const modelKey = await select({
    message: "Default Pi model",
    choices: models.map((model) => ({
      name: `${model.name} (${model.provider}/${model.id})`,
      value: `${model.provider}\u0000${model.id}`,
    })),
    pageSize: 15,
  });
  const [provider, modelId] = modelKey.split("\u0000");
  const selected = models.find((model) => model.provider === provider && model.id === modelId);
  if (!selected) throw new Error("The selected model is no longer available from Pi");
  if (selected.reasoningLevels.length === 0) {
    throw new Error(`Pi reported no supported reasoning levels for ${selected.provider}/${selected.id}`);
  }
  const reasoning = await select<ThinkingLevel>({
    message: `Default reasoning for ${selected.name}`,
    choices: selected.reasoningLevels.map((level) => ({ name: level, value: level })),
  });
  const preference: ModelPreference = { provider: selected.provider, modelId: selected.id, reasoning };
  await store.updateModel(preference);
  return preference;
}

async function loginOpenCodeGo(
  pi: PiModelService,
  store: ConfigStore,
  previousWritingModel: ModelPreference | undefined,
): Promise<ModelPreference> {
  const apiKey = (await password({ message: "OpenCode Go API key", mask: "*" })).trim();
  if (!apiKey) throw new Error("OpenCode Go API key is required");

  let currentModelIds: string[];
  try {
    currentModelIds = await fetchOpenCodeGoModelIds();
    console.log("Validating the OpenCode Go key through Pi's native provider…");
    await pi.validateOpenCodeGoApiKey(apiKey, currentModelIds);
  } catch (error) {
    throw new Error(`OpenCode Go login failed: ${sanitizeDiagnostic(error, [apiKey])}`);
  }

  try {
    await pi.storeOpenCodeGoApiKey(apiKey);
  } catch (error) {
    throw new Error(`Could not store the OpenCode Go credential: ${sanitizeDiagnostic(error, [apiKey])}`);
  }
  const currentIds = new Set(currentModelIds);
  const piModels = await pi.listOpenCodeGoModels();
  const supported = piModels.filter((model) => currentIds.has(model.id));
  const piIds = new Set(piModels.map((model) => model.id));

  console.log("\nModels in the current OpenCode Go catalog:");
  for (const id of currentModelIds) {
    const model = piModels.find((candidate) => candidate.id === id);
    console.log(`- ${model?.name ?? id} (opencode-go/${id})${piIds.has(id) ? "" : " — unavailable in this Pi version"}`);
  }
  if (supported.length === 0) {
    throw new Error("OpenCode Go returned models, but none are available in this Pi version; upgrade Exy/Pi and run exy login again");
  }
  if (previousWritingModel && !supported.some((model) => model.id === previousWritingModel.modelId)) {
    console.log(`\n! Previously selected writing model opencode-go/${previousWritingModel.modelId} is no longer available. Choose a replacement.`);
  }

  const recommended = supported.find((model) => model.id === "kimi-k3");
  const defaultModelId = supported.some((model) => model.id === previousWritingModel?.modelId)
    ? previousWritingModel?.modelId
    : recommended?.id;
  const modelId = await select({
    message: "Writing subagent model",
    choices: supported.map((model) => ({
      name: `${model.name} (${model.provider}/${model.id})${model.id === "kimi-k3" ? " — recommended" : ""}`,
      value: model.id,
    })),
    default: defaultModelId,
    pageSize: 20,
  });
  const selected = supported.find((model) => model.id === modelId);
  if (!selected) throw new Error("The selected OpenCode Go model is no longer available");
  const preference: ModelPreference = {
    provider: "opencode-go",
    modelId: selected.id,
    reasoning: previousWritingModel?.modelId === selected.id
      && selected.reasoningLevels.includes(previousWritingModel.reasoning)
      ? previousWritingModel.reasoning
      : preferredReasoning(selected),
  };
  await store.updateWritingModel(preference);

  const mainUpdate = await synchronizeOpenCodeMainPreference(store, preference, supported);
  if (mainUpdate === "initialized") {
    console.log("No main model was configured, so the selected OpenCode Go model will also run the coordinator and research subagents.");
  } else if (mainUpdate === "replaced-stale") {
    console.log("The previous OpenCode Go main model is no longer selectable, so the selected writing model will also run the coordinator and research subagents.");
  }
  return preference;
}

export async function runLogin(paths: ExyPaths): Promise<void> {
  if (process.platform === "linux") {
    if (process.getuid?.() !== 0) throw new Error("Ubuntu service login must run with sudo/root: sudo exy login");
    const active = await runCommand("systemctl", ["is-active", "--quiet", "exy.service"]);
    if (active.exitCode === 0) throw new Error("Stop the Exy gateway before login: sudo exy stop");
  }
  await ensureLayout(paths);
  const store = new ConfigStore(paths);
  const config = await store.readConfig();
  const secrets = await store.readSecrets();
  let changed: ModelPreference;
  try {
    const pi = new PiModelService(paths.piAuthFile);
    const provider = await select<"opencode-go" | "openai-codex">({
      message: "Login provider",
      choices: [
        { name: "OpenCode Go", value: "opencode-go" },
        { name: "ChatGPT/Codex", value: "openai-codex" },
      ],
    });
    changed = provider === "opencode-go"
      ? await loginOpenCodeGo(pi, store, config.writingModel)
      : await loginCodex(pi, store);
    if (process.platform !== "win32") await chmod(paths.piAuthFile, 0o600);
  } finally {
    // Pi can write auth before a later model prompt is cancelled. Restore
    // service ownership for both successful and partial login attempts.
    await restoreServiceOwnership(paths);
  }

  console.log("\nValidating configured providers (credentials are never printed)…");
  const checks = await checkAllProviders(config, secrets);
  for (const check of checks) console.log(`${check.ok ? "✓" : "!"} ${check.name}: ${check.detail}`);
  const failures = checks.filter((check) => !check.ok);
  const finalConfig = await store.readConfig();

  console.log("\nLogin complete.");
  console.log(`Updated model:      ${changed.provider}/${changed.modelId}`);
  if (finalConfig.model) console.log(`Main coordinator:   ${finalConfig.model.provider}/${finalConfig.model.modelId} (${finalConfig.model.reasoning})`);
  if (finalConfig.writingModel) console.log(`Writing subagent:   ${finalConfig.writingModel.provider}/${finalConfig.writingModel.modelId} (${finalConfig.writingModel.reasoning})`);
  else console.log("Writing subagent:   not configured; run exy login and choose OpenCode Go before requesting a draft");
  if (failures.length > 0) {
    console.log(`${failures.length} provider check(s) need attention. Run exy doctor after correcting them.`);
  }
  console.log(`Start Exy with: ${process.platform === "linux" ? "sudo " : ""}exy start`);
}
