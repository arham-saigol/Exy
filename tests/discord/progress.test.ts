import { describe, expect, it, vi } from "vitest";

import { DiscordProgressStream } from "../../src/discord/progress.js";

function harness(options: { failSends?: number } = {}) {
  const messages: string[] = [];
  let remainingFailures = options.failSends ?? 0;
  const warn = vi.fn();
  const stream = new DiscordProgressStream({
    send: async (content) => {
      if (remainingFailures > 0) {
        remainingFailures -= 1;
        throw new Error("Discord unavailable");
      }
      messages.push(content);
    },
  }, { warn });
  return { stream, messages, warn };
}

describe("DiscordProgressStream", () => {
  it("preserves complete assistant messages and sanitized status order", async () => {
    const { stream, messages } = harness();

    await Promise.all([
      stream.handle({ type: "assistant_text", message: "Absolutely—I’ll draft that." }),
      stream.handle({ type: "tool_status", message: "Searching X" }),
      stream.handle({ type: "tool_status", message: "Reading a web page" }),
      stream.handle({ type: "tool_status", message: "Saving this for later" }),
    ]);
    await stream.finish();

    expect(messages).toEqual([
      "Absolutely—I’ll draft that.",
      "*Searching X…*",
      "*Reading a web page…*",
      "*Saving this for later…*",
    ]);
  });

  it("isolates Discord status errors and continues later events", async () => {
    const { stream, messages, warn } = harness({ failSends: 1 });

    await expect(stream.handle({ type: "tool_status", message: "Searching the web" }))
      .resolves.toBeUndefined();
    await stream.handle({ type: "tool_status", message: "Reading a web page" });
    await expect(stream.finish()).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledOnce();
    expect(messages).toEqual(["*Reading a web page…*"]);
  });

  it("ignores late events after the stream is finished", async () => {
    const { stream, messages } = harness();

    await stream.handle({ type: "tool_status", message: "Searching X" });
    await stream.finish();
    await stream.handle({ type: "tool_status", message: "Must not be sent" });

    expect(messages).toEqual(["*Searching X…*"]);
  });
});
