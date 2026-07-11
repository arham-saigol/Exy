export interface AgentSkillMetadata {
  name: string;
  description: string;
  license?: string;
  compatibility?: string;
  metadata?: Record<string, string>;
  allowedTools?: string;
}

export interface AgentSkill extends AgentSkillMetadata {
  directory: string;
  skillFile: string;
  body: string;
}

/** Tier-one disclosure shape; intentionally excludes full skill instructions. */
export interface AgentSkillCatalogEntry extends AgentSkillMetadata {
  directory: string;
  skillFile: string;
}

export type SkillDiagnosticSeverity = "warning" | "error";

export interface SkillDiagnostic {
  severity: SkillDiagnosticSeverity;
  code: string;
  message: string;
  path: string;
}

export interface SkillValidationResult {
  valid: boolean;
  skill?: AgentSkill;
  diagnostics: SkillDiagnostic[];
}

export interface SkillDiscoveryResult {
  skills: AgentSkill[];
  diagnostics: SkillDiagnostic[];
}
