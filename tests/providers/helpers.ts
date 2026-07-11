import type { FetchLike } from "../../src/providers/http.js";

export interface CapturedRequest {
  url: URL;
  init: RequestInit;
}

export function mockFetch(
  handler: (request: CapturedRequest) => Response | Promise<Response>,
): FetchLike {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? new URL(input.url) : new URL(String(input));
    return handler({ url, init: init ?? {} });
  }) as FetchLike;
}

export function jsonResponse(body: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

export function requestJson(request: CapturedRequest): unknown {
  if (typeof request.init.body !== "string") return undefined;
  return JSON.parse(request.init.body) as unknown;
}

export function requestHeaders(request: CapturedRequest): Headers {
  return new Headers(request.init.headers);
}
