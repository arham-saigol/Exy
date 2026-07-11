import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { basename, isAbsolute, relative, resolve } from "node:path";

import { parse } from "yaml";

import type {
  AgentSkill,
  AgentSkillMetadata,
  SkillDiagnostic,
  SkillValidationResult,
} from "./types.js";

const MAX_SKILL_FILE_BYTES = 1024 * 1024;
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const KNOWN_FIELDS = new Set([
  "name",
  "description",
  "license",
  "compatibility",
  "metadata",
  "allowed-tools",
]);

/** Strict validator for the current open Agent Skills specification. */
export function validateSkillDirectory(
  directory: string,
  expectedRoot?: string,
): SkillValidationResult {
  const diagnostics: SkillDiagnostic[] = [];
  let realDirectory: string;
  try {
    if (lstatSync(directory).isSymbolicLink()) {
      return invalid("skill_directory_symlink", "Skill directories must not be symbolic links", directory);
    }
    realDirectory = realpathSync(directory);
    if (!statSync(realDirectory).isDirectory()) {
      return invalid("not_directory", "Skill path is not a directory", directory);
    }
  } catch {
    return invalid("not_found", "Skill directory does not exist or cannot be read", directory);
  }

  if (expectedRoot !== undefined) {
    let realRoot: string;
    try {
      if (lstatSync(expectedRoot).isSymbolicLink()) {
        return invalid("skills_root_symlink", "Configured skills root must not be a symbolic link", expectedRoot);
      }
      realRoot = realpathSync(expectedRoot);
    } catch {
      return invalid("root_not_found", "Skills root does not exist or cannot be read", expectedRoot);
    }
    if (!isPathContained(realRoot, realDirectory)) {
      return invalid("outside_root", "Skill directory resolves outside the configured skills root", directory);
    }
  }

  const skillFile = resolve(realDirectory, "SKILL.md");
  try {
    const fileInfo = lstatSync(skillFile);
    if (fileInfo.isSymbolicLink()) {
      return invalid("skill_file_symlink", "SKILL.md must not be a symbolic link", skillFile);
    }
    const info = statSync(skillFile);
    if (!info.isFile()) return invalid("missing_skill_file", "SKILL.md is not a regular file", skillFile);
    if (info.size > MAX_SKILL_FILE_BYTES) {
      return invalid("skill_file_too_large", `SKILL.md exceeds ${MAX_SKILL_FILE_BYTES} bytes`, skillFile);
    }
  } catch {
    return invalid("missing_skill_file", "Skill directory must contain an exact-case SKILL.md file", skillFile);
  }

  let source: string;
  try {
    source = readContainedTextFile(realDirectory, skillFile, MAX_SKILL_FILE_BYTES).replace(/^\uFEFF/, "");
  } catch {
    return invalid("unreadable_skill_file", "SKILL.md could not be read as UTF-8", skillFile);
  }
  const frontmatter = extractFrontmatter(source);
  if (frontmatter === undefined) {
    return invalid(
      "missing_frontmatter",
      "SKILL.md must start with YAML frontmatter delimited by --- lines",
      skillFile,
    );
  }

  let parsed: unknown;
  try {
    parsed = parse(frontmatter.yaml, { maxAliasCount: 0, uniqueKeys: true });
  } catch (error) {
    return invalid(
      "invalid_yaml",
      `SKILL.md frontmatter is not valid YAML: ${messageOf(error)}`,
      skillFile,
    );
  }
  if (!isRecord(parsed)) {
    return invalid("invalid_frontmatter", "SKILL.md frontmatter must be a mapping", skillFile);
  }

  const parentName = basename(realDirectory);
  const name = parsed["name"];
  if (typeof name !== "string" || name.length < 1 || name.length > 64 || !SKILL_NAME.test(name)) {
    diagnostics.push(errorDiagnostic(
      "invalid_name",
      "Skill name must be 1-64 lowercase letters, numbers, or single hyphens",
      skillFile,
    ));
  } else if (name !== parentName) {
    diagnostics.push(errorDiagnostic(
      "name_directory_mismatch",
      `Skill name '${name}' must match parent directory '${parentName}'`,
      skillFile,
    ));
  }

  const description = parsed["description"];
  if (
    typeof description !== "string" ||
    description.trim().length < 1 ||
    description.length > 1024
  ) {
    diagnostics.push(errorDiagnostic(
      "invalid_description",
      "Skill description must be a non-empty string of at most 1024 characters",
      skillFile,
    ));
  }

  validateOptionalString(parsed, "license", undefined, diagnostics, skillFile);
  validateOptionalString(parsed, "compatibility", 500, diagnostics, skillFile, true);
  validateOptionalString(parsed, "allowed-tools", undefined, diagnostics, skillFile, true);
  validateMetadata(parsed["metadata"], diagnostics, skillFile);

  for (const field of Object.keys(parsed)) {
    if (!KNOWN_FIELDS.has(field)) {
      diagnostics.push({
        severity: "warning",
        code: "unknown_frontmatter_field",
        message: `Unknown frontmatter field '${field}' was ignored`,
        path: skillFile,
      });
    }
  }

  if (diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
    return { valid: false, diagnostics };
  }

  const metadata: AgentSkillMetadata = {
    name: name as string,
    description: description as string,
    ...(typeof parsed["license"] === "string" ? { license: parsed["license"] } : {}),
    ...(typeof parsed["compatibility"] === "string"
      ? { compatibility: parsed["compatibility"] }
      : {}),
    ...(isRecord(parsed["metadata"])
      ? { metadata: parsed["metadata"] as Record<string, string> }
      : {}),
    ...(typeof parsed["allowed-tools"] === "string"
      ? { allowedTools: parsed["allowed-tools"] }
      : {}),
  };
  const skill: AgentSkill = {
    ...metadata,
    directory: realDirectory,
    skillFile,
    body: frontmatter.body.trim(),
  };
  return { valid: true, skill, diagnostics };
}

