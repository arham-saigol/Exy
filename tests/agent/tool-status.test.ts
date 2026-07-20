import { describe, expect, it } from "vitest";

import { formatActivatedSkillStatus, formatToolStatus } from "../../src/agent/tool-status.js";

describe("formatToolStatus", () => {
  it("maps X and web tools to polished user-facing activity", () => {
    expect(formatToolStatus("inspect_x_account", {})).toBe("Looking at your X profile");
    expect(formatToolStatus("inspect_x_analytics", { mode: "posts" })).toBe("Viewing X analytics");
    expect(formatToolStatus("inspect_x_analytics", { mode: "followers" })).toBe("Viewing follower analytics");
    expect(formatToolStatus("list_x_post_history", {})).toBe("Reviewing past posts");
    expect(formatToolStatus("search_x", {})).toBe("Searching X");
    expect(formatToolStatus("search_web", {})).toBe("Searching the web");
    expect(formatToolStatus("spawn_research_subagent", {})).toBe("Researching with a specialist");
    expect(formatToolStatus("spawn_writing_subagent", {})).toBe("Drafting with your writing specialist");
    expect(formatToolStatus("save_x_draft", {})).toBe("Saving your X draft");
    expect(formatToolStatus("publish_current_x_draft", {})).toBe("Publishing your X draft");
  });

  it("never exposes unknown names, arguments, IDs, URLs, or credentials", () => {
    const secret = "sk-super-secret";
    const status = formatToolStatus("internal_dump_credentials", {
      apiKey: secret,
      id: "123456789",
      url: "https://private.example/path",
      query: "private search",
    });

    expect(status).toBe("Working on the next step");
    expect(status).not.toContain("internal_dump_credentials");
    expect(status).not.toContain(secret);
    expect(status).not.toContain("123456789");
    expect(status).not.toContain("private.example");
    expect(status).not.toContain("private search");
  });

  it("does not render unexpected analytics context", () => {
    const status = formatToolStatus("inspect_x_analytics", {
      mode: "sk-super-secret",
    });
    expect(status).toBe("Viewing X analytics");
    expect(status).not.toContain("secret");
  });

  it("names a successfully activated skill without accepting arbitrary output", () => {
    expect(formatActivatedSkillStatus("exy-automation"))
      .toBe("Used the `exy-automation` skill");
    expect(formatActivatedSkillStatus("Secret skill\ncredential=123"))
      .toBeUndefined();
    expect(formatActivatedSkillStatus({ name: "exy-automation" }))
      .toBeUndefined();
  });
});
