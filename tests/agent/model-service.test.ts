import type { Api, Model } from "@earendil-works/pi-ai";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import { describe, expect, it, vi } from "vitest";
import {
  assertSuccessfulOpenCodeValidation,
  PiModelService,
  toSelectableModel,
  validatePreference,
} from "../../src/agent/model-service.js";

function model(overrides: Partial<Model<Api>> = {}): Model<Api> {
  return {
    id: "model-from-pi",
    name: "Model From Pi",
    provider: "openai-codex",
    api: "openai-codex-responses",
    baseUrl: "https://example.invalid",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1000,
    maxTokens: 100,
    ...overrides,
  } as Model<Api>;
}

describe("Pi model and reasoning selection", () => {
  it("uses a Pi release whose native OpenCode Go catalog includes Kimi K3", () => {
    expect(getBuiltinModel("opencode-go", "kimi-k3")).toMatchObject({
      provider: "opencode-go",
      id: "kimi-k3",
      name: "Kimi K3",
    });
  });

  it("uses Pi's bundled OpenCode Go catalog without a live catalog request", async () => {
    const service = Object.create(PiModelService.prototype) as PiModelService;
    const getAvailable = vi.fn(async () => [model({
      provider: "opencode-go",
      id: "kimi-k3",
      name: "Kimi K3",
    })]);
    Object.defineProperty(service, "runtimePromise", { value: Promise.resolve({ getAvailable }) });
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    await expect(service.listProviderModels("opencode-go"))
      .resolves.toEqual([expect.objectContaining({ provider: "opencode-go", id: "kimi-k3" })]);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("rejects provider error/abort results during OpenCode key validation", () => {
    expect(() => assertSuccessfulOpenCodeValidation({
      stopReason: "error",
      errorMessage: "401: Invalid API key",
    })).toThrow("401: Invalid API key");
    expect(() => assertSuccessfulOpenCodeValidation({ stopReason: "aborted" })).toThrow(/aborted/u);
    expect(() => assertSuccessfulOpenCodeValidation({ stopReason: "stop" })).not.toThrow();
  });

  it("derives reasoning choices from Pi metadata, including holes", () => {
    const selectable = toSelectableModel(
      model({ thinkingLevelMap: { off: null, minimal: null, low: "low", medium: null, high: "high", xhigh: null } }),
    );
    expect(selectable.reasoningLevels).toEqual(["low", "high"]);
  });

  it("offers only off for a non-reasoning model", () => {
    expect(toSelectableModel(model({ reasoning: false })).reasoningLevels).toEqual(["off"]);
  });

  it("rejects a persisted reasoning level that Pi does not support", () => {
    const models = [toSelectableModel(model({ thinkingLevelMap: { xhigh: null, max: null } }))];
    expect(() =>
      validatePreference(models, { provider: "openai-codex", modelId: "model-from-pi", reasoning: "xhigh" }),
    ).toThrow(/not supported/);
  });

  it("rejects model names that were not returned by Pi", () => {
    const models = [toSelectableModel(model())];
    expect(() =>
      validatePreference(models, { provider: "openai-codex", modelId: "hard-coded-guess", reasoning: "off" }),
    ).toThrow(/not exposed by Pi/);
  });
});
