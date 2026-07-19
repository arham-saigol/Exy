import type { Api, Model } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { createSubagentTools, terminalAssistantText } from "../../src/agent/subagents.js";
import {
  RESEARCH_SUBAGENT_SYSTEM_PROMPT,
  WRITING_SUBAGENT_SYSTEM_PROMPT,
} from "../../src/agent/subagent-prompts.js";
import type { ModelPreference } from "../../src/core/types.js";

function selectable(provider: string, id: string) {
  return {
    provider,
    id,
    name: id,
    reasoningLevels: ["off", "medium", "high"],
    model: {
      id,
      name: id,
      provider,
      api: "openai-completions",
      baseUrl: "https://example.invalid",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1000,
      maxTokens: 100,
    } as Model<Api>,
  };
}

function marker(name: string): ToolDefinition {
  return { name } as ToolDefinition;
}

async function execute(tool: ToolDefinition, input: Record<string, unknown>) {
  return tool.execute("test", input, new AbortController().signal, undefined, undefined as never);
}

function resultJson(result: Awaited<ReturnType<ToolDefinition["execute"]>>) {
  const content = result.content.find((item) => item.type === "text");
  return JSON.parse(content?.type === "text" ? content.text : "{}") as Record<string, unknown>;
}

const mainPreference: ModelPreference = {
  provider: "openai-codex",
  modelId: "main-model",
  reasoning: "high",
};
const writingPreference: ModelPreference = {
  provider: "opencode-go",
  modelId: "kimi-k3",
  reasoning: "medium",
};

