import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { PublicationApprovalRepository } from "../../src/db/approvals.js";
import { ExyDatabase } from "../../src/db/database.js";
import { KeyValueRepository, ModelPreferenceRepository } from "../../src/db/state.js";
import { DiscordThreadRepository, SqliteDiscordThreadStore } from "../../src/db/threads.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "exy-state-"));
  temporaryDirectories.push(directory);
  return join(directory, "state.sqlite");
}

describe("persistent state", () => {
  it("retains key-values and model preferences across reopen", () => {
    const path = databasePath();
    const scope = { discordUserId: "u", xAccountId: "x" };
    const database = new ExyDatabase(path);
    new KeyValueRepository(database).set("gateway.restart-count", 3);
    new ModelPreferenceRepository(database).set(scope, {
      provider: "openai-codex",
      modelId: "account-returned-id",
      reasoning: "high",
    });
    database.close();

    const reopened = new ExyDatabase(path);
    expect(new KeyValueRepository(reopened).get("gateway.restart-count")).toBe(3);
    expect(new ModelPreferenceRepository(reopened).get(scope)).toEqual({
      provider: "openai-codex",
      modelId: "account-returned-id",
      reasoning: "high",
    });
    expect(reopened.connection.prepare("SELECT count(*) AS count FROM schema_migrations").get())
      .toMatchObject({ count: 2 });
    reopened.close();
  });

  it("keeps separate agent sessions for separate Discord threads", () => {
    const database = new ExyDatabase(databasePath());
    const repository = new DiscordThreadRepository(database, () => 10);
    const common = {
      guildId: "g",
      parentChannelId: "parent",
      discordUserId: "u",
      xAccountId: "x",
    };
    const first = repository.register({ ...common, threadId: "t1", parentMessageId: "m1" });
    const second = repository.register({ ...common, threadId: "t2", parentMessageId: "m2" });
    expect(first.sessionId).not.toBe(second.sessionId);
    expect(repository.findByThreadId("t1")?.sessionId).toBe(first.sessionId);
    database.close();
  });

  it("atomically claims a Discord starter and activates the route", async () => {
    const database = new ExyDatabase(databasePath());
    const store = new SqliteDiscordThreadStore(database, "x-account");
    const claim = {
      threadId: "thread",
      starterMessageId: "starter",
      guildId: "guild",
      parentChannelId: "parent",
      authorizedUserId: "user",
      claimedAt: "2026-07-11T00:00:00.000Z",
    };
    await expect(store.claim(claim)).resolves.toBe(true);
    await expect(store.claim(claim)).resolves.toBe(false);
    await expect(store.listCreating()).resolves.toEqual([
      expect.objectContaining({ threadId: "thread", status: "creating" }),
    ]);
    await store.activate({ ...claim, status: "active", activatedAt: "2026-07-11T00:00:01.000Z" });
    await expect(store.listCreating()).resolves.toEqual([]);
    await expect(store.get("thread")).resolves.toMatchObject({ status: "active" });
    database.close();
  });

  it("does not route a persisted thread after the configured X account changes", async () => {
    const database = new ExyDatabase(databasePath());
    const oldAccountStore = new SqliteDiscordThreadStore(database, "old-x-account");
    const claim = {
      threadId: "thread",
      starterMessageId: "thread",
      guildId: "guild",
      parentChannelId: "parent",
      authorizedUserId: "user",
      claimedAt: "2026-07-11T00:00:00.000Z",
    };
    await oldAccountStore.claim(claim);
    await oldAccountStore.activate({ ...claim, status: "active", activatedAt: "2026-07-11T00:00:01.000Z" });

    const newAccountStore = new SqliteDiscordThreadStore(database, "new-x-account");
    await expect(newAccountStore.get("thread")).resolves.toBeUndefined();
    await expect(oldAccountStore.get("thread")).resolves.toMatchObject({ status: "active" });
    database.close();
  });
});

describe("publication approvals", () => {
  it("requires its explicit token and can be consumed only once", () => {
    let now = 1_000;
    const database = new ExyDatabase(databasePath());
    const approvals = new PublicationApprovalRepository(database, () => now);
    const scope = { discordUserId: "u", xAccountId: "x" };
    const prepared = approvals.prepare({
      ...scope,
      kind: "reply",
      targetPostId: "123",
      payload: { text: "specific approved reply" },
      ttlMs: 10_000,
    });
    expect(prepared.approval.state).toBe("prepared");
    expect(() => approvals.approve(prepared.approval.id, prepared.approvalToken, {
      discordUserId: "another-user",
      xAccountId: "x",
    })).toThrow(/another account scope/i);
    expect(() => approvals.approve(prepared.approval.id, "wrong", scope)).toThrow(/token/i);
    expect(approvals.approve(prepared.approval.id, prepared.approvalToken, scope).state).toBe("approved");
    now += 1;
    const consumed = approvals.consume(prepared.approval.id, scope);
    expect(consumed.state).toBe("consumed");
    expect(consumed.payload).toEqual({ text: "specific approved reply" });
    expect(() => approvals.consume(prepared.approval.id, scope)).toThrow(/consumed/i);
    database.close();
  });

  it("commits the expired state while rejecting approval", () => {
    let now = 1_000;
    const database = new ExyDatabase(databasePath());
    const approvals = new PublicationApprovalRepository(database, () => now);
    const scope = { discordUserId: "u", xAccountId: "x" };
    const prepared = approvals.prepare({
      ...scope,
      kind: "original",
      payload: { text: "draft" },
      ttlMs: 1_000,
    });
    now = 2_000;
    expect(() => approvals.approve(prepared.approval.id, prepared.approvalToken, scope)).toThrow(/expired/i);
    expect(approvals.get(prepared.approval.id)?.state).toBe("expired");
    database.close();
  });

  it("binds a provider record to exactly one consumed approval and scope", () => {
    const database = new ExyDatabase(databasePath());
    const approvals = new PublicationApprovalRepository(database);
    const scope = { discordUserId: "u", xAccountId: "x" };
    const prepared = approvals.prepare({ ...scope, kind: "original", payload: { text: "post" } });
    approvals.approve(prepared.approval.id, prepared.approvalToken, scope);
    approvals.consume(prepared.approval.id, scope);
    expect(approvals.recordProviderAttempt(prepared.approval.id, scope, {
      providerRecordId: "zernio-record-1",
      providerStatus: "pending",
      confirmed: false,
    })).toMatchObject({ providerRecordId: "zernio-record-1", confirmed: false });
    expect(approvals.recordProviderAttempt(prepared.approval.id, scope, {
      providerRecordId: "zernio-record-1",
      providerStatus: "published",
      confirmed: true,
    })).toMatchObject({ providerStatus: "published", confirmed: true });
    expect(() => approvals.recordProviderAttempt(prepared.approval.id, scope, {
      providerRecordId: "another-record",
      providerStatus: "published",
      confirmed: true,
    })).toThrow(/does not match/i);
    expect(() => approvals.getProviderAttempt(prepared.approval.id, { discordUserId: "u", xAccountId: "other" }))
      .toThrow(/another account scope/i);
    database.close();
  });
});
