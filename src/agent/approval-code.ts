import type { Scope } from "../core/types.js";
import type { PublicationApproval, PublicationApprovalRepository } from "../db/approvals.js";

const APPROVAL_PATTERN = /^\s*approve\s+EXY_APPROVAL:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):([A-Za-z0-9_-]{20,80})\s*$/iu;

export function formatApprovalCode(id: string, token: string): string {
  return `EXY_APPROVAL:${id}:${token}`;
}

export interface AcceptedApproval {
  approval: PublicationApproval;
  sanitizedMessage: string;
}

export function acceptApprovalFromMessage(
  repository: PublicationApprovalRepository,
  scope: Scope,
  message: string,
): AcceptedApproval | undefined {
  const match = APPROVAL_PATTERN.exec(message);
  if (!match?.[1] || !match[2]) return undefined;
  const approval = repository.approve(match[1], match[2], scope);
  return {
    approval,
    sanitizedMessage: "approve [accepted Exy publication approval]",
  };
}
