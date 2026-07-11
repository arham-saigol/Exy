import { afterEach, describe, expect, it, vi } from "vitest";

import { createExyTools } from "../../src/agent/tools.js";
import type { StageReplyOpportunityResult } from "../../src/agent/tools.js";
import { formatPreparedPublication, formatPublicationOutcome } from "../../src/agent/runtime.js";
import { guardUnconfirmedPublicationClaims, guardUnverifiedXPostUrls } from "../../src/agent/output-guard.js";
import { PublicationApprovalRepository } from "../../src/db/approvals.js";
import { CandidateMappingRepository } from "../../src/db/candidates.js";
import { ExyDatabase } from "../../src/db/database.js";
import { ExaClient } from "../../src/providers/exa.js";
import { SupermemoryClient } from "../../src/providers/supermemory.js";
import { XquikClient } from "../../src/providers/xquik.js";
import { ZernioClient } from "../../src/providers/zernio.js";
import type { FetchLike } from "../../src/providers/http.js";
import { ReplyOpportunityVerifier } from "../../src/verifier/reply-verifier.js";

const databases: ExyDatabase[] = [];
afterEach(() => databases.splice(0).forEach((database) => database.close()));

function toolJson(result: unknown): Record<string, unknown> {
  const content = (result as { content: Array<{ type: string; text?: string }> }).content;
  return JSON.parse(content.find((item) => item.type === "text")?.text ?? "{}") as Record<string, unknown>;
}

function dependencies(options: { dryRun?: boolean; analytics?: boolean; zernioFetch?: FetchLike } = {}) {
  const database = new ExyDatabase(":memory:");
  databases.push(database);
  const scope = { discordUserId: "discord-user", xAccountId: "x-account" };
  const approvals = new PublicationApprovalRepository(database);
  const stageReplyOpportunity = vi.fn((): StageReplyOpportunityResult => ({
    status: "staged",
    presented: true,
    alreadyRecommended: false,
    pendingDelivery: false,
    canonicalUrl: "https://x.com/i/web/status/123",
    instruction: "reserved",
  }));
  const candidates = new CandidateMappingRepository(database);
  return {
    database,
    scope,
    approvals,
    candidates,
    stageReplyOpportunity,
    tools: createExyTools({
      scope,
      threadId: "thread",
      sessionId: "session",
      xquik: new XquikClient("xquik-key"),
      zernio: new ZernioClient("zernio-key", options.zernioFetch ? { fetch: options.zernioFetch } : {}),
      exa: new ExaClient("exa-key"),
      supermemory: new SupermemoryClient("supermemory-key"),
      candidates,
      approvals,
      xAccountLabel: "@configured",
      stageReplyOpportunity,
      dryRunPublishing: options.dryRun ?? false,
    }),
  };
}

