import {
  existsSync,
  lstatSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

import type {
  AgentSkill,
  AgentSkillCatalogEntry,
  SkillDiagnostic,
  SkillDiscoveryResult,
} from "./types.js";
import {
  isPathContained,
  readContainedTextFile,
  validateSkillDirectory,
} from "./validator.js";

export interface SkillDiscoveryOptions {
  maxSkills?: number;
  maxResourceFiles?: number;
  maxResourceBytes?: number;
  maxResourceDirectories?: number;
}

/** Discovers immediate .agents/skills/{name}/SKILL.md children. */
export function discoverSkills(
  skillsRoot: string,
  options: SkillDiscoveryOptions = {},
): SkillDiscoveryResult {
  const maxSkills = options.maxSkills ?? 500;
  if (!Number.isSafeInteger(maxSkills) || maxSkills < 1 || maxSkills > 10_000) {
    throw new TypeError("maxSkills must be between 1 and 10000");
  }
  const diagnostics: SkillDiagnostic[] = [];
  if (!existsSync(skillsRoot)) return { skills: [], diagnostics };

  let realRoot: string;
  try {
    if (lstatSync(skillsRoot).isSymbolicLink()) {
      return {
        skills: [],
        diagnostics: [{
          severity: "error",
          code: "skills_root_symlink",
          message: "Configured skills root must not be a symbolic link",
          path: skillsRoot,
        }],
      };
    }
    realRoot = realpathSync(skillsRoot);
    if (!statSync(realRoot).isDirectory()) {
      return {
        skills: [],
        diagnostics: [{
          severity: "error",
          code: "invalid_skills_root",
          message: "Configured skills root is not a directory",
          path: skillsRoot,
        }],
      };
    }
  } catch {
    return {
      skills: [],
      diagnostics: [{
        severity: "error",
        code: "unreadable_skills_root",
        message: "Configured skills root cannot be read",
        path: skillsRoot,
      }],
    };
  }

  let entries;
  try {
    entries = readdirSync(realRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .sort((left, right) => left.name.localeCompare(right.name));
  } catch {
    return {
      skills: [],
      diagnostics: [{
        severity: "error",
        code: "unreadable_skills_root",
        message: "Configured skills root contents cannot be listed",
        path: realRoot,
      }],
    };
  }
  if (entries.length > maxSkills) {
    diagnostics.push({
      severity: "error",
      code: "too_many_skills",
      message: `Skills root has more than the configured limit of ${maxSkills} directories`,
      path: realRoot,
    });
  }

  const skills: AgentSkill[] = [];
  const seen = new Set<string>();
  for (const entry of entries.slice(0, maxSkills)) {
    const directory = resolve(realRoot, entry.name);
    const result = validateSkillDirectory(directory, realRoot);
    diagnostics.push(...result.diagnostics);
    if (!result.valid || result.skill === undefined) continue;
    if (seen.has(result.skill.name)) {
      diagnostics.push({
        severity: "warning",
        code: "duplicate_skill_name",
        message: `Duplicate skill '${result.skill.name}' was ignored`,
        path: result.skill.skillFile,
      });
      continue;
    }
    seen.add(result.skill.name);
    skills.push(result.skill);
  }
  return { skills, diagnostics };
}

/** Reloadable project skill catalog with safe activation/resource access. */
export class SkillRegistry {
  private readonly skills = new Map<string, AgentSkill>();
  private diagnostics: SkillDiagnostic[] = [];
  private readonly maxResourceFiles: number;
  private readonly maxResourceBytes: number;
  private readonly maxResourceDirectories: number;

  constructor(
    readonly skillsRoot: string,
    private readonly options: SkillDiscoveryOptions = {},
  ) {
    this.maxResourceFiles = options.maxResourceFiles ?? 500;
    this.maxResourceBytes = options.maxResourceBytes ?? 1024 * 1024;
    this.maxResourceDirectories = options.maxResourceDirectories ?? 2_000;
    if (!Number.isSafeInteger(this.maxResourceFiles) || this.maxResourceFiles < 1) {
      throw new TypeError("maxResourceFiles must be a positive integer");
    }
    if (!Number.isSafeInteger(this.maxResourceBytes) || this.maxResourceBytes < 1) {
      throw new TypeError("maxResourceBytes must be a positive integer");
    }
    if (!Number.isSafeInteger(this.maxResourceDirectories) || this.maxResourceDirectories < 1) {
      throw new TypeError("maxResourceDirectories must be a positive integer");
    }
    this.reload();
  }

  reload(): SkillDiscoveryResult {
    const result = discoverSkills(this.skillsRoot, this.options);
    this.skills.clear();
    for (const skill of result.skills) this.skills.set(skill.name, skill);
    this.diagnostics = result.diagnostics;
    return result;
  }

  /** Reloads first so skills installed while the gateway is running appear. */
  list(): AgentSkill[] {
    this.reload();
    return [...this.skills.values()].sort((left, right) => left.name.localeCompare(right.name));
  }

  /** Progressive-disclosure catalog: metadata and location, never the body. */
  catalog(): AgentSkillCatalogEntry[] {
    return this.list().map(({ body: _body, ...entry }) => entry);
  }

  getDiagnostics(): SkillDiagnostic[] {
    return [...this.diagnostics];
  }

  /** Returns current instructions and the contained resource paths. */
  activate(name: string): AgentSkill & { resources: string[] } {
    this.reload();
    const skill = this.skills.get(name);
    if (skill === undefined) throw new Error(`Unknown or invalid agent skill: ${name}`);

    // Revalidate immediately before activation to close change/symlink races.
    const validation = validateSkillDirectory(skill.directory, this.skillsRoot);
    if (!validation.valid || validation.skill === undefined) {
      throw new Error(`Agent skill became invalid before activation: ${name}`);
    }
    return { ...validation.skill, resources: this.listResources(validation.skill) };
  }

  readResource(name: string, relativePath: string): string {
    const skill = this.activate(name);
    if (relativePath.trim() === "" || relativePath.includes("\0") || isAbsolute(relativePath)) {
      throw new Error("Skill resource path must be a non-empty relative path");
    }
    const candidate = resolve(skill.directory, relativePath);
    if (!isPathContained(skill.directory, candidate)) {
      throw new Error("Skill resource path escapes the skill directory");
    }
    try {
      return readContainedTextFile(skill.directory, candidate, this.maxResourceBytes);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Skill resource could not be read safely: ${detail}`);
    }
  }

  private listResources(skill: AgentSkill): string[] {
    const resources: string[] = [];
    const pending = [skill.directory];
    const visitedDirectories = new Set<string>();
    while (
      pending.length > 0 &&
      resources.length < this.maxResourceFiles &&
      visitedDirectories.size < this.maxResourceDirectories
    ) {
      const directory = pending.pop();
      if (directory === undefined) break;
      let realDirectory: string;
      try {
        realDirectory = realpathSync(directory);
      } catch {
        continue;
      }
      if (visitedDirectories.has(realDirectory)) continue;
      visitedDirectories.add(realDirectory);
      for (const entry of readdirSync(realDirectory, { withFileTypes: true })) {
        const path = resolve(realDirectory, entry.name);
        if (entry.isSymbolicLink()) {
          // Reject links even when currently contained; their targets can be
          // swapped between discovery and activation.
          continue;
        } else if (entry.isDirectory()) {
          if (entry.name !== ".git" && entry.name !== "node_modules") pending.push(path);
        } else if (entry.isFile() && entry.name !== "SKILL.md") {
          resources.push(relative(skill.directory, path));
        }
        if (resources.length >= this.maxResourceFiles) break;
      }
    }
    return resources.sort();
  }
}
