import { createHash } from "node:crypto";
import type { Scope } from "../core/types.js";

export function memoryContainerTag(scope: Scope): string {
  const accountHash = createHash("sha256").update(scope.xAccountId, "utf8").digest("hex").slice(0, 32);
  const user = scope.discordUserId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 32);
  return `exy:u:${user}:x:${accountHash}`;
}
