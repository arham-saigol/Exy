import { describe, expect, it, vi } from "vitest";

import { ExyAgentRuntime } from "../../src/agent/runtime.js";
import type { AgentProgressEvent } from "../../src/core/progress.js";
import type { DiscordThreadRecord } from "../../src/db/threads.js";

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

  it("keeps acknowledgement and framed draft text from separate assistant messages", async () => {
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
              { type: "toolCall", name: "save_x_draft", arguments: { kind: "original", content: exactDraft } },
            ],
          },
        });
        listener?.({
          type: "tool_execution_start",
          toolName: "save_x_draft",
          args: { kind: "original", content: exactDraft },
        });
        listener?.({
          type: "tool_execution_end",
          toolName: "save_x_draft",
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
      { type: "assistant_text", message: "Absolutely—I’ll keep it concise." },
      { type: "tool_status", message: "Saving your X draft" },
    ]);
    expect(result.content).toBe(`I'd post this:\n\n${exactDraft}`);
    expect(`${progress.map((event) => event.message).join("\n")}\n${result.content}`)
      .not.toMatch(/approval|EXY_APPROVAL|draft id/iu);
  });
});
