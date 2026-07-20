import { describe, expect, it, vi } from "vitest";

import { ExyAgentRuntime } from "../../src/agent/runtime.js";
import type { AgentProgressEvent } from "../../src/core/progress.js";
import { ExyDatabase } from "../../src/db/database.js";
import type { DiscordThreadRecord } from "../../src/db/threads.js";
import { ReplyOpportunityVerifier } from "../../src/verifier/reply-verifier.js";

const record: DiscordThreadRecord = {
  threadId: "thread-1",
  guildId: "guild-1",
  parentChannelId: "parent-1",
  parentMessageId: "message-1",
  sessionId: "session-1",
  discordUserId: "user-1",
  xAccountId: "account-1",
  archived: false,
  createdAt: 1,
  lastActivityAt: 1,
};

interface RuntimeProgressApi {
  runTurnExclusive(input: {
    threadId: string;
    content: string;
    signal: AbortSignal;
    onProgress(event: AgentProgressEvent): Promise<void>;
  }): Promise<{ content: string }>;
  getOrCreateSession(): Promise<unknown>;
  synchronizeSessionPreference(): Promise<void>;
  recallMemory(): Promise<string>;
}

describe("ExyAgentRuntime progress", () => {
  it("shows the validated skill name after a skill is activated", async () => {
    let listener: ((event: any) => void) | undefined;
    const session = {
      isStreaming: false,
      reload: vi.fn(async () => undefined),
      subscribe: vi.fn((next: (event: any) => void) => {
        listener = next;
        return () => undefined;
      }),
      prompt: vi.fn(async () => {
        listener?.({
          type: "tool_execution_start",
          toolName: "activate_agent_skill",
          args: { name: "raw-model-value-must-not-be-rendered" },
        });
        listener?.({
          type: "tool_execution_end",
          toolName: "activate_agent_skill",
          isError: false,
          result: {
            content: [{
              type: "text",
              text: JSON.stringify({ name: "exy-automation", instructions: "private instructions" }),
            }],
          },
        });
      }),
      abort: vi.fn(async () => undefined),
    };
    const runtime = new ExyAgentRuntime({
      threads: { touch: vi.fn() },
      drafts: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      verifier: {},
    } as never) as unknown as RuntimeProgressApi;
    runtime.getOrCreateSession = vi.fn(async () => ({
      session,
      record,
      preference: { provider: "openai-codex", modelId: "model", reasoning: "low" },
    }));
    runtime.synchronizeSessionPreference = vi.fn(async () => undefined);
    runtime.recallMemory = vi.fn(async () => "");
    const progress: AgentProgressEvent[] = [];

    await runtime.runTurnExclusive({
      threadId: "thread-1",
      content: "use the automation skill",
      signal: new AbortController().signal,
      onProgress: async (event) => {
        progress.push(event);
      },
    });

    expect(progress).toEqual([
      { type: "tool_status", message: "Used the `exy-automation` skill" },
    ]);
    expect(JSON.stringify(progress)).not.toContain("raw-model-value");
    expect(JSON.stringify(progress)).not.toContain("private instructions");
  });

  it("forwards sanitized tool starts while guarding the ordered final response", async () => {
    let listener: ((event: any) => void) | undefined;
    const session = {
      isStreaming: false,
      reload: vi.fn(async () => undefined),
      subscribe: vi.fn((next: (event: any) => void) => {
        listener = next;
        return () => undefined;
      }),
      prompt: vi.fn(async () => {
        listener?.({
          type: "message_update",
          assistantMessageEvent: { type: "thinking_delta", delta: "private reasoning" },
        });
        listener?.({
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta: "I published it.\n" },
        });
        listener?.({
          type: "tool_execution_start",
          toolName: "search_x",
          args: { query: "secret query", apiKey: "sk-secret" },
        });
        listener?.({
          type: "tool_execution_start",
          toolName: "search_x",
          args: { query: "retry secret query", cursor: "private-cursor" },
        });
        listener?.({
          type: "message_update",
          assistantMessageEvent: {
            type: "text_delta",
            delta: "https://x.com/unverified/status/123",
          },
        });
      }),
      abort: vi.fn(async () => undefined),
    };
    const runtime = new ExyAgentRuntime({
      threads: { touch: vi.fn() },
      drafts: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      verifier: {},
    } as never) as unknown as RuntimeProgressApi;
    runtime.getOrCreateSession = vi.fn(async () => ({
      session,
      record,
      preference: { provider: "openai-codex", modelId: "model", reasoning: "low" },
    }));
    runtime.synchronizeSessionPreference = vi.fn(async () => undefined);
    runtime.recallMemory = vi.fn(async () => "");
    const progress: AgentProgressEvent[] = [];

    const result = await runtime.runTurnExclusive({
      threadId: "thread-1",
      content: "help",
      signal: new AbortController().signal,
      onProgress: async (event) => {
        progress.push(event);
      },
    });

    expect(progress).toEqual([
      { type: "tool_status", message: "Searching X" },
      { type: "tool_status", message: "Searching X" },
    ]);
    expect(JSON.stringify(progress)).not.toContain("private reasoning");
    expect(JSON.stringify(progress)).not.toContain("secret query");
    expect(JSON.stringify(progress)).not.toContain("private-cursor");
    expect(JSON.stringify(progress)).not.toContain("sk-secret");
    expect(JSON.stringify(progress)).not.toContain("I published it");
    expect(JSON.stringify(progress)).not.toContain("x.com/unverified");
    expect(result.content).toBe(
      "[Publication success claim omitted: Zernio did not confirm publication.]\n"
      + "[X post omitted: it was not passed through Exy's reply-opportunity verifier]",
    );
  });

  it("preserves a research brief when only the research subagent searched X", async () => {
    let listener: ((event: any) => void) | undefined;
    const brief = "Recent discussion clusters around onboarding friction and pricing clarity.";
    const session = {
      isStreaming: false,
      reload: vi.fn(async () => undefined),
      subscribe: vi.fn((next: (event: any) => void) => {
        listener = next;
        return () => undefined;
      }),
      prompt: vi.fn(async () => {
        listener?.({
          type: "tool_execution_end",
          toolName: "spawn_research_subagent",
          isError: false,
          result: {
            content: [{ type: "text", text: JSON.stringify({ findings: brief, searchedX: true }) }],
          },
        });
        listener?.({
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta: brief },
        });
      }),
      abort: vi.fn(async () => undefined),
    };
    const runtime = new ExyAgentRuntime({
      threads: { touch: vi.fn() },
      drafts: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      verifier: {},
    } as never) as unknown as RuntimeProgressApi;
    runtime.getOrCreateSession = vi.fn(async () => ({
      session,
      record,
      preference: { provider: "openai-codex", modelId: "model", reasoning: "low" },
    }));
    runtime.synchronizeSessionPreference = vi.fn(async () => undefined);
    runtime.recallMemory = vi.fn(async () => "");

    const result = await runtime.runTurnExclusive({
      threadId: "thread-1",
      content: "Analyze current trends",
      signal: new AbortController().signal,
      onProgress: async () => undefined,
    });

    expect(result.content).toBe(brief);
  });

  it("renders a saved delegated draft alongside an already-staged recommendation", async () => {
    const database = new ExyDatabase(":memory:");
    try {
      let listener: ((event: any) => void) | undefined;
      let runtime!: ExyAgentRuntime;
      const exactDraft = "Ship the smallest useful version, then listen.";
      const session = {
        isStreaming: false,
        reload: vi.fn(async () => undefined),
        subscribe: vi.fn((next: (event: any) => void) => {
          listener = next;
          return () => undefined;
        }),
        prompt: vi.fn(async () => {
          (runtime as unknown as {
            stageReplyOpportunity(
              threadId: string,
              scope: { discordUserId: string; xAccountId: string },
              sessionId: string,
              input: { post: string; rationale: string },
            ): unknown;
          }).stageReplyOpportunity(
            record.threadId,
            { discordUserId: record.discordUserId, xAccountId: record.xAccountId },
            record.sessionId,
            { post: "1900123456789012345", rationale: "The author asked a relevant launch question." },
          );
          listener?.({
            type: "tool_execution_end",
            toolName: "spawn_writing_subagent",
            isError: false,
            result: {
              content: [{ type: "text", text: JSON.stringify({ stored: true, exactContent: exactDraft }) }],
            },
          });
        }),
        abort: vi.fn(async () => undefined),
      };
      runtime = new ExyAgentRuntime({
        threads: { touch: vi.fn() },
        drafts: {},
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        verifier: new ReplyOpportunityVerifier(database),
      } as never);
      const api = runtime as unknown as RuntimeProgressApi;
      api.getOrCreateSession = vi.fn(async () => ({
        session,
        record,
        preference: { provider: "openai-codex", modelId: "model", reasoning: "low" },
      }));
      api.synchronizeSessionPreference = vi.fn(async () => undefined);
      api.recallMemory = vi.fn(async () => "");

      const result = await api.runTurnExclusive({
        threadId: record.threadId,
        content: "Draft a reply",
        signal: new AbortController().signal,
        onProgress: async () => undefined,
      });

      expect(result.content).toContain("Reply opportunity");
      expect(result.content).toContain("https://x.com/i/web/status/1900123456789012345");
      expect(result.content).toContain(`I'd post this:\n\n${exactDraft}`);
      expect(result.content.indexOf("Reply opportunity")).toBeLessThan(result.content.indexOf(exactDraft));
    } finally {
      database.close();
    }
  });

  it.each([
    { request: "Draft a reply", bareCopy: false },
    { request: "Reply text only", bareCopy: true },
  ])("does not duplicate an auto-staged reply draft for '$request'", async ({ request, bareCopy }) => {
    const database = new ExyDatabase(":memory:");
    try {
      let listener: ((event: any) => void) | undefined;
      let runtime!: ExyAgentRuntime;
      const exactDraft = "Ship the useful version, then listen.";
      const session = {
        isStreaming: false,
        reload: vi.fn(async () => undefined),
        subscribe: vi.fn((next: (event: any) => void) => {
          listener = next;
          return () => undefined;
        }),
        prompt: vi.fn(async () => {
          (runtime as unknown as {
            stageReplyOpportunity(
              threadId: string,
              scope: { discordUserId: string; xAccountId: string },
              sessionId: string,
              input: { post: string; rationale: string; suggestedReply: string },
            ): unknown;
          }).stageReplyOpportunity(
            record.threadId,
            { discordUserId: record.discordUserId, xAccountId: record.xAccountId },
            record.sessionId,
            {
              post: "1900123456789012346",
              rationale: "Selected as the target for this reply draft.",
              suggestedReply: exactDraft,
            },
          );
          listener?.({
            type: "tool_execution_end",
            toolName: "spawn_writing_subagent",
            isError: false,
            result: {
              content: [{ type: "text", text: JSON.stringify({ stored: true, exactContent: exactDraft }) }],
            },
          });
        }),
        abort: vi.fn(async () => undefined),
      };
      runtime = new ExyAgentRuntime({
        threads: { touch: vi.fn() },
        drafts: {},
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        verifier: new ReplyOpportunityVerifier(database),
      } as never);
      const api = runtime as unknown as RuntimeProgressApi;
      api.getOrCreateSession = vi.fn(async () => ({
        session,
        record,
        preference: { provider: "openai-codex", modelId: "model", reasoning: "low" },
      }));
      api.synchronizeSessionPreference = vi.fn(async () => undefined);
      api.recallMemory = vi.fn(async () => "");

      const result = await api.runTurnExclusive({
        threadId: record.threadId,
        content: request,
        signal: new AbortController().signal,
        onProgress: async () => undefined,
      });

      if (bareCopy) {
        expect(result.content).toBe(exactDraft);
      } else {
        expect(result.content).toContain("Reply opportunity");
        expect(result.content.split(exactDraft)).toHaveLength(2);
        expect(result.content).not.toContain("I'd post this:");
      }
    } finally {
      database.close();
    }
  });

  it("suppresses pre-writer prose and renders the delegated draft deterministically", async () => {
    let listener: ((event: any) => void) | undefined;
    const exactDraft = "Build trust before you chase reach.";
    const session = {
      isStreaming: false,
      reload: vi.fn(async () => undefined),
      subscribe: vi.fn((next: (event: any) => void) => {
        listener = next;
        return () => undefined;
      }),
      prompt: vi.fn(async () => {
        listener?.({ type: "message_start", message: { role: "assistant", content: [] } });
        listener?.({
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta: "Absolutely—I’ll keep it concise." },
        });
        listener?.({
          type: "message_end",
          message: {
            role: "assistant",
            content: [
              { type: "text", text: "Absolutely—I’ll keep it concise." },
              { type: "toolCall", name: "spawn_writing_subagent", arguments: { kind: "original", userRequest: "Draft a concise post" } },
            ],
          },
        });
        listener?.({
          type: "tool_execution_start",
          toolName: "spawn_writing_subagent",
          args: { kind: "original", userRequest: "Draft a concise post" },
        });
        listener?.({
          type: "tool_execution_end",
          toolName: "spawn_writing_subagent",
          isError: false,
          result: {
            content: [{ type: "text", text: JSON.stringify({ stored: true, exactContent: exactDraft }) }],
          },
        });
        listener?.({ type: "message_start", message: { role: "assistant", content: [] } });
        listener?.({
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta: `I'd post this:\n\n${exactDraft}` },
        });
      }),
      abort: vi.fn(async () => undefined),
    };
    const runtime = new ExyAgentRuntime({
      threads: { touch: vi.fn() },
      drafts: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      verifier: {},
    } as never) as unknown as RuntimeProgressApi;
    runtime.getOrCreateSession = vi.fn(async () => ({
      session,
      record,
      preference: { provider: "openai-codex", modelId: "model", reasoning: "low" },
    }));
    runtime.synchronizeSessionPreference = vi.fn(async () => undefined);
    runtime.recallMemory = vi.fn(async () => "");

    const progress: AgentProgressEvent[] = [];
    const result = await runtime.runTurnExclusive({
      threadId: "thread-1",
      content: "Draft a concise post",
      signal: new AbortController().signal,
      onProgress: async (event) => {
        progress.push(event);
      },
    });

    expect(progress).toEqual([
      { type: "tool_status", message: "Drafting with your writing specialist" },
    ]);
    expect(result.content).toBe(`I'd post this:\n\n${exactDraft}`);
    expect(`${progress.map((event) => event.message).join("\n")}\n${result.content}`)
      .not.toMatch(/approval|EXY_APPROVAL|draft id/iu);
  });
});
