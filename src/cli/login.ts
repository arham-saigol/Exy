import { select } from "@inquirer/prompts";
import { chmod } from "node:fs/promises";
import { ConfigStore } from "../config/store.js";
import type { ExyPaths } from "../config/paths.js";
import { PiModelService } from "../agent/model-service.js";
import type { ModelPreference, ThinkingLevel } from "../core/types.js";
import { runCommand } from "../core/process.js";
import { checkAllProviders } from "../doctor/connectivity.js";
import { ensureLayout } from "../setup/layout.js";

async function restoreServiceOwnership(paths: ExyPaths): Promise<void> {
  if (process.platform !== "linux" || process.getuid?.() !== 0) return;
  const result = await runCommand("chown", ["-R", "exy:exy", paths.configDir, paths.dataDir]);
  if (result.exitCode !== 0) throw new Error("Could not restore exy service ownership after login");
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

  let preference!: ModelPreference;
  try {
    console.log("Starting Pi's OpenAI Codex device-code login for ChatGPT Plus/Pro…\n");
    const pi = new PiModelService(paths.piAuthFile);
    await pi.loginWithDeviceCode({
      onDeviceCode: ({ verificationUri, userCode, expiresInSeconds }) => {
        console.log(`Open ${verificationUri}`);
        console.log(`Enter code: ${userCode}`);
        if (expiresInSeconds) console.log(`The code expires in about ${Math.ceil(expiresInSeconds / 60)} minutes.`);
        console.log("Waiting for authorization…\n");
      },
      onProgress: (message) => console.log(message),
    });

    const models = pi.listCodexModels();
    if (models.length === 0) {
      throw new Error("Pi authentication succeeded but Pi exposed no OpenAI Codex models");
    }
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
    preference = { provider: selected.provider, modelId: selected.id, reasoning };
    await store.updateModel(preference);
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

  console.log("\nLogin complete.");
  console.log(`Default model:     ${preference.provider}/${preference.modelId}`);
  console.log(`Default reasoning: ${preference.reasoning}`);
  if (failures.length > 0) {
    console.log(`${failures.length} provider check(s) need attention. Run exy doctor after correcting them.`);
  }
  console.log(`Start Exy with: ${process.platform === "linux" ? "sudo " : ""}exy start`);
}
