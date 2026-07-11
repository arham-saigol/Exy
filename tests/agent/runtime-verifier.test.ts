import { afterEach, describe, expect, it, vi } from "vitest";

import { ExyAgentRuntime } from "../../src/agent/runtime.js";
import type { StageReplyOpportunityResult } from "../../src/agent/tools.js";
import type { Scope } from "../../src/core/types.js";
import { ExyDatabase } from "../../src/db/database.js";
import { ReplyOpportunityVerifier } from "../../src/verifier/reply-verifier.js";

const databases: ExyDatabase[] = [];
afterEach(() => databases.splice(0).forEach((database) => database.close()));

interface RuntimeStageApi {
  beginRecommendationTurn(threadId: string): unknown;
  stageReplyOpportunity(
    threadId: string,
    scope: Scope,
    sessionId: string,
    input: { post: string; rationale: string },
  ): StageReplyOpportunityResult;
}

describe("runtime reply recommendation reservations", () => {
  it("distinguishes another thread's pending delivery and allows retry after release", () => {
    const database = new ExyDatabase(":memory:");
    databases.push(database);
    const runtime = new ExyAgentRuntime({
      verifier: new ReplyOpportunityVerifier(database),
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as never) as unknown as RuntimeStageApi;
    const scope = { discordUserId: "user-1", xAccountId: "account-1" };
    runtime.beginRecommendationTurn("thread-a");
    runtime.beginRecommendationTurn("thread-b");

    expect(runtime.stageReplyOpportunity(
      "thread-a",
      scope,
      "session-a",
      { post: "https://x.com/alice/status/1900123456789012345", rationale: "fit" },
    ).status).toBe("staged");
    expect(runtime.stageReplyOpportunity(
      "thread-b",
      scope,
      "session-b",
      { post: "https://twitter.com/alice/status/1900123456789012345", rationale: "fit" },
    )).toMatchObject({
      status: "pending_delivery",
      presented: false,
      alreadyRecommended: false,
      pendingDelivery: true,
    });

    // Beginning a replacement turn releases thread A's undelivered reservation.
    runtime.beginRecommendationTurn("thread-a");
    expect(runtime.stageReplyOpportunity(
      "thread-b",
      scope,
      "session-b",
      { post: "1900123456789012345", rationale: "fit" },
    ).status).toBe("staged");
  });
});
