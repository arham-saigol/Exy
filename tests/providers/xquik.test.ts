import { describe, expect, it } from "vitest";
import { XquikClient } from "../../src/providers/xquik.js";
import { jsonResponse, mockFetch, requestHeaders, type CapturedRequest } from "./helpers.js";

describe("XquikClient", () => {
  it("returns opaque stable candidate refs and resolves them to canonical post IDs", async () => {
    const requests: CapturedRequest[] = [];
    let refCounter = 0;
    const client = new XquikClient("xq_test_secret", {
      createCandidateRef: () => `candidate-${++refCounter}`,
      fetch: mockFetch((request) => {
        requests.push(request);
        return jsonResponse({
          tweets: [{
            id: "1900123456789012345",
            text: "A post worth replying to",
            url: "https://twitter.com/someone/status/1900123456789012345?ref=alternate",
            author: { username: "someone", name: "Someone" },
            likeCount: 12,
          }],
          has_next_page: true,
          next_cursor: "opaque-cursor",
        });
      }),
    });

    const first = await client.searchTweets({
      query: "agent tools",
      queryType: "Latest",
      replies: "exclude",
      limit: 20,
    });
    const second = await client.searchTweets({ query: "agent tools", limit: 20 });

    expect(first.candidates[0]).toEqual({
      candidateRef: "candidate-1",
      text: "A post worth replying to",
      authorUsername: "someone",
      authorName: "Someone",
      metrics: { likes: 12 },
    });
    expect(first.candidates[0]).not.toHaveProperty("postId");
    expect(first.candidates[0]).not.toHaveProperty("canonicalUrl");
    expect(second.candidates[0]?.candidateRef).toBe("candidate-1");
    expect(client.resolveCandidate("candidate-1")).toMatchObject({
      postId: "1900123456789012345",
      canonicalUrl: "https://x.com/i/status/1900123456789012345",
    });
    expect(first).toMatchObject({ hasNextPage: true, nextCursor: "opaque-cursor" });
    expect(requests[0]!.url.searchParams.get("q")).toBe("agent tools");
    expect(requests[0]!.url.searchParams.get("replies")).toBe("exclude");
    expect(requestHeaders(requests[0]!).get("x-api-key")).toBe("xq_test_secret");
  });

  it("uses the read-only account endpoint for credential checks", async () => {
    let pathname = "";
    const client = new XquikClient("xq_test_secret", {
      fetch: mockFetch((request) => {
        pathname = request.url.pathname;
        return jsonResponse({ plan: "test" });
      }),
    });
    await expect(client.checkCredentials()).resolves.toEqual({ ok: true });
    expect(pathname).toBe("/api/v1/account");
  });
});
