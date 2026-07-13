import { createHash, randomUUID, timingSafeEqual } from "node:crypto";

import type { Scope } from "../core/types.js";
import type { ExyDatabase } from "./database.js";
import type { JsonValue } from "./json.js";
import { parseJson, serializeJson } from "./json.js";
import { assertScope } from "./state.js";

export type PublicationKind = "reply" | "original";
export type PublicationDraftState = "current" | "superseded" | "consumed";

export interface SavePublicationDraftInput extends Scope {
  threadId: string;
  kind: PublicationKind;
  payload: JsonValue;
  targetPostId?: string;
}

export interface PublicationDraft extends Scope {
  id: string;
  threadId: string;
  kind: PublicationKind;
  payload: JsonValue;
  payloadSha256: string;
  targetPostId?: string;
  state: PublicationDraftState;
  createdAt: number;
  consumedAt?: number;
}

export interface PublicationProviderAttempt {
  draftId: string;
  providerRecordId: string;
  providerStatus: string;
  confirmed: boolean;
  updatedAt: number;
}

export class DraftError extends Error {
  constructor(
    readonly code: "not_found" | "scope_mismatch" | "payload_mismatch" | "invalid_state",
    message: string,
  ) {
    super(message);
    this.name = "DraftError";
  }
}

/** Stores exact conversation drafts and atomically permits one publication attempt. */
export class PublicationDraftRepository {
  constructor(
    private readonly database: ExyDatabase,
    private readonly now: () => number = Date.now,
  ) {}

  save(input: SavePublicationDraftInput): PublicationDraft {
    assertScope(input);
    assertThreadId(input.threadId);
    assertTarget(input.kind, input.targetPostId);
    const payloadJson = serializeJson(input.payload);
    const id = randomUUID();
    const timestamp = this.now();
    this.database.transaction(() => {
      this.database.connection
        .prepare(`
          UPDATE publication_drafts SET state = 'superseded'
          WHERE thread_id = ? AND state = 'current'
        `)
        .run(input.threadId);
      this.database.connection
        .prepare(`
          INSERT INTO publication_drafts(
            id, thread_id, discord_user_id, x_account_id, publication_kind,
            target_post_id, payload_json, payload_sha256, state, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'current', ?)
        `)
        .run(
          id,
          input.threadId,
          input.discordUserId,
          input.xAccountId,
          input.kind,
          input.targetPostId ?? null,
          payloadJson,
          sha256(payloadJson),
          timestamp,
        );
    });
    return this.getForScope(id, input);
  }

  getCurrent(threadId: string, scope: Scope): PublicationDraft | undefined {
    assertScope(scope);
    assertThreadId(threadId);
    const row = this.database.connection
      .prepare(`
        SELECT * FROM publication_drafts
        WHERE thread_id = ? AND state = 'current'
      `)
      .get(threadId) as unknown as DraftRow | undefined;
    if (row === undefined) return undefined;
    assertDraftScope(row, scope);
    verifyPayload(row);
    return mapDraft(row);
  }

  /** Consumes the current draft before provider I/O so it cannot be published twice. */
  consumeCurrent(threadId: string, scope: Scope): PublicationDraft {
    const outcome = this.database.transaction<PublicationDraft | DraftError>(() => {
      const draft = this.getCurrent(threadId, scope);
      if (draft === undefined) {
        return new DraftError("not_found", "There is no current draft to publish in this conversation");
      }
      const timestamp = this.now();
      const result = this.database.connection
        .prepare(`
          UPDATE publication_drafts SET state = 'consumed', consumed_at = ?
          WHERE id = ? AND state = 'current'
        `)
        .run(timestamp, draft.id);
      if (Number(result.changes) !== 1) {
        return new DraftError("invalid_state", "The current draft was already consumed");
      }
      return { ...draft, state: "consumed", consumedAt: timestamp };
    });
    if (outcome instanceof DraftError) throw outcome;
    return outcome;
  }

  getLatestConsumed(threadId: string, scope: Scope): PublicationDraft {
    assertScope(scope);
    assertThreadId(threadId);
    const row = this.database.connection
      .prepare(`
        SELECT * FROM publication_drafts
        WHERE thread_id = ? AND state = 'consumed'
        ORDER BY consumed_at DESC LIMIT 1
      `)
      .get(threadId) as unknown as DraftRow | undefined;
    if (row === undefined) throw new DraftError("not_found", "No publication attempt exists in this conversation");
    assertDraftScope(row, scope);
    verifyPayload(row);
    return mapDraft(row);
  }

