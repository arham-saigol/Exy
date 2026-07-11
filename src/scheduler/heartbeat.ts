import { readFile } from "node:fs/promises";

export interface HeartbeatDocument {
  enabled: boolean;
  content: string;
}

/**
 * Reads the heartbeat instructions at execution time so edits take effect
 * without a restart. Configuration remains the source of truth for whether the
 * heartbeat is enabled; the file itself never turns scheduling on.
 */
export async function readHeartbeatDocument(
  heartbeatPath: string,
  configuredEnabled: boolean,
  maxBytes = 128 * 1024,
): Promise<HeartbeatDocument> {
  if (!configuredEnabled) return { enabled: false, content: "" };
  const content = await readFile(heartbeatPath, "utf8");
  if (Buffer.byteLength(content, "utf8") > maxBytes) {
    throw new Error(`HEARTBEAT.md exceeds the ${maxBytes}-byte safety limit`);
  }
  return { enabled: true, content };
}
