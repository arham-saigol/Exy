import { describe, expect, it } from "vitest";
import { ProviderError } from "../../src/core/errors.js";
import { ExaClient } from "../../src/providers/exa.js";
import { jsonResponse, mockFetch, requestJson, type CapturedRequest } from "./helpers.js";

describe("ExaClient", () => {
  it("sends a bounded search request", async () => {
    let captured: CapturedRequest | undefined;
    const client = new ExaClient("exa-test-secret", {
      fetch: mockFetch((request) => {
        captured = request;
        return jsonResponse({ requestId: "req-1", results: [] });
      }),
    });
    await client.search({ query: "official agent skills spec", numResults: 3 });
    expect(captured?.url.pathname).toBe("/search");
    expect(requestJson(captured!)).toEqual({
      query: "official agent skills spec",
      type: "auto",
      numResults: 3,
    });
  });

  it("does not treat HTTP 200 as a successful page fetch when the URL status failed", async () => {
    const client = new ExaClient("exa-test-secret", {
      fetch: mockFetch(() => jsonResponse({
        requestId: "req-2",
        results: [],
        statuses: [{
          id: "https://example.com/missing",
          status: "error",
          error: { tag: "CRAWL_NOT_FOUND", httpStatusCode: 404 },
        }],
      })),
    });

    const error = await client.fetchPage({ url: "https://example.com/missing" }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).toSafeObject()).toEqual({
      provider: "exa",
      status: 404,
      code: "CRAWL_NOT_FOUND",
      message: "Exa could not fetch the requested page (CRAWL_NOT_FOUND).",
    });
  });

  it("returns content only after a per-URL success status", async () => {
    const result = {
      id: "page-1",
      url: "https://example.com/page",
      title: "Page",
      text: "Fetched content",
    };
    const client = new ExaClient("exa-test-secret", {
      fetch: mockFetch(() => jsonResponse({
        requestId: "req-3",
        results: [result],
        statuses: [{ id: "https://example.com/page", status: "success", source: "live" }],
      })),
    });
    await expect(client.fetchPage({ url: "https://example.com/page", maxAgeHours: 0 })).resolves.toEqual(result);
  });
});
