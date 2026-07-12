import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DiscordProgressStream,
  type DiscordProgressMessage,
} from "../../src/discord/progress.js";

interface RecordedMessage extends DiscordProgressMessage {
  content: string;
}

function harness(options: { failSends?: number } = {}) {
  const messages: RecordedMessage[] = [];
  const events: string[] = [];
  let remainingFailures = options.failSends ?? 0;
  const warn = vi.fn();
  const stream = new DiscordProgressStream({
    send: async (content) => {
      events.push(`send:${content}`);
      if (remainingFailures > 0) {
        remainingFailures -= 1;
        throw new Error("Discord unavailable");
      }
      const message: RecordedMessage = {
        content,
        edit: async (next) => {
          events.push(`edit:${next}`);
          message.content = next;
        },
      };
      messages.push(message);
      return message;
    },
  }, { warn }, { updateIntervalMilliseconds: 10 });
  return { stream, messages, events, warn };
}

afterEach(() => vi.useRealTimers());

describe("DiscordProgressStream", () => {
  it("preserves assistant/tool order and batches rapid assistant deltas", async () => {
    const { stream, messages, events } = harness();

    await stream.handle({ type: "assistant_text", delta: "I’ll check " });
    await stream.handle({ type: "assistant_text", delta: "that." });
    await stream.handle({ type: "tool_status", message: "Searching X" });
    await stream.handle({ type: "assistant_text", delta: "I found it." });
    await stream.finish();

    expect(messages.map((message) => message.content)).toEqual([
      "I’ll check that.",
      "*Searching X…*",
      "I found it.",
    ]);
    expect(events).toEqual([
      "send:I’ll check that.",
      "send:*Searching X…*",
      "send:I found it.",
    ]);
  });

  it("edits a live assistant message instead of duplicating it", async () => {
    vi.useFakeTimers();
    const { stream, messages, events } = harness();

    await stream.handle({ type: "assistant_text", delta: "Hello" });
    await vi.advanceTimersByTimeAsync(10);
    await stream.handle({ type: "assistant_text", delta: " world" });
    await vi.advanceTimersByTimeAsync(10);
    await stream.finish();

    expect(messages).toHaveLength(1);
    expect(messages[0]?.content).toBe("Hello world");
    expect(events).toEqual(["send:Hello", "edit:Hello world"]);
  });

  it("splits long progress without loss or over-limit messages", async () => {
    const { stream, messages } = harness();
    const text = `${"a".repeat(2_000)}${"b".repeat(2_000)}${"😀".repeat(250)}`;

    await stream.handle({ type: "assistant_text", delta: text });
    await stream.finish();

    expect(messages.every((message) => message.content.length <= 2_000)).toBe(true);
    expect(messages.map((message) => message.content).join("")).toBe(text);
  });

  it("isolates Discord progress errors and continues later events", async () => {
    const { stream, messages, warn } = harness({ failSends: 1 });

    await expect(stream.handle({ type: "tool_status", message: "Searching the web" }))
      .resolves.toBeUndefined();
    await stream.handle({ type: "assistant_text", delta: "Still working." });
    await expect(stream.finish()).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledOnce();
    expect(messages.map((message) => message.content)).toEqual(["Still working."]);
  });
});
