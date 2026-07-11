import { randomUUID } from "node:crypto";

import type { ExyDatabase } from "./database.js";
import type { JsonValue } from "./json.js";

export interface CandidateMapping {
  id: string;
  sessionId: string;
  candidateRef: string;
  postId: string;
  canonicalUrl: string;
  candidate?: JsonValue;
  discoveredAt: number;
}

/**
 * Process-local mapping of provider candidate references for one live agent
 * session. Raw search results must not be written to durable storage; after a
 * restart the agent asks the user to search again. Only the verifier persists
 * posts that were actually presented as recommendations.
 */
export class CandidateMappingRepository {
  private readonly mappings = new Map<string, CandidateMapping>();

  constructor(
    // Kept as a constructor argument so gateway composition remains stable. Raw
    // candidates intentionally never use this durable database.
    _database?: ExyDatabase,
    private readonly now: () => number = Date.now,
  ) {}

  put(input: Omit<CandidateMapping, "id" | "discoveredAt">): CandidateMapping {
    if (input.sessionId.trim() === "" || input.candidateRef.trim() === "") {
      throw new TypeError("Session ID and candidate reference must not be empty");
    }
    if (!/^\d+$/.test(input.postId)) throw new TypeError("Post ID must contain only digits");

    const key = mappingKey(input.sessionId, input.candidateRef);
    const existing = this.mappings.get(key);
    const mapping: CandidateMapping = {
      id: existing?.id ?? randomUUID(),
      sessionId: input.sessionId,
      candidateRef: input.candidateRef,
      postId: input.postId,
      canonicalUrl: input.canonicalUrl,
      ...(input.candidate === undefined ? {} : { candidate: input.candidate }),
      discoveredAt: this.now(),
    };
    this.mappings.set(key, mapping);
    return mapping;
  }

  findByReference(sessionId: string, candidateRef: string): CandidateMapping | undefined {
    return this.mappings.get(mappingKey(sessionId, candidateRef));
  }

  findByPostId(sessionId: string, postId: string): CandidateMapping | undefined {
    for (const mapping of this.mappings.values()) {
      if (mapping.sessionId === sessionId && mapping.postId === postId) return mapping;
    }
    return undefined;
  }

  clearSession(sessionId: string): number {
    let removed = 0;
    for (const [key, mapping] of this.mappings) {
      if (mapping.sessionId === sessionId) {
        this.mappings.delete(key);
        removed += 1;
      }
    }
    return removed;
  }
}

function mappingKey(sessionId: string, candidateRef: string): string {
  return `${sessionId}\0${candidateRef}`;
}
