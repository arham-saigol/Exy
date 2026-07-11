import { describe, expect, it } from "vitest";

import { chunkDiscordMessage } from "../../src/discord/chunking.js";

describe("chunkDiscordMessage", () => {
  it("leaves a short message intact", () => {
    expect(chunkDiscordMessage("hello", 10)).toEqual(["hello"]);
  });

  it("prefers line and word boundaries without dropping text", () => {
    const text = "alpha beta\ngamma delta";
    const chunks = chunkDiscordMessage(text, 12);

    expect(chunks.join("")).toBe(text);
    expect(chunks.every((chunk) => chunk.length <= 12)).toBe(true);
  });

  it("hard-splits long tokens", () => {
    const text = "x".repeat(25);
    const chunks = chunkDiscordMessage(text, 10);

    expect(chunks).toEqual(["x".repeat(10), "x".repeat(10), "x".repeat(5)]);
  });

  it("does not split a surrogate pair", () => {
    const text = `1234🚀5678`;
    const chunks = chunkDiscordMessage(text, 5);

    expect(chunks.join("")).toBe(text);
    for (const chunk of chunks) {
      const first = chunk.charCodeAt(0);
      const last = chunk.charCodeAt(chunk.length - 1);
      expect(first >= 0xdc00 && first <= 0xdfff).toBe(false);
      expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
    }
  });

  it("rejects an invalid limit", () => {
    expect(() => chunkDiscordMessage("hello", 0)).toThrow(RangeError);
  });
});
