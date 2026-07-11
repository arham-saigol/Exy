import { randomUUID } from "node:crypto";

import type { Scope } from "../core/types.js";
import type { ExyDatabase } from "../db/database.js";
import type { JsonValue } from "../db/json.js";
import { parseJson, serializeJson } from "../db/json.js";
import { assertScope } from "../db/state.js";
import { canonicalizeXPost, type CanonicalXPost } from "./canonicalize.js";

export interface RecommendationRecord extends Scope, CanonicalXPost {
  id: string;
  presentedUrl: string;
  threadId?: string;
  sessionId?: string;
  metadata?: JsonValue;
  recommendedAt: number;
}

export interface PresentReplyOpportunityInput extends Scope {
  post: string;
  threadId?: string;
  sessionId?: string;
  metadata?: JsonValue;
}

export interface ReplyOpportunityInspection extends CanonicalXPost {
  alreadyRecommended: boolean;
  previous?: RecommendationRecord;
  instruction: string;
}

export interface PresentReplyOpportunityResult extends ReplyOpportunityInspection {
  presented: boolean;
  recommendation: RecommendationRecord;
}

/**
 * The sole write boundary for reply-opportunity presentation. Search tools call
 * inspect(), which is read-only. A presentation path must call present() and
 * only show the candidate when `presented` is true.
 */
export class ReplyOpportunityVerifier {
  constructor(
    private readonly database: ExyDatabase,
    private readonly now: () => number = Date.now,
  ) {}

  inspect(scope: Scope, post: string): ReplyOpportunityInspection {
    assertScope(scope);
    const canonical = canonicalizeXPost(post);
    const previous = this.find(scope, canonical.postId);
    if (previous !== undefined) {
      return {
        ...canonical,
        alreadyRecommended: true,
        previous,
        instruction: "This X post was already recommended for this user and connected X account. Do not present it as a new reply opportunity.",
      };
    }
    return {
      ...canonical,
      alreadyRecommended: false,
      instruction: "This X post has not been recommended in this account scope. Call present() only if it will now be shown to the user.",
    };
  }

  present(input: PresentReplyOpportunityInput): PresentReplyOpportunityResult {
    assertScope(input);
    const canonical = canonicalizeXPost(input.post);
    const timestamp = this.now();
    const id = randomUUID();
    const result = this.database.connection
      .prepare(`
        INSERT INTO reply_recommendations(
          id, discord_user_id, x_account_id, post_id, canonical_url, presented_url,
          thread_id, session_id, metadata_json, recommended_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(discord_user_id, x_account_id, post_id) DO NOTHING
      `)
      .run(
        id,
        input.discordUserId,
        input.xAccountId,
        canonical.postId,
        canonical.canonicalUrl,
        input.post.trim(),
        input.threadId ?? null,
        input.sessionId ?? null,
        input.metadata === undefined ? null : serializeJson(input.metadata),
        timestamp,
      );

    const recommendation = this.find(input, canonical.postId);
    if (recommendation === undefined) throw new Error("Failed to persist reply recommendation");
    const presented = Number(result.changes) === 1;
    return {
      ...canonical,
      alreadyRecommended: !presented,
      presented,
      recommendation,
      ...(presented ? {} : { previous: recommendation }),
      instruction: presented
        ? "The reply opportunity was recorded and may now be presented to the user."
        : "This X post was already recommended for this user and connected X account. Do not present it as a new reply opportunity.",
    };
  }

  find(scope: Scope, postIdOrUrl: string): RecommendationRecord | undefined {
    assertScope(scope);
    const { postId } = canonicalizeXPost(postIdOrUrl);
    const row = this.database.connection
      .prepare(`
        SELECT id, discord_user_id, x_account_id, post_id, canonical_url, presented_url,
               thread_id, session_id, metadata_json, recommended_at
        FROM reply_recommendations
        WHERE discord_user_id = ? AND x_account_id = ? AND post_id = ?
      `)
      .get(scope.discordUserId, scope.xAccountId, postId) as unknown as RecommendationRow | undefined;
    return row === undefined ? undefined : mapRecommendation(row);
  }

  list(scope: Scope, limit = 100): RecommendationRecord[] {
    assertScope(scope);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new TypeError("Recommendation limit must be between 1 and 1000");
    }
    const rows = this.database.connection
      .prepare(`
        SELECT id, discord_user_id, x_account_id, post_id, canonical_url, presented_url,
               thread_id, session_id, metadata_json, recommended_at
        FROM reply_recommendations
        WHERE discord_user_id = ? AND x_account_id = ?
        ORDER BY recommended_at DESC, id DESC LIMIT ?
      `)
      .all(scope.discordUserId, scope.xAccountId, limit) as unknown as RecommendationRow[];
    return rows.map(mapRecommendation);
  }
}

interface RecommendationRow {
  id: string;
  discord_user_id: string;
  x_account_id: string;
  post_id: string;
  canonical_url: string;
  presented_url: string;
  thread_id: string | null;
  session_id: string | null;
  metadata_json: string | null;
  recommended_at: number;
}

function mapRecommendation(row: RecommendationRow): RecommendationRecord {
  return {
    id: row.id,
    discordUserId: row.discord_user_id,
    xAccountId: row.x_account_id,
    postId: row.post_id,
    canonicalUrl: row.canonical_url,
    presentedUrl: row.presented_url,
    ...(row.thread_id === null ? {} : { threadId: row.thread_id }),
    ...(row.session_id === null ? {} : { sessionId: row.session_id }),
    ...(row.metadata_json === null ? {} : { metadata: parseJson(row.metadata_json) }),
    recommendedAt: row.recommended_at,
  };
}