describe("specialized subagent tools", () => {
  it("takes only the terminal assistant text and preserves its exact bytes", () => {
    const messages = [
      { role: "assistant", content: [{ type: "text", text: "intermediate narration" }], stopReason: "toolUse" },
      { role: "toolResult", content: [{ type: "text", text: "skill" }] },
      {
        role: "assistant",
        content: [{ type: "text", text: "\n  Exact" }, { type: "text", text: " bytes  \n" }],
        stopReason: "stop",
      },
    ];
    expect(terminalAssistantText(messages)).toBe("\n  Exact bytes  \n");
    expect(() => terminalAssistantText([
      ...messages,
      { role: "assistant", content: [], stopReason: "error", errorMessage: "provider failed" },
    ])).toThrow("provider failed");
    expect(() => terminalAssistantText(messages.slice(0, 2))).toThrow(/did not finish/u);
  });

  it("runs research with the main model/reasoning and only research + skill tools", async () => {
    const runner = vi.fn(async () => ({ output: "Brief with sources", searchedX: true }));
    const tools = createSubagentTools({
      paths: {} as never,
      configStore: { readConfig: vi.fn(async () => ({ model: mainPreference })) } as never,
      modelService: {
        resolvePreference: vi.fn(() => selectable("openai-codex", "main-model")),
      } as never,
      researchTools: [marker("search_x"), marker("search_web"), marker("fetch_web_page")],
      skillTools: [marker("activate_agent_skill")],
      saveDraft: vi.fn(),
      runner,
    });

    const result = await execute(tools.find((tool) => tool.name === "spawn_research_subagent")!, {
      userRequest: "Find current launch discussions",
      objective: "Find strong reply targets",
      knownContext: "Audience: technical founders",
    });

    expect(resultJson(result)).toMatchObject({ findings: "Brief with sources", searchedX: true });
    expect(runner).toHaveBeenCalledWith(expect.objectContaining({
      role: "research",
      systemPrompt: RESEARCH_SUBAGENT_SYSTEM_PROMPT,
      preference: mainPreference,
      tools: expect.arrayContaining([
        expect.objectContaining({ name: "search_x" }),
        expect.objectContaining({ name: "activate_agent_skill" }),
      ]),
    }));
    expect(runner.mock.calls[0]?.[0].tools.map((tool) => tool.name)).not.toContain("save_x_draft");
  });

  it("always uses the persisted OpenCode Go writer and stores its exact output", async () => {
    const runner = vi.fn(async () => ({ output: "Exact writer bytes — unchanged.", searchedX: false }));
    const saveDraft = vi.fn(async (input) => ({
      content: [{ type: "text" as const, text: JSON.stringify({ stored: true, exactContent: input.content }) }],
      details: {},
    }));
    const tools = createSubagentTools({
      paths: {} as never,
      configStore: { readConfig: vi.fn(async () => ({ writingModel: writingPreference })) } as never,
      modelService: {
        resolveWritingPreference: vi.fn(() => selectable("opencode-go", "kimi-k3")),
      } as never,
      researchTools: [],
      skillTools: [marker("activate_agent_skill")],
      saveDraft,
      runner,
    });

    const result = await execute(tools.find((tool) => tool.name === "spawn_writing_subagent")!, {
      kind: "reply",
      userRequest: "Write a concise reply",
      researchFindings: "The launch shipped today.",
      sourcePosts: "candidateRef=opaque-1; author asks for feedback",
      audienceContext: "Developer tools founders",
      writingPreferences: "Short, direct, no hype",
      candidateRef: "opaque-1",
    });

    expect(resultJson(result)).toEqual({ stored: true, exactContent: "Exact writer bytes — unchanged." });
    expect(runner).toHaveBeenCalledWith(expect.objectContaining({
      role: "writing",
      systemPrompt: WRITING_SUBAGENT_SYSTEM_PROMPT,
      preference: writingPreference,
      tools: [expect.objectContaining({ name: "activate_agent_skill" })],
    }));
    expect(runner.mock.calls[0]?.[0].prompt).toContain("Short, direct, no hype");
    expect(saveDraft).toHaveBeenCalledWith({
      kind: "reply",
      content: "Exact writer bytes — unchanged.",
      candidateRef: "opaque-1",
    }, expect.any(AbortSignal));
  });

  it("fails clearly instead of falling back when the writing model is missing or stale", async () => {
    const missing = createSubagentTools({
      paths: {} as never,
      configStore: { readConfig: vi.fn(async () => ({})) } as never,
      modelService: {} as never,
      researchTools: [],
      skillTools: [],
      saveDraft: vi.fn(),
      runner: vi.fn(),
    });
    await expect(execute(missing.find((tool) => tool.name === "spawn_writing_subagent")!, {
      kind: "original",
      userRequest: "Draft a post",
    })).rejects.toThrow(/run exy login and choose OpenCode Go/u);

    const stale = createSubagentTools({
      paths: {} as never,
      configStore: { readConfig: vi.fn(async () => ({ writingModel: writingPreference })) } as never,
      modelService: { resolveWritingPreference: vi.fn(() => { throw new Error("not exposed"); }) } as never,
      researchTools: [],
      skillTools: [],
      saveDraft: vi.fn(),
      runner: vi.fn(),
    });
    await expect(execute(stale.find((tool) => tool.name === "spawn_writing_subagent")!, {
      kind: "original",
      userRequest: "Draft a post",
    })).rejects.toThrow(/choose another OpenCode Go model/u);
  });
});

describe("specialized prompts", () => {
  it("keeps research focused on current X and web evidence without drafting", () => {
    expect(RESEARCH_SUBAGENT_SYSTEM_PROMPT).toContain("Use search_x extensively");
    expect(RESEARCH_SUBAGENT_SYSTEM_PROMPT).toContain("Use search_web extensively");
    expect(RESEARCH_SUBAGENT_SYSTEM_PROMPT).toContain("Do not draft");
  });

  it("contains all six Orwell rules and the no-publication boundary", () => {
    for (const rule of [
      "Never use a metaphor",
      "Never use a long word",
      "possible to cut a word out",
      "Never use the passive",
      "everyday English equivalent",
      "Break any of these rules",
    ]) expect(WRITING_SUBAGENT_SYSTEM_PROMPT).toContain(rule);
    expect(WRITING_SUBAGENT_SYSTEM_PROMPT).toContain("Nothing may be posted");
  });
});