  getForScope(id: string, scope: Scope): PublicationDraft {
    const row = this.database.connection
      .prepare("SELECT * FROM publication_drafts WHERE id = ?")
      .get(id) as unknown as DraftRow | undefined;
    if (row === undefined) throw new DraftError("not_found", "Publication draft was not found");
    assertDraftScope(row, scope);
    verifyPayload(row);
    return mapDraft(row);
  }

  recordProviderAttempt(
    draftId: string,
    scope: Scope,
    input: { providerRecordId: string; providerStatus: string; confirmed: boolean },
  ): PublicationProviderAttempt {
    const draft = this.getForScope(draftId, scope);
    if (draft.state !== "consumed") {
      throw new DraftError("invalid_state", "A provider attempt requires a consumed publication draft");
    }
    if (input.providerRecordId.trim() === "" || input.providerRecordId.length > 200) {
      throw new TypeError("Provider record ID is invalid");
    }
    if (input.providerStatus.trim() === "" || input.providerStatus.length > 100) {
      throw new TypeError("Provider publication status is invalid");
    }
    this.database.connection
      .prepare(`
        INSERT INTO publication_draft_provider_attempts(
          draft_id, provider_record_id, provider_status, confirmed, updated_at
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(draft_id) DO UPDATE SET
          provider_status = excluded.provider_status,
          confirmed = MAX(publication_draft_provider_attempts.confirmed, excluded.confirmed),
          updated_at = excluded.updated_at
        WHERE publication_draft_provider_attempts.provider_record_id = excluded.provider_record_id
      `)
      .run(draftId, input.providerRecordId, input.providerStatus, input.confirmed ? 1 : 0, this.now());
    const attempt = this.getProviderAttempt(draftId, scope);
    if (attempt === undefined || attempt.providerRecordId !== input.providerRecordId) {
      throw new DraftError("payload_mismatch", "Provider record does not match this publication draft");
    }
    return attempt;
  }

  getProviderAttempt(draftId: string, scope: Scope): PublicationProviderAttempt | undefined {
    this.getForScope(draftId, scope);
    const row = this.database.connection
      .prepare(`
        SELECT draft_id, provider_record_id, provider_status, confirmed, updated_at
        FROM publication_draft_provider_attempts WHERE draft_id = ?
      `)
      .get(draftId) as unknown as ProviderAttemptRow | undefined;
    return row === undefined ? undefined : {
      draftId: row.draft_id,
      providerRecordId: row.provider_record_id,
      providerStatus: row.provider_status,
      confirmed: row.confirmed === 1,
      updatedAt: row.updated_at,
    };
  }
}

interface DraftRow {
  id: string;
  thread_id: string;
  discord_user_id: string;
  x_account_id: string;
  publication_kind: PublicationKind;
  target_post_id: string | null;
  payload_json: string;
  payload_sha256: string;
  state: PublicationDraftState;
  created_at: number;
  consumed_at: number | null;
}

interface ProviderAttemptRow {
  draft_id: string;
  provider_record_id: string;
  provider_status: string;
  confirmed: number;
  updated_at: number;
}

function mapDraft(row: DraftRow): PublicationDraft {
  return {
    id: row.id,
    threadId: row.thread_id,
    discordUserId: row.discord_user_id,
    xAccountId: row.x_account_id,
    kind: row.publication_kind,
    payload: parseJson(row.payload_json),
    payloadSha256: row.payload_sha256,
    ...(row.target_post_id === null ? {} : { targetPostId: row.target_post_id }),
    state: row.state,
    createdAt: row.created_at,
    ...(row.consumed_at === null ? {} : { consumedAt: row.consumed_at }),
  };
}

function assertThreadId(threadId: string): void {
  if (threadId.trim() === "") throw new TypeError("Thread ID is required for a publication draft");
}

function assertTarget(kind: PublicationKind, targetPostId: string | undefined): void {
  if (kind === "reply") {
    if (targetPostId === undefined || !/^\d+$/.test(targetPostId)) {
      throw new TypeError("Reply drafts require a numeric target post ID");
    }
  } else if (targetPostId !== undefined) {
    throw new TypeError("Original-post drafts must not have a target post ID");
  }
}

function assertDraftScope(row: DraftRow, scope: Scope): void {
  assertScope(scope);
  if (row.discord_user_id !== scope.discordUserId || row.x_account_id !== scope.xAccountId) {
    throw new DraftError("scope_mismatch", "Publication draft belongs to another account scope");
  }
}

function verifyPayload(row: DraftRow): void {
  const expected = Buffer.from(row.payload_sha256, "hex");
  const actual = Buffer.from(sha256(row.payload_json), "hex");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new DraftError("payload_mismatch", "Stored publication draft no longer matches its exact content");
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
