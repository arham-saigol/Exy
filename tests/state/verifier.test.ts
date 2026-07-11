import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ExyDatabase } from "../../src/db/database.js";
import { CandidateMappingRepository } from "../../src/db/candidates.js";
import { canonicalizeXPost } from "../../src/verifier/canonicalize.js";
import { ReplyOpportunityVerifier } from "../../src/verifier/reply-verifier.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "exy-verifier-"));
  temporaryDirectories.push(directory);
  return join(directory, "state.sqlite");
}

describe("canonicalizeXPost", () => {
  it.each([
    "1234567890123456789",
    "https://x.com/alice/status/1234567890123456789",
    "http://www.twitter.com/alice/status/1234567890123456789?s=20",
    "https://mobile.twitter.com/alice/statuses/1234567890123456789#fragment",
    "https://mobile.x.com/i/web/status/1234567890123456789/photo/1",
    "x.com/i/status/1234567890123456789",
  ])("maps %s to one opaque ID", (reference) => {
    expect(canonicalizeXPost(reference)).toEqual({
      postId: "1234567890123456789",
      canonicalUrl: "https://x.com/i/web/status/1234567890123456789",
    });
  });

  it("rejects lookalike hosts", () => {
    expect(() => canonicalizeXPost("https://x.com.example.test/a/status/123")).toThrow();
  });
});

describe("ReplyOpportunityVerifier", () => {
  it("keeps raw search candidate mappings process-local and non-durable", () => {
    const path = databasePath();
    const database = new ExyDatabase(path);
    const candidates = new CandidateMappingRepository(database);
    candidates.put({
      sessionId: "session",
      candidateRef: "opaque-ref",
      postId: "456",
      canonicalUrl: "https://x.com/i/web/status/456",
      candidate: { text: "raw result" },
    });
    expect(candidates.findByReference("session", "opaque-ref")?.postId).toBe("456");
    expect(database.connection
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'candidate_mappings'")
      .get()).toBeUndefined();
    database.close();

    const reopened = new ExyDatabase(path);
    expect(new CandidateMappingRepository(reopened).findByReference("session", "opaque-ref")).toBeUndefined();
    expect(reopened.connection.prepare("SELECT count(*) AS count FROM reply_recommendations").get())
      .toMatchObject({ count: 0 });
    reopened.close();
  });

  it("does not write raw search inspections and deduplicates alternate URLs", () => {
    const database = new ExyDatabase(databasePath());
    const verifier = new ReplyOpportunityVerifier(database, () => 1_000);
    const scope = { discordUserId: "discord-1", xAccountId: "x-1" };

    expect(verifier.inspect(scope, "https://twitter.com/a/status/123?s=20").alreadyRecommended).toBe(false);
    const countAfterSearch = database.connection
      .prepare("SELECT count(*) AS count FROM reply_recommendations")
      .get() as { count: number };
    expect(countAfterSearch.count).toBe(0);

    const first = verifier.present({ ...scope, post: "https://twitter.com/a/status/123?s=20" });
    expect(first.presented).toBe(true);

    const duplicate = verifier.present({ ...scope, post: "https://mobile.x.com/i/web/status/123#x" });
    expect(duplicate.presented).toBe(false);
    expect(duplicate.alreadyRecommended).toBe(true);
    expect(duplicate.instruction).toContain("Do not present it as a new reply opportunity");
    expect(verifier.list(scope)).toHaveLength(1);
    database.close();
  });

  it("persists deduplication across process/database restarts", () => {
    const path = databasePath();
    const scope = { discordUserId: "discord-1", xAccountId: "x-1" };
    const firstDatabase = new ExyDatabase(path);
    new ReplyOpportunityVerifier(firstDatabase).present({
      ...scope,
      post: "https://x.com/a/status/999",
    });
    firstDatabase.close();

    const reopened = new ExyDatabase(path);
    const result = new ReplyOpportunityVerifier(reopened).present({
      ...scope,
      post: "https://twitter.com/i/web/status/999?ref=alternate",
    });
    expect(result.presented).toBe(false);
    expect(reopened.connection.prepare("SELECT count(*) AS count FROM reply_recommendations").get())
      .toMatchObject({ count: 1 });
    reopened.close();
  });

  it("isolates records by Discord user and connected X account", () => {
    const database = new ExyDatabase(databasePath());
    const verifier = new ReplyOpportunityVerifier(database);
    expect(verifier.present({ discordUserId: "u1", xAccountId: "x1", post: "123" }).presented).toBe(true);
    expect(verifier.present({ discordUserId: "u1", xAccountId: "x2", post: "123" }).presented).toBe(true);
    expect(verifier.present({ discordUserId: "u2", xAccountId: "x1", post: "123" }).presented).toBe(true);
    database.close();
  });
});
