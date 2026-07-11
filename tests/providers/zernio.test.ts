import { describe, expect, it } from "vitest";
import { ZernioClient } from "../../src/providers/zernio.js";
import { jsonResponse, mockFetch, requestHeaders, requestJson, type CapturedRequest } from "./helpers.js";

describe("ZernioClient publishing", () => {
  it("does not claim success from HTTP or overall post success when the requested target is pending", async () => {
    let captured: CapturedRequest | undefined;
    const client = new ZernioClient("sk_zernio_test_secret", {
      fetch: mockFetch((request) => {
        captured = request;
        return jsonResponse({
          post: {
            _id: "zernio-post-1",
            status: "published",
            platforms: [
              { platform: "twitter", accountId: { _id: "other-account" }, status: "published" },
              { platform: "twitter", accountId: { _id: "wanted-account" }, status: "pending" },
            ],
          },
        }, 201);
      }),
    });

    const result = await client.publishReply({
      accountId: "wanted-account",
      content: "Specific approved reply",
      replyToTweetId: "1900123456789012345",
      requestId: "123e4567-e89b-42d3-a456-426614174000",
    });

    expect(result).toEqual({
      confirmed: false,
      providerRecordId: "zernio-post-1",
      providerStatus: "pending",
      message: "Zernio reported the X target as pending.",
    });
    expect(captured?.url.pathname).toBe("/api/v1/posts");
    expect(requestHeaders(captured!).get("x-request-id")).toBe("123e4567-e89b-42d3-a456-426614174000");
    expect(requestJson(captured!)).toMatchObject({
      content: "Specific approved reply",
      publishNow: true,
      platforms: [{
        platform: "twitter",
        accountId: "wanted-account",
        platformSpecificData: { replyToTweetId: "1900123456789012345" },
      }],
    });
  });

  it("confirms only a published status on the requested X target", async () => {
    const client = new ZernioClient("sk_zernio_test_secret", {
      fetch: mockFetch(() => jsonResponse({
        post: {
          _id: "zernio-post-2",
          status: "published",
          platforms: [{
            platform: "twitter",
            accountId: "wanted-account",
            status: "published",
            platformPostId: "1900999999999999999",
            platformPostUrl: "https://x.com/exy/status/1900999999999999999",
          }],
        },
      }, 201)),
    });

    await expect(client.publishOriginal({
      accountId: "wanted-account",
      content: "Approved original post",
    })).resolves.toEqual({
      confirmed: true,
      providerRecordId: "zernio-post-2",
      providerPostId: "1900999999999999999",
      providerPostUrl: "https://x.com/exy/status/1900999999999999999",
      providerStatus: "published",
      message: "Zernio confirmed that the X target was published.",
    });
  });

  it("uses validation as a non-publishing dry run", async () => {
    let captured: CapturedRequest | undefined;
    const client = new ZernioClient("sk_zernio_test_secret", {
      fetch: mockFetch((request) => {
        captured = request;
        return jsonResponse({ valid: true, message: "No validation issues found." });
      }),
    });

    await expect(client.validatePost({
      accountId: "wanted-account",
      content: "Draft only",
    })).resolves.toMatchObject({ valid: true });
    expect(captured?.url.pathname).toBe("/api/v1/tools/validate/post");
    expect(requestJson(captured!)).not.toHaveProperty("publishNow");
  });

  it("rejects malformed reply IDs during validation before making a request", async () => {
    const fetch = mockFetch(() => jsonResponse({ valid: true }));
    const client = new ZernioClient("sk_zernio_test_secret", { fetch });

    await expect(client.validatePost({
      accountId: "wanted-account",
      content: "Draft reply",
      replyToTweetId: "https://x.com/exy/status/1900123456789012345",
    })).rejects.toThrow("replyToTweetId must be an X post ID, not a URL.");
  });

  it("keeps 202 analytics distinct from ready analytics", async () => {
    const client = new ZernioClient("sk_zernio_test_secret", {
      fetch: mockFetch(() => jsonResponse({ status: "syncing" }, 202)),
    });
    await expect(client.getAnalytics({ postId: "post-1" })).resolves.toEqual({
      state: "pending",
      httpStatus: 202,
      data: { status: "syncing" },
    });
  });

  it("uses the official account, health, post, and follower-stat routes", async () => {
    const paths: string[] = [];
    const client = new ZernioClient("sk_zernio_test_secret", {
      fetch: mockFetch((request) => {
        paths.push(`${request.url.pathname}${request.url.search}`);
        if (request.url.pathname.endsWith("/accounts")) {
          return jsonResponse({ accounts: [{ _id: "account-1", platform: "twitter" }] });
        }
        if (request.url.pathname.endsWith("/accounts/health")) {
          return jsonResponse({ summary: { total: 1, healthy: 1 }, accounts: [] });
        }
        if (request.url.pathname.endsWith("/accounts/account-1/health")) {
          return jsonResponse({ accountId: "account-1", status: "healthy" });
        }
        if (request.url.pathname.endsWith("/posts/post-1")) {
          return jsonResponse({ post: { _id: "post-1", status: "published", platforms: [] } });
        }
        return jsonResponse({ accounts: [], stats: {}, granularity: "daily" });
      }),
    });

    await client.listAccounts();
    await client.getAccountsHealth();
    await client.getAccountHealth("account-1");
    await client.getPost("post-1");
    await client.listPosts({ accountId: "account-1", page: 2, limit: 25, source: "external" });
    await client.getFollowerStats({
      accountIds: ["account-1", "account-2"],
      fromDate: "2026-06-01",
      toDate: "2026-07-01",
    });

    expect(paths).toEqual([
      "/api/v1/accounts?platform=twitter&status=connected&page=1&limit=100",
      "/api/v1/accounts/health?platform=twitter",
      "/api/v1/accounts/account-1/health",
      "/api/v1/posts/post-1",
      "/api/v1/posts?accountId=account-1&platform=twitter&page=2&limit=25&source=external&sortBy=created-desc",
      "/api/v1/accounts/follower-stats?accountIds=account-1%2Caccount-2&fromDate=2026-06-01&toDate=2026-07-01&granularity=daily",
    ]);
  });
});