export function isPathContained(root: string, candidate: string): boolean {
  const relation = relative(resolve(root), resolve(candidate));
  return relation === "" || (!relation.startsWith("..") && !isAbsolute(relation));
}

/**
 * Reads from the same descriptor that was checked. On the Ubuntu target,
 * O_NOFOLLOW plus /proc/self/fd closes final-component and parent-swap races.
 */
export function readContainedTextFile(root: string, candidate: string, maxBytes: number): string {
  const absoluteRoot = realpathSync(root);
  const absoluteCandidate = resolve(candidate);
  if (!isPathContained(absoluteRoot, absoluteCandidate)) {
    throw new Error("File path escapes its configured root");
  }

  const noFollow = process.platform === "linux" ? constants.O_NOFOLLOW : 0;
  const descriptor = openSync(absoluteCandidate, constants.O_RDONLY | noFollow);
  try {
    const info = fstatSync(descriptor);
    if (!info.isFile()) throw new Error("Contained path is not a regular file");
    if (info.size > maxBytes) throw new Error(`Contained file exceeds ${maxBytes} bytes`);
    const openedPath = process.platform === "linux"
      ? realpathSync(`/proc/self/fd/${descriptor}`)
      : realpathSync(absoluteCandidate);
    if (!isPathContained(absoluteRoot, openedPath)) {
      throw new Error("Opened file resolves outside its configured root");
    }
    return readFileSync(descriptor, "utf8");
  } finally {
    closeSync(descriptor);
  }
}

function extractFrontmatter(source: string): { yaml: string; body: string } | undefined {
  const match = source.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/);
  if (match === null || match[1] === undefined || match[2] === undefined) return undefined;
  return { yaml: match[1], body: match[2] };
}

function validateOptionalString(
  record: Record<string, unknown>,
  field: string,
  max: number | undefined,
  diagnostics: SkillDiagnostic[],
  path: string,
  nonEmpty = false,
): void {
  const value = record[field];
  if (value === undefined) return;
  if (
    typeof value !== "string" ||
    (nonEmpty && value.trim() === "") ||
    (max !== undefined && value.length > max)
  ) {
    diagnostics.push(errorDiagnostic(
      `invalid_${field.replaceAll("-", "_")}`,
      `${field} must be ${nonEmpty ? "a non-empty " : "a "}string${max === undefined ? "" : ` of at most ${max} characters`}`,
      path,
    ));
  }
}

function validateMetadata(value: unknown, diagnostics: SkillDiagnostic[], path: string): void {
  if (value === undefined) return;
  if (!isRecord(value) || Object.values(value).some((entry) => typeof entry !== "string")) {
    diagnostics.push(errorDiagnostic(
      "invalid_metadata",
      "metadata must be a mapping whose keys and values are strings",
      path,
    ));
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(code: string, message: string, path: string): SkillValidationResult {
  return { valid: false, diagnostics: [errorDiagnostic(code, message, path)] };
}

function errorDiagnostic(code: string, message: string, path: string): SkillDiagnostic {
  return { severity: "error", code, message, path };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
