import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { toSelectableModel, validatePreference } from "../../src/agent/model-service.js";

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
