import { describe, expect, it } from "vitest";

import { EXY_SYSTEM_PROMPT } from "../../src/agent/system-prompt.js";

describe("Exy coordinator and publishing instructions", () => {
  it("delegates substantial research and every draft while retaining lightweight tools", () => {
    expect(EXY_SYSTEM_PROMPT).toContain("spawn_research_subagent");
    expect(EXY_SYSTEM_PROMPT).toContain("For every reply or original-post draft, call spawn_writing_subagent");
    expect(EXY_SYSTEM_PROMPT).toContain("Never compose or rewrite draft text yourself");
    expect(EXY_SYSTEM_PROMPT).toContain("existing X and web tools remain available");
  });

  it("asks for an acknowledgement and naturally framed draft unless bare copy was requested", () => {
    expect(EXY_SYSTEM_PROMPT).toContain("first briefly acknowledge the request");
    expect(EXY_SYSTEM_PROMPT).toContain("I'd post this:");
    expect(EXY_SYSTEM_PROMPT).toContain("If the user asks for bare post copy, return only the post copy");
  });

  it("publishes a clear current-draft instruction in the same turn with no confirmation code", () => {
    expect(EXY_SYSTEM_PROMPT).toContain("post this");
    expect(EXY_SYSTEM_PROMPT).toContain("publish this draft");
    expect(EXY_SYSTEM_PROMPT).toContain("in that same turn without asking for another confirmation");
    expect(EXY_SYSTEM_PROMPT).toContain("never regenerate, revise, or substitute text at publish time");
    expect(EXY_SYSTEM_PROMPT).not.toMatch(/approval code|approve <|EXY_APPROVAL/iu);
  });

  it("requires a concise clarification when intent or the target draft is ambiguous", () => {
    expect(EXY_SYSTEM_PROMPT).toContain("If the user's intent or draft reference is ambiguous");
    expect(EXY_SYSTEM_PROMPT).toContain("ask one concise clarification question instead");
  });
});
