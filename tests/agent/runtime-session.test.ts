import { describe, expect, it, vi } from "vitest";

import { ExyAgentRuntime } from "../../src/agent/runtime.js";
import type { ModelPreference } from "../../src/core/types.js";
import type { DiscordThreadRecord } from "../../src/db/threads.js";

interface TestSession {
  isStreaming: boolean;
  abort: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
}

interface TestLiveSession {
  session: TestSession;
  record: DiscordThreadRecord;
  preference: ModelPreference;
}

interface RuntimeSessionApi {
  live: Map<string, TestLiveSession>;
  getOrCreateSession(threadId: string): Promise<TestLiveSession>;
  synchronizeSessionPreference(live: TestLiveSession): Promise<void>;
}

const preference: ModelPreference = {
  provider: "openai-codex",
  modelId: "model-1",
  reasoning: "medium",
};

function record(archived = false): DiscordThreadRecord {
  return {
    threadId: "thread-1",
    guildId: "guild-1",
    parentChannelId: "parent-1",
    parentMessageId: "message-1",
    sessionId: "session-1",
    discordUserId: "user-1",
    xAccountId: "account-1",
    archived,
    createdAt: 1,
    lastActivityAt: 1,
  };
}

function live(session: TestSession, archived = false): TestLiveSession {
  return { session, record: record(archived), preference };
}

describe("runtime live-session eviction", () => {
  it("evicts and disposes a cached session after its thread is archived", async () => {
    const session: TestSession = {
      isStreaming: true,
      abort: vi.fn(async () => { throw new Error("abort failed"); }),
      dispose: vi.fn(),
    };
    const runtime = new ExyAgentRuntime({
      threads: { findByThreadId: vi.fn(() => record(true)) },
    } as never) as unknown as RuntimeSessionApi;
    runtime.live.set("thread-1", live(session));

    await expect(runtime.getOrCreateSession("thread-1"))
      .rejects.toThrow("This Discord thread is not an active Exy conversation");
    expect(runtime.live.has("thread-1")).toBe(false);
    expect(session.abort).toHaveBeenCalledOnce();
    expect(session.dispose).toHaveBeenCalledOnce();
  });

  it("evicts and disposes a cached session after a scope mismatch", async () => {
    const session: TestSession = {
      isStreaming: false,
      abort: vi.fn(),
      dispose: vi.fn(),
    };
    const cached = live(session);
    const runtime = new ExyAgentRuntime({
      configStore: {
        readConfig: vi.fn(async () => ({
          version: 1,
          discord: {
            applicationId: "app-1",
            guildId: "guild-1",
            parentChannelId: "parent-1",
            authorizedUserId: "different-user",
          },
          providers: { zernioAccountId: "account-1", zernioXAnalyticsEnabled: false },
          heartbeat: { enabled: false, intervalMinutes: 30 },
          model: preference,
        })),
      },
    } as never) as unknown as RuntimeSessionApi;
    runtime.live.set("thread-1", cached);

    await expect(runtime.synchronizeSessionPreference(cached))
      .rejects.toThrow("This Exy thread belongs to a previous user");
    expect(runtime.live.has("thread-1")).toBe(false);
    expect(session.abort).not.toHaveBeenCalled();
    expect(session.dispose).toHaveBeenCalledOnce();
  });
});
