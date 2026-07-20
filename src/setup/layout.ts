import { chmod, copyFile, cp, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExyPaths } from "../config/paths.js";

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export async function ensureLayout(paths: ExyPaths): Promise<void> {
  for (const path of [
    paths.configDir,
    paths.dataDir,
    paths.workspaceDir,
    paths.piAgentDir,
    paths.sessionsDir,
    paths.skillsDir,
  ]) {
    await mkdir(path, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") await chmod(path, 0o700);
  }

  if (!(await exists(paths.heartbeatFile))) {
    const bundled = resolve(sourceRoot, "HEARTBEAT.md");
    if (await exists(bundled)) {
      await copyFile(bundled, paths.heartbeatFile);
    } else {
      await writeFile(paths.heartbeatFile, "# HEARTBEAT.md\n\n<!-- Disabled: add checklist items to enable work. -->\n", {
        mode: 0o600,
      });
    }
  }
  if (process.platform !== "win32") await chmod(paths.heartbeatFile, 0o600);

  const bundledSkills = resolve(sourceRoot, ".agents", "skills");
  if (await exists(bundledSkills)) {
    const entries = await readdir(bundledSkills, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const bundledSkill = resolve(bundledSkills, entry.name);
      const installedSkill = resolve(paths.skillsDir, entry.name);
      // Installed skills are user-managed. Add newly bundled skills without
      // replacing local edits or upgrades made through the normal skill flow.
      if (!(await exists(installedSkill))) {
        await cp(bundledSkill, installedSkill, { recursive: true, errorOnExist: true });
      }
    }
  }
}

export async function ensureHeartbeatTemplate(paths: ExyPaths): Promise<string> {
  await ensureLayout(paths);
  return readFile(paths.heartbeatFile, "utf8");
}
