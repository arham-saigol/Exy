import { afterEach, describe, expect, it, vi } from "vitest";

import { createExyTools } from "../../src/agent/tools.js";
import type { StageReplyOpportunityResult } from "../../src/agent/tools.js";
import { formatPublicationOutcome } from "../../src/agent/runtime.js";
import { guardUnconfirmedPublicationClaims, guardUnverifiedXPostUrls } from "../../src/agent/output-guard.js";
import { CandidateMappingRepository } from "../../src/db/candidates.js";
import { ExyDatabase } from "../../src/db/database.js";
import { PublicationDraftRepository } from "../../src/db/drafts.js";
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
  const drafts = new PublicationDraftRepository(database);
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
    drafts,
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
      drafts,
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

  it("consumes the exact current draft in dry-run mode without calling Zernio publish", async () => {
    const deps = dependencies({
      dryRun: true,
      zernioFetch: async () => new Response(JSON.stringify({ valid: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    });
    const saved = deps.drafts.save({
      ...deps.scope,
      threadId: "thread",
      kind: "original",
      payload: { kind: "original", content: "Exact dry-run post", accountId: deps.scope.xAccountId },
    });
    const tool = deps.tools.find((candidate) => candidate.name === "publish_current_x_draft")!;
    const result = await tool.execute("call", {} as never, undefined, undefined, undefined as never);

    expect(toolJson(result)).toMatchObject({ confirmed: false, providerStatus: "dry_run" });
    expect(deps.drafts.getForScope(saved.id, deps.scope).state).toBe("consumed");
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

  it("stores an original-post draft without publishing or touching the reply verifier", async () => {
    const publishFetch = vi.fn(async () => new Response(JSON.stringify({ valid: true }), { status: 200 }));
    const deps = dependencies({ zernioFetch: publishFetch });
    const tool = deps.tools.find((candidate) => candidate.name === "save_x_draft")!;
    const result = await tool.execute("call", {
      kind: "original",
      content: "An original draft linking https://x.com/i/status/123",
    } as never, undefined, undefined, undefined as never);
    expect(toolJson(result)).toMatchObject({ stored: true, kind: "original", published: false });
    expect(deps.drafts.getCurrent("thread", deps.scope)?.payload).toMatchObject({
      content: "An original draft linking https://x.com/i/status/123",
    });
    expect(publishFetch).not.toHaveBeenCalled();
    expect(deps.database.connection.prepare("SELECT count(*) AS count FROM reply_recommendations").get())
      .toMatchObject({ count: 0 });
  });

  it("stages a searched reply target when its draft is saved", async () => {
    const deps = dependencies();
    deps.candidates.put({
      sessionId: "session",
      candidateRef: "xc_target",
      postId: "1900123456789012345",
      canonicalUrl: "https://x.com/i/web/status/1900123456789012345",
      candidate: { candidateRef: "xc_target", text: "Candidate text", metrics: {} },
    });
    const tool = deps.tools.find((candidate) => candidate.name === "save_x_draft")!;
    const result = await tool.execute("call", {
      kind: "reply",
      content: "Exact proposed reply",
      candidateRef: "xc_target",
    } as never, undefined, undefined, undefined as never);

    expect(toolJson(result)).toMatchObject({
      stored: true,
      target: "https://x.com/i/web/status/1900123456789012345",
    });
    expect(deps.stageReplyOpportunity).toHaveBeenCalledWith(expect.objectContaining({
      post: "1900123456789012345",
      suggestedReply: "Exact proposed reply",
    }));
  });

  it("does not store a reply target reserved by another delivery", async () => {
    const deps = dependencies();
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
    const tool = deps.tools.find((candidate) => candidate.name === "save_x_draft")!;
    const result = toolJson(await tool.execute("call", {
      kind: "reply",
      content: "Exact proposed reply",
      candidateRef: "xc_pending",
    } as never, undefined, undefined, undefined as never));

    expect(result).toMatchObject({ stored: false, verifierPending: true });
    expect(result).not.toHaveProperty("target");
    expect(deps.database.connection.prepare("SELECT count(*) AS count FROM publication_drafts").get())
      .toMatchObject({ count: 0 });
  });

  it("stores a direct verified reply URL without an ephemeral Xquik mapping", async () => {
    const deps = dependencies();
    const tool = deps.tools.find((candidate) => candidate.name === "save_x_draft")!;
    const result = toolJson(await tool.execute("call", {
      kind: "reply",
      content: "Reply after a process restart",
      post: "https://mobile.twitter.com/alice/statuses/1900123456789012347?s=20",
    } as never, undefined, undefined, undefined as never));

    expect(result).toMatchObject({
      stored: true,
      target: "https://x.com/i/web/status/1900123456789012347",
    });
    expect(deps.stageReplyOpportunity).toHaveBeenCalledWith(expect.objectContaining({
      post: "1900123456789012347",
      suggestedReply: "Reply after a process restart",
    }));
    expect(deps.drafts.getCurrent("thread", deps.scope)).toMatchObject({
      kind: "reply",
      targetPostId: "1900123456789012347",
    });
  });

  it("publishes the exact current draft once without another confirmation or public ID", async () => {
    const requests: Request[] = [];
    const deps = dependencies({
      zernioFetch: async (input, init) => {
        const request = input instanceof Request ? input : new Request(input, init);
        requests.push(request.clone());
        if (new URL(request.url).pathname.endsWith("/tools/validate/post")) {
          return new Response(JSON.stringify({ valid: true }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(JSON.stringify({
          post: {
            _id: "internal-record-1",
            status: "published",
            platforms: [{
              platform: "twitter",
              accountId: deps.scope.xAccountId,
              status: "published",
              platformPostId: "1900999999999999999",
              platformPostUrl: "https://x.com/exy/status/1900999999999999999",
            }],
          },
        }), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      },
    });
    const exactDraft = "Exact bytes — keep  spacing and punctuation!";
    await deps.tools.find((tool) => tool.name === "save_x_draft")!.execute("save", {
      kind: "original",
      content: exactDraft,
    } as never, undefined, undefined, undefined as never);

    const publish = deps.tools.find((tool) => tool.name === "publish_current_x_draft")!;
    const result = toolJson(await publish.execute("publish", {} as never, undefined, undefined, undefined as never));
    const publishRequests = requests.filter((request) => new URL(request.url).pathname.endsWith("/posts"));
    const body = await publishRequests[0]!.json() as Record<string, unknown>;

    expect(publishRequests).toHaveLength(1);
    expect(body).toMatchObject({ content: exactDraft, publishNow: true });
    expect(result).toMatchObject({ confirmed: true, providerStatus: "published" });
    expect(result).not.toHaveProperty("providerRecordId");
    expect(result).not.toHaveProperty("providerPostId");
    expect(JSON.stringify(result)).not.toContain("internal-record-1");
    await expect(publish.execute("publish-again", {} as never, undefined, undefined, undefined as never))
      .rejects.toThrow(/no current draft/i);
    expect(requests.filter((request) => new URL(request.url).pathname.endsWith("/posts"))).toHaveLength(1);
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
      "Zernio has not published the target yet.",
    ].join("\n"));
  });

  it("does not corrupt exact draft content that resembles a success claim", () => {
    const exactContent = "Tweet published\r\nDone - it's live on X\r\nPosted!";
    expect(guardUnconfirmedPublicationClaims(
      `I'd post this:\n\n${exactContent}`,
      false,
      { preserveExactContent: [exactContent] },
    )).toContain(exactContent);
  });

  it("does not corrupt X-looking text inside exact draft content", () => {
    const deps = dependencies();
    const exactContent = `Keep these bytes: https://x.com/a/status/0 and https://x.com/a/status/${"1".repeat(41)}`;
    const guarded = guardUnverifiedXPostUrls(
      exactContent,
      deps.scope,
      new ReplyOpportunityVerifier(deps.database),
      new Set(),
      { preserveExactContent: [exactContent] },
    );
    expect(guarded).toContain(exactContent);
  });
});
