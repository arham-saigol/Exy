import { describe, expect, it } from "vitest";
import { ProviderError } from "../../src/core/errors.js";
import { ProviderHttp } from "../../src/providers/http.js";
import { jsonResponse, mockFetch } from "./helpers.js";

describe("ProviderHttp", () => {
  it("allow-lists error fields and redacts configured secrets", async () => {
    const secret = "sk_1234567890abcdefghijklmnopqrstuvwxyz";
    const http = new ProviderHttp({
      provider: "example",
      baseUrl: "https://example.invalid/api",
      headers: { Authorization: `Bearer ${secret}` },
      secrets: [secret],
      fetch: mockFetch(() => jsonResponse({
        type: "authentication_error",
        message: `Rejected credential ${secret}`,
        platformError: { requestHeaders: { Authorization: `Bearer ${secret}` } },
      }, 401, { "retry-after": "7" })),
    });

    const error = await http.request({ path: "probe" }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ProviderError);
    const safe = (error as ProviderError).toSafeObject();
    expect(safe).toEqual({
      provider: "example",
      status: 401,
      code: "authentication_error",
      message: "Rejected credential [REDACTED]",
      retryAfterSeconds: 7,
    });
    expect(JSON.stringify(safe)).not.toContain(secret);
    expect(JSON.stringify(safe)).not.toContain("platformError");
    expect(error).not.toHaveProperty("headers");
    expect(error).not.toHaveProperty("request");
  });

  it("does not forward network exception text that could contain a secret", async () => {
    const secret = "super-secret-key";
    const http = new ProviderHttp({
      provider: "example",
      baseUrl: "https://example.invalid",
      secrets: [secret],
      fetch: mockFetch(() => {
        throw new Error(`socket failed with ${secret}`);
      }),
    });

    const error = await http.request({ path: "probe" }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as Error).message).toBe(
      "The provider request failed before a response was received. (code network_error)",
    );
    expect(JSON.stringify((error as ProviderError).toSafeObject())).not.toContain(secret);
  });

  it("recognizes providers whose error field is the stable code", async () => {
    const http = new ProviderHttp({
      provider: "xquik",
      baseUrl: "https://example.invalid",
      fetch: mockFetch(() => jsonResponse({ error: "rate_limit_exceeded", retryAfter: 2 }, 429)),
    });

    const error = await http.request({ path: "probe" }).catch((caught: unknown) => caught);
    expect((error as ProviderError).toSafeObject()).toMatchObject({
      status: 429,
      code: "rate_limit_exceeded",
      retryAfterSeconds: 2,
    });
    expect((error as Error).message).toContain("HTTP 429");
    expect((error as Error).message).toContain("retry after 2s");
  });

  it("forwards cancellation to fetch and reports a safe interrupted error", async () => {
    const controller = new AbortController();
    controller.abort();
    const http = new ProviderHttp({
      provider: "example",
      baseUrl: "https://example.invalid",
      fetch: mockFetch(({ init }) => {
        init.signal?.throwIfAborted();
        return jsonResponse({ ok: true });
      }),
    });

    const error = await http.request({ path: "probe", signal: controller.signal }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).toSafeObject()).toMatchObject({
      code: "request_aborted",
      message: "The provider request was interrupted.",
    });
  });
});
