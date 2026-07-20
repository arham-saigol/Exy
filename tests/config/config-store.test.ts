import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigStore } from "../../src/config/store.js";
import { resolveExyPaths } from "../../src/config/paths.js";
import type { ExyConfig, ExySecrets } from "../../src/core/types.js";

const roots: string[] = [];

async function makeStore(): Promise<ConfigStore> {
  const root = await mkdtemp(join(tmpdir(), "exy-config-test-"));
  roots.push(root);
  return new ConfigStore(
    resolveExyPaths({ EXY_CONFIG_DIR: join(root, "config"), EXY_DATA_DIR: join(root, "data") }),
  );
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const config: ExyConfig = {
  version: 1,
  discord: {
    applicationId: "123456789012345678",
    authorizedUserId: "423456789012345678",
  },
  providers: {
    zernioAccountId: "account-a",
    zernioAccountUsername: "@example",
    zernioXAnalyticsEnabled: false,
  },
  heartbeat: { enabled: false, intervalMinutes: 30 },
};

const secrets: ExySecrets = {
  discordBotToken: "discord-secret",
  supermemoryApiKey: "sm-secret",
  xquikApiKey: "xq-secret",
  zernioApiKey: "z-secret",
  exaApiKey: "exa-secret",
};

describe("ConfigStore", () => {
  it("persists configuration and model choices across store instances", async () => {
    const store = await makeStore();
    await store.writeConfig(config);
    await store.updateModel({ provider: "openai-codex", modelId: "returned-by-pi", reasoning: "high" });

    const reopened = new ConfigStore(store.paths);
    expect((await reopened.readConfig()).model).toEqual({
      provider: "openai-codex",
      modelId: "returned-by-pi",
      reasoning: "high",
    });
  });

  it("persists a separate OpenCode Go writing model", async () => {
    const store = await makeStore();
    await store.writeConfig(config);
    await store.updateWritingModel({ provider: "opencode-go", modelId: "kimi-k3", reasoning: "high" });

    expect((await new ConfigStore(store.paths).readConfig()).writingModel).toEqual({
      provider: "opencode-go",
      modelId: "kimi-k3",
      reasoning: "high",
    });
    await expect(store.updateWritingModel({
      provider: "openai-codex",
      modelId: "not-a-writer",
      reasoning: "medium",
    })).rejects.toThrow(/Writing model provider must be OpenCode Go/u);
  });

  it("stores secrets as mode 0600 without logging their values", async () => {
    const store = await makeStore();
    await store.writeSecrets(secrets);
    expect(await store.readSecrets()).toEqual(secrets);
    if (process.platform !== "win32") {
      expect((await stat(store.paths.secretsFile)).mode & 0o777).toBe(0o600);
    }
    expect(await readFile(store.paths.secretsFile, "utf8")).not.toContain("EXY_CONFIG_DIR");
  });

  it("serializes concurrent model and heartbeat mutations without losing either", async () => {
    const store = await makeStore();
    await store.writeConfig(config);
    await Promise.all([
      store.updateModel({ provider: "openai-codex", modelId: "pi-model", reasoning: "medium" }),
      store.updateConfig((current) => ({
        ...current,
        heartbeat: { enabled: true, intervalMinutes: 45, deliveryThreadId: "523456789012345678" },
      })),
    ]);
    expect(await store.readConfig()).toMatchObject({
      model: { provider: "openai-codex", modelId: "pi-model", reasoning: "medium" },
      heartbeat: { enabled: true, intervalMinutes: 45, deliveryThreadId: "523456789012345678" },
    });
  });

  it("rejects incomplete provider and heartbeat state that the gateway cannot run", async () => {
    const store = await makeStore();
    await expect(store.writeConfig({
      ...config,
      providers: { zernioAccountId: "", zernioXAnalyticsEnabled: false },
    })).rejects.toThrow(/Zernio connected X account ID/u);
    await expect(store.writeConfig({
      ...config,
      heartbeat: { enabled: true, intervalMinutes: 30 },
    })).rejects.toThrow(/delivery thread ID/u);
  });
});
