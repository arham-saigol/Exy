import { describe, expect, it } from "vitest";
import { SupermemoryClient } from "../../src/providers/supermemory.js";
import { jsonResponse, mockFetch, requestJson, type CapturedRequest } from "./helpers.js";

describe("SupermemoryClient", () => {
  it("uses the supplied containerTag for ingest, direct context, profile, and search", async () => {
    const requests: CapturedRequest[] = [];
    const fetch = mockFetch((request) => {
      requests.push(request);
      switch (request.url.pathname) {
        case "/v3/documents":
          return jsonResponse({ id: "doc-1", status: "queued" });
        case "/v4/memories":
          return jsonResponse({ documentId: "doc-2", memories: [] });
        case "/v4/profile":
          return jsonResponse({ profile: { static: ["Voice: concise"], dynamic: ["Focus: launch"] } });
        case "/v4/search":
          return jsonResponse({ results: [{ id: "m-1", memory: "Avoid jargon" }] });
        default:
          throw new Error(`Unexpected path ${request.url.pathname}`);
      }
    });
    const client = new SupermemoryClient("sm-test-key", { fetch });
    const containerTag = "exy:u:42:x:account_7";

    await client.addConversation({
      containerTag,
      content: "User: Prefer short hooks.",
      customId: "discord_thread_123",
    });
    await client.addContext({
      containerTag,
      memories: [{ content: "Writes with dry humor", isStatic: true }],
    });
    await client.getProfile({ containerTag });
    await client.search({ containerTag, q: "voice" });

    expect(requests).toHaveLength(4);
    for (const request of requests) {
      expect(requestJson(request)).toMatchObject({ containerTag });
    }
    expect(requestJson(requests[0]!)).toMatchObject({ customId: "discord_thread_123" });
    expect(requestJson(requests[3]!)).toMatchObject({
      q: "voice",
      searchMode: "hybrid",
      limit: 5,
      threshold: 0.6,
    });
  });

  it("rejects a container tag that cannot provide Supermemory isolation", async () => {
    let called = false;
    const client = new SupermemoryClient("sm-test-key", {
      fetch: mockFetch(() => {
        called = true;
        return jsonResponse({});
      }),
    });

    await expect(client.search({ containerTag: "user/account", q: "voice" })).rejects.toThrow(/containerTag/);
    expect(called).toBe(false);
  });
});
