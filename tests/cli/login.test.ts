import { describe, expect, it, vi } from "vitest";
import { fetchOpenCodeGoModelIds } from "../../src/cli/login.js";

describe("OpenCode Go model discovery", () => {
  it("returns every unique model currently exposed by the account endpoint", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.headers).toEqual({ Accept: "application/json" });
      return new Response(JSON.stringify({
        object: "list",
        data: [
          { id: "kimi-k3", object: "model" },
          { id: "deepseek-v4-flash", object: "model" },
          { id: "kimi-k3", object: "model" },
        ],
      }), { status: 200, headers: { "content-type": "application/json" } });
    });

    await expect(fetchOpenCodeGoModelIds(fetchImpl as typeof fetch))
      .resolves.toEqual(["kimi-k3", "deepseek-v4-flash"]);
  });

  it("reports provider errors clearly", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      error: "catalog temporarily unavailable",
    }), { status: 503, headers: { "content-type": "application/json" } }));

    await expect(fetchOpenCodeGoModelIds(fetchImpl as typeof fetch))
      .rejects.toThrow(/HTTP 503.*catalog temporarily unavailable/u);
  });

  it("handles invalid and empty model responses clearly", async () => {
    await expect(fetchOpenCodeGoModelIds(vi.fn(async () => new Response("not json", { status: 200 })) as typeof fetch))
      .rejects.toThrow("invalid model list");
    await expect(fetchOpenCodeGoModelIds(vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 })) as typeof fetch))
      .rejects.toThrow("empty model catalog");
  });
});
