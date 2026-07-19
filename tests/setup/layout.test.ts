import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { testPaths } from "../../src/config/paths.js";
import { ensureLayout } from "../../src/setup/layout.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("setup layout", () => {
  it("installs every bundled skill without overwriting user-managed copies", async () => {
    const root = await mkdtemp(join(tmpdir(), "exy-layout-test-"));
    roots.push(root);
    const paths = testPaths(root);
    await ensureLayout(paths);

    expect((await readdir(paths.skillsDir)).sort()).toEqual([
      "exy-automation",
      "stop-slop",
      "twitter-algorithm-optimizer",
    ]);

    const writingSkill = join(paths.skillsDir, "stop-slop", "SKILL.md");
    await writeFile(writingSkill, "user-managed instructions", "utf8");
    await ensureLayout(paths);
    expect(await readFile(writingSkill, "utf8")).toBe("user-managed instructions");
  });
});