describe("focused Exy tools", () => {
  it("stages a direct reply opportunity without persisting it during the tool call", async () => {
    const deps = dependencies();
    const tool = deps.tools.find((candidate) => candidate.name === "recommend_reply_opportunity")!;
    const result = await tool.execute("call", {
      post: "https://m.twitter.com/alice/statuses/123",
      rationale: "Relevant audience overlap",
    } as never, undefined, undefined, undefined as never);

    expect(toolJson(result)).toMatchObject({ presented: true, url: "https://x.com/i/web/status/123" });
    expect(deps.stageReplyOpportunity).toHaveBeenCalledOnce();
    expect(deps.database.connection.prepare("SELECT count(*) AS count FROM reply_recommendations").get())
      .toMatchObject({ count: 0 });
  });

  it("consumes an exact approval in dry-run mode without calling Zernio", async () => {
    const deps = dependencies({ dryRun: true });
    const prepared = deps.approvals.prepare({
      ...deps.scope,
      kind: "original",
      payload: { kind: "original", content: "Exact dry-run post", accountId: deps.scope.xAccountId },
    });
    deps.approvals.approve(prepared.approval.id, prepared.approvalToken, deps.scope);
    const tool = deps.tools.find((candidate) => candidate.name === "publish_approved_x")!;
    const result = await tool.execute("call", { approvalId: prepared.approval.id } as never, undefined, undefined, undefined as never);

    expect(toolJson(result)).toMatchObject({ confirmed: false, providerStatus: "dry_run" });
    expect(deps.approvals.get(prepared.approval.id)?.state).toBe("consumed");
  });

  it.each([false, true])("exposes and scopes Zernio account tools when analytics sync is %s", async (analytics) => {
    const requests: URL[] = [];
    const configuredAccountId = "x-account";
    const deps = dependencies({
      analytics,
      zernioFetch: async (input) => {
        const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
        requests.push(url);
        if (url.pathname.endsWith("/accounts")) {
          return new Response(JSON.stringify({
            accounts: [
              { _id: "another-account", platform: "twitter", username: "@another" },
              { _id: configuredAccountId, platform: "twitter", username: "@configured" },
            ],
            hasAnalyticsAccess: analytics,
          }), { status: 200 });
        }
        if (url.pathname.endsWith(`/accounts/${configuredAccountId}/health`)) {
          return new Response(JSON.stringify({ accountId: configuredAccountId, status: "healthy" }), { status: 200 });
        }
        if (url.pathname.endsWith("/analytics")) {
          return new Response(JSON.stringify({ posts: [], pagination: { page: 2, pages: 2 } }), { status: 200 });
        }
        return new Response(JSON.stringify({ posts: [], pagination: { page: 3, pages: 4 } }), { status: 200 });
      },
    });
    const names = deps.tools.map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining(["inspect_x_account", "inspect_x_analytics", "list_x_post_history"]));

    const accountResult = toolJson(await deps.tools.find((tool) => tool.name === "inspect_x_account")!
      .execute("account", {} as never, undefined, undefined, undefined as never));
    await deps.tools.find((tool) => tool.name === "inspect_x_analytics")!
      .execute("analytics", { mode: "posts", page: 2, limit: 25 } as never, undefined, undefined, undefined as never);
    await deps.tools.find((tool) => tool.name === "inspect_x_analytics")!
      .execute("followers", {
        mode: "followers",
        fromDate: "2026-06-01",
        toDate: "2026-07-01",
      } as never, undefined, undefined, undefined as never);
    await deps.tools.find((tool) => tool.name === "list_x_post_history")!
      .execute("posts", { page: 3, limit: 15, source: "external" } as never, undefined, undefined, undefined as never);

    const accountRequest = requests.find((url) => url.pathname.endsWith("/accounts"))!;
    const healthRequest = requests.find((url) => url.pathname.endsWith("/health"))!;
    const analyticsRequest = requests.find((url) => url.pathname.endsWith("/analytics"))!;
    const followersRequest = requests.find((url) => url.pathname.endsWith("/follower-stats"))!;
    const postsRequest = requests.find((url) => url.pathname.endsWith("/posts"))!;
    expect(accountResult).toMatchObject({ account: { _id: configuredAccountId } });
    expect(JSON.stringify(accountResult)).not.toContain("another-account");
    expect(accountRequest.searchParams.get("platform")).toBe("twitter");
    expect(healthRequest.pathname).toContain(`/accounts/${configuredAccountId}/health`);
    expect(analyticsRequest.searchParams.get("accountId")).toBe(configuredAccountId);
    expect(analyticsRequest.searchParams.get("page")).toBe("2");
    expect(followersRequest.searchParams.get("accountIds")).toBe(configuredAccountId);
    expect(postsRequest.searchParams.get("accountId")).toBe(configuredAccountId);
    expect(postsRequest.searchParams.get("page")).toBe("3");
    expect(postsRequest.searchParams.get("source")).toBe("external");
  });

  it("does not expose another Zernio account when the configured account is unavailable", async () => {
    const deps = dependencies({
      zernioFetch: async () => new Response(JSON.stringify({
        accounts: [{ _id: "another-account", platform: "twitter" }],
        pagination: { page: 1, pages: 1 },
      }), { status: 200 }),
    });
    const tool = deps.tools.find((candidate) => candidate.name === "inspect_x_account")!;

    await expect(tool.execute("account", {} as never, undefined, undefined, undefined as never))
      .rejects.toThrow("configured X account is not available");
  });

  it("marks an original-post draft without touching the reply verifier", async () => {
    const deps = dependencies();
    const tool = deps.tools.find((candidate) => candidate.name === "render_original_post_draft")!;
    const result = await tool.execute("call", {
      content: "An original draft linking https://x.com/i/status/123",
    } as never, undefined, undefined, undefined as never);
    expect(toolJson(result)).toMatchObject({ kind: "original_draft", published: false });
    expect(deps.database.connection.prepare("SELECT count(*) AS count FROM reply_recommendations").get())
      .toMatchObject({ count: 0 });
  });

  it("stages a searched reply target when preparation is called directly", async () => {
    const deps = dependencies({
      zernioFetch: async () => new Response(JSON.stringify({ valid: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    });
    deps.candidates.put({
      sessionId: "session",
      candidateRef: "xc_target",
      postId: "1900123456789012345",
      canonicalUrl: "https://x.com/i/web/status/1900123456789012345",
      candidate: { candidateRef: "xc_target", text: "Candidate text", metrics: {} },
    });
    const tool = deps.tools.find((candidate) => candidate.name === "prepare_x_publication")!;
    const result = await tool.execute("call", {
      kind: "reply",
      content: "Exact proposed reply",
      candidateRef: "xc_target",
    } as never, undefined, undefined, undefined as never);

    expect(toolJson(result)).toMatchObject({
      prepared: true,
      target: "https://x.com/i/web/status/1900123456789012345",
    });
    expect(deps.stageReplyOpportunity).toHaveBeenCalledWith(expect.objectContaining({
      post: "1900123456789012345",
      suggestedReply: "Exact proposed reply",
    }));
  });

  it("does not prepare a reply target reserved by another delivery", async () => {
    const deps = dependencies({
      zernioFetch: async () => new Response(JSON.stringify({ valid: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    });
    deps.candidates.put({
      sessionId: "session",
      candidateRef: "xc_pending",
      postId: "1900123456789012346",
      canonicalUrl: "https://x.com/i/web/status/1900123456789012346",
      candidate: { candidateRef: "xc_pending", text: "Candidate text", metrics: {} },
    });
    deps.stageReplyOpportunity.mockReturnValue({
      status: "pending_delivery",
      presented: false,
      alreadyRecommended: false,
      pendingDelivery: true,
      canonicalUrl: "https://x.com/i/web/status/1900123456789012346",
      instruction: "pending elsewhere",
    });
    const tool = deps.tools.find((candidate) => candidate.name === "prepare_x_publication")!;
    const result = toolJson(await tool.execute("call", {
      kind: "reply",
      content: "Exact proposed reply",
      candidateRef: "xc_pending",
    } as never, undefined, undefined, undefined as never));

    expect(result).toMatchObject({ prepared: false, verifierPending: true });
    expect(result).not.toHaveProperty("target");
    expect(deps.database.connection.prepare("SELECT count(*) AS count FROM publication_approvals").get())
      .toMatchObject({ count: 0 });
  });

  it("prepares a direct verified reply URL without an ephemeral Xquik mapping", async () => {
    const deps = dependencies({
      zernioFetch: async () => new Response(JSON.stringify({ valid: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    });
    const tool = deps.tools.find((candidate) => candidate.name === "prepare_x_publication")!;
    const result = toolJson(await tool.execute("call", {
      kind: "reply",
      content: "Reply after a process restart",
      post: "https://mobile.twitter.com/alice/statuses/1900123456789012347?s=20",
    } as never, undefined, undefined, undefined as never));

    expect(result).toMatchObject({
      prepared: true,
      target: "https://x.com/i/web/status/1900123456789012347",
    });
    expect(deps.stageReplyOpportunity).toHaveBeenCalledWith(expect.objectContaining({
      post: "1900123456789012347",
      suggestedReply: "Reply after a process restart",
    }));
    expect(deps.approvals.get(result.approvalId as string)).toMatchObject({
      kind: "reply",
      targetPostId: "1900123456789012347",
    });
  });
});

describe("gateway-rendered publication messages", () => {
  it("never turns an unconfirmed provider result into a success claim", () => {
    expect(formatPublicationOutcome({
      confirmed: false,
      providerStatus: "pending",
      providerRecordId: "record-1",
      message: "Zernio has not published the target yet.",
      providerPostUrl: "https://x.com/i/status/123",
    })).toBe([
      "Publication was not confirmed.",
      "Provider status: pending",
      "Provider record: record-1",
      "Zernio has not published the target yet.",
    ].join("\n"));
  });

  it("renders the exact prepared content, target, expiry, and approval command", () => {
    const rendered = formatPreparedPublication({
      prepared: true,
      exactContent: "A precise post",
      target: "new original X post",
      account: "@configured",
      expiresAt: "2026-07-11T01:00:00.000Z",
      approvalCode: "EXY_APPROVAL:id:token",
    });
    expect(rendered).toContain("A precise post");
    expect(rendered).toContain("new original X post");
    expect(rendered).toContain("@configured");
    expect(rendered).toContain("2026-07-11T01:00:00.000Z");
    expect(rendered).toContain("approve EXY_APPROVAL:id:token");
    expect(rendered).toContain("not published");
  });

  it("does not corrupt exact prepared content that resembles a success claim", () => {
    const exactContent = "Tweet published\r\nDone - it's live on X\r\nPosted!";
    const rendered = formatPreparedPublication({
      prepared: true,
      exactContent,
      target: "new original X post",
      expiresAt: "2026-07-11T01:00:00.000Z",
      approvalCode: "EXY_APPROVAL:id:token",
    });
    expect(guardUnconfirmedPublicationClaims(
      rendered,
      false,
      { preserveFencedContent: true },
    )).toContain(exactContent);
  });

  it("does not corrupt X-looking text inside exact prepared content", () => {
    const deps = dependencies();
    const exactContent = `Keep these bytes: https://x.com/a/status/0 and https://x.com/a/status/${"1".repeat(41)}`;
    const rendered = formatPreparedPublication({
      prepared: true,
      exactContent,
      target: "new original X post",
      expiresAt: "2026-07-11T01:00:00.000Z",
      approvalCode: "EXY_APPROVAL:id:token",
    });
    const guarded = guardUnverifiedXPostUrls(
      rendered,
      deps.scope,
      new ReplyOpportunityVerifier(deps.database),
      new Set(),
      { preserveFencedContent: true },
    );
    expect(guarded).toContain(exactContent);
  });
});
