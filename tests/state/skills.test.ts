import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { SkillRegistry, discoverSkills } from "../../src/skills/discovery.js";
import { validateSkillDirectory } from "../../src/skills/validator.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryRoot(): string {
  const directory = mkdtempSync(join(tmpdir(), "exy-skills-"));
  temporaryDirectories.push(directory);
  return directory;
}

function addSkill(root: string, name: string, description = "Use this skill for safe scheduled work."): string {
  const directory = join(root, name);
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\nmetadata:\n  author: exy\n---\n\n# Instructions\n\nDo the work safely.\n`,
  );
  return directory;
}

describe("Agent Skills discovery", () => {
  it("validates the open SKILL.md shape and discovers metadata", () => {
    const root = temporaryRoot();
    addSkill(root, "heartbeat-manager");
    const result = discoverSkills(root);
    expect(result.diagnostics).toEqual([]);
    expect(result.skills).toMatchObject([{ name: "heartbeat-manager", metadata: { author: "exy" } }]);
  });

  it("rejects names that do not match their directory", () => {
    const root = temporaryRoot();
    const directory = addSkill(root, "directory-name");
    writeFileSync(
      join(directory, "SKILL.md"),
      "---\nname: another-name\ndescription: Use for tests.\n---\nBody\n",
    );
    expect(validateSkillDirectory(directory, root)).toMatchObject({ valid: false });
  });

  it("dynamically reloads newly installed skills and blocks traversal", () => {
    const root = temporaryRoot();
    const registry = new SkillRegistry(root);
    expect(registry.list()).toEqual([]);
    const directory = addSkill(root, "new-skill");
    mkdirSync(join(directory, "references"));
    writeFileSync(join(directory, "references", "guide.md"), "contained guide");
    expect(registry.list().map((skill) => skill.name)).toEqual(["new-skill"]);
    expect(registry.readResource("new-skill", "references/guide.md")).toBe("contained guide");
    expect(() => registry.readResource("new-skill", "../outside.txt")).toThrow(/escapes/i);
  });

  it("refuses a skill directory outside the configured root", () => {
    const root = temporaryRoot();
    const otherRoot = temporaryRoot();
    const outside = addSkill(otherRoot, "outside");
    expect(validateSkillDirectory(outside, root)).toMatchObject({ valid: false });
  });

  it("rejects a skills root symlink instead of following it outside", () => {
    const project = temporaryRoot();
    const actualRoot = temporaryRoot();
    addSkill(actualRoot, "outside");
    const linkedRoot = join(project, "skills-link");
    try {
      symlinkSync(actualRoot, linkedRoot, process.platform === "win32" ? "junction" : "dir");
    } catch {
      return; // Some locked-down Windows test hosts cannot create links.
    }
    expect(discoverSkills(linkedRoot)).toMatchObject({ skills: [] });
    expect(discoverSkills(linkedRoot).diagnostics[0]?.code).toBe("skills_root_symlink");
  });
});
