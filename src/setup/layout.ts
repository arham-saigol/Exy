import { chmod, copyFile, cp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
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

  const bundledSkill = resolve(sourceRoot, ".agents", "skills", "exy-automation");
  const installedSkill = resolve(paths.skillsDir, "exy-automation");
  if ((await exists(bundledSkill)) && !(await exists(installedSkill))) {
    await cp(bundledSkill, installedSkill, { recursive: true, errorOnExist: true });
  }
}

export async function ensureHeartbeatTemplate(paths: ExyPaths): Promise<string> {
  await ensureLayout(paths);
  return readFile(paths.heartbeatFile, "utf8");
}
