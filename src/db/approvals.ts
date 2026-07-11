import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

import type { Scope } from "../core/types.js";
import type { ExyDatabase } from "./database.js";
import type { JsonValue } from "./json.js";
import { parseJson, serializeJson } from "./json.js";
import { assertScope } from "./state.js";

export type PublicationKind = "reply" | "original";
export type ApprovalState = "prepared" | "approved" | "consumed" | "cancelled" | "expired";

export interface PreparePublicationInput extends Scope {
  kind: PublicationKind;
  payload: JsonValue;
  targetPostId?: string;
  ttlMs?: number;
}

export interface PreparedPublication {
  approval: PublicationApproval;
  /** Return this to the user; only its SHA-256 digest is persisted. */
  approvalToken: string;
}

export interface PublicationApproval extends Scope {
  id: string;
  kind: PublicationKind;
  payload: JsonValue;
  payloadSha256: string;
  targetPostId?: string;
  state: ApprovalState;
  preparedAt: number;
  expiresAt: number;
  approvedAt?: number;
  consumedAt?: number;
  cancelledAt?: number;
}

export interface PublicationProviderAttempt {
  approvalId: string;
  providerRecordId: string;
  providerStatus: string;
  confirmed: boolean;
  updatedAt: number;
}

export class ApprovalError extends Error {
  constructor(
    readonly code:
      | "not_found"
      | "scope_mismatch"
      | "invalid_token"
      | "payload_mismatch"
      | "expired"
      | "invalid_state",
    message: string,
  ) {
    super(message);
    this.name = "ApprovalError";
  }
}

/** Enforces prepared -> explicit approval -> one-time publication consumption. */
export class PublicationApprovalRepository {
  constructor(
    private readonly database: ExyDatabase,
    private readonly now: () => number = Date.now,
  ) {}

  prepare(input: PreparePublicationInput): PreparedPublication {
    assertScope(input);
    const ttlMs = input.ttlMs ?? 15 * 60_000;
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1_000 || ttlMs > 24 * 60 * 60_000) {
      throw new TypeError("Approval TTL must be between one second and 24 hours");
    }
    if (input.kind === "reply") {
      if (input.targetPostId === undefined || !/^\d+$/.test(input.targetPostId)) {
        throw new TypeError("Reply approvals require a numeric target post ID");
      }
    } else if (input.targetPostId !== undefined) {
      throw new TypeError("Original-post approvals must not have a target post ID");
    }

    const payloadJson = serializeJson(input.payload);
    const approvalToken = randomBytes(24).toString("base64url");
    const id = randomUUID();
    const timestamp = this.now();
    this.database.connection
      .prepare(`
        INSERT INTO publication_approvals(
          id, discord_user_id, x_account_id, publication_kind, target_post_id,
          payload_json, payload_sha256, token_sha256, state, prepared_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'prepared', ?, ?)
      `)
      .run(
        id,
        input.discordUserId,
        input.xAccountId,
        input.kind,
        input.targetPostId ?? null,
        payloadJson,
        sha256(payloadJson),
        sha256(approvalToken),
        timestamp,
        timestamp + ttlMs,
      );

    const approval = this.get(id);
    if (approval === undefined) throw new Error("Failed to prepare publication approval");
    return { approval, approvalToken };
  }

  approve(id: string, approvalToken: string, scope: Scope): PublicationApproval {
    const outcome = this.database.transaction<PublicationApproval | ApprovalError>(() => {
      const row = this.getRow(id);
      if (row === undefined) throw new ApprovalError("not_found", "Publication approval was not found");
      assertApprovalScope(row, scope);
      verifyToken(row.token_sha256, approvalToken);
      verifyPayload(row);

      const timestamp = this.now();
      if (row.state === "prepared" && row.expires_at <= timestamp) {
        this.database.connection
          .prepare("UPDATE publication_approvals SET state = 'expired' WHERE id = ? AND state = 'prepared'")
          .run(id);
        return new ApprovalError("expired", "Publication approval expired; prepare the exact post again");
      }
      if (row.state !== "prepared") {
        throw new ApprovalError("invalid_state", `Publication approval is already ${row.state}`);
      }

      const result = this.database.connection
        .prepare(`
          UPDATE publication_approvals SET state = 'approved', approved_at = ?
          WHERE id = ? AND state = 'prepared' AND expires_at > ?
        `)
        .run(timestamp, id, timestamp);
      if (Number(result.changes) !== 1) {
        throw new ApprovalError("invalid_state", "Publication approval could not be approved");
      }
      return mapApproval({ ...row, state: "approved", approved_at: timestamp });
    });
    if (outcome instanceof ApprovalError) throw outcome;
    return outcome;
  }

  /**
   * Atomically consumes an approved record before calling a publisher. A second
   * caller cannot receive the payload, so one approval can authorize at most one
   * provider request.
   */
  consume(id: string, scope: Scope): PublicationApproval {
    const outcome = this.database.transaction<PublicationApproval | ApprovalError>(() => {
      const row = this.getRow(id);
      if (row === undefined) throw new ApprovalError("not_found", "Publication approval was not found");
      assertApprovalScope(row, scope);
      verifyPayload(row);
      if (row.state !== "approved") {
        throw new ApprovalError("invalid_state", `Publication approval is ${row.state}, not approved`);
      }
      const timestamp = this.now();
      if (row.expires_at <= timestamp) {
        this.database.connection
          .prepare("UPDATE publication_approvals SET state = 'expired' WHERE id = ? AND state = 'approved'")
          .run(id);
        return new ApprovalError("expired", "Publication approval expired before it was consumed");
      }
      const result = this.database.connection
        .prepare(`
          UPDATE publication_approvals SET state = 'consumed', consumed_at = ?
          WHERE id = ? AND state = 'approved'
        `)
        .run(timestamp, id);
      if (Number(result.changes) !== 1) {
        throw new ApprovalError("invalid_state", "Publication approval was already consumed");
      }
      return mapApproval({ ...row, state: "consumed", consumed_at: timestamp });
    });
    if (outcome instanceof ApprovalError) throw outcome;
    return outcome;
  }

  cancel(id: string, scope: Scope): boolean {
    const row = this.getRow(id);
    if (row === undefined) return false;
    assertApprovalScope(row, scope);
    const result = this.database.connection
      .prepare(`
        UPDATE publication_approvals SET state = 'cancelled', cancelled_at = ?
        WHERE id = ? AND state IN ('prepared', 'approved')
      `)
      .run(this.now(), id);
    return Number(result.changes) === 1;
  }

  expirePending(): number {
    const result = this.database.connection
      .prepare(`
        UPDATE publication_approvals SET state = 'expired'
        WHERE state IN ('prepared', 'approved') AND expires_at <= ?
      `)
      .run(this.now());
    return Number(result.changes);
  }

  get(id: string): PublicationApproval | undefined {
    const row = this.getRow(id);
    return row === undefined ? undefined : mapApproval(row);
  }

  getForScope(id: string, scope: Scope): PublicationApproval {
    const row = this.getRow(id);
    if (row === undefined) throw new ApprovalError("not_found", "Publication approval was not found");
    assertApprovalScope(row, scope);
    verifyPayload(row);
    return mapApproval(row);
  }

  recordProviderAttempt(
    approvalId: string,
    scope: Scope,
    input: { providerRecordId: string; providerStatus: string; confirmed: boolean },
  ): PublicationProviderAttempt {
    const approval = this.getForScope(approvalId, scope);
    if (approval.state !== "consumed") {
      throw new ApprovalError("invalid_state", "A provider attempt can only be bound to a consumed publication approval");
    }
    if (input.providerRecordId.trim() === "" || input.providerRecordId.length > 200) {
      throw new TypeError("Provider record ID is invalid");
    }
    if (input.providerStatus.trim() === "" || input.providerStatus.length > 100) {
      throw new TypeError("Provider publication status is invalid");
    }
    const timestamp = this.now();
    this.database.connection
      .prepare(`
        INSERT INTO publication_provider_attempts(
          approval_id, provider_record_id, provider_status, confirmed, updated_at
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(approval_id) DO UPDATE SET
          provider_status = excluded.provider_status,
          confirmed = MAX(publication_provider_attempts.confirmed, excluded.confirmed),
          updated_at = excluded.updated_at
        WHERE publication_provider_attempts.provider_record_id = excluded.provider_record_id
      `)
      .run(
        approvalId,
        input.providerRecordId,
        input.providerStatus,
        input.confirmed ? 1 : 0,
        timestamp,
      );
    const attempt = this.getProviderAttempt(approvalId, scope);
    if (attempt === undefined || attempt.providerRecordId !== input.providerRecordId) {
      throw new ApprovalError("payload_mismatch", "Provider record does not match this publication approval");
    }
    return attempt;
  }

  getProviderAttempt(approvalId: string, scope: Scope): PublicationProviderAttempt | undefined {
    this.getForScope(approvalId, scope);
    const row = this.database.connection
      .prepare(`
        SELECT approval_id, provider_record_id, provider_status, confirmed, updated_at
        FROM publication_provider_attempts WHERE approval_id = ?
      `)
      .get(approvalId) as unknown as ProviderAttemptRow | undefined;
    return row === undefined ? undefined : {
      approvalId: row.approval_id,
      providerRecordId: row.provider_record_id,
      providerStatus: row.provider_status,
      confirmed: row.confirmed === 1,
      updatedAt: row.updated_at,
    };
  }

  private getRow(id: string): ApprovalRow | undefined {
    return this.database.connection
      .prepare("SELECT * FROM publication_approvals WHERE id = ?")
      .get(id) as unknown as ApprovalRow | undefined;
  }
}

interface ApprovalRow {
  id: string;
  discord_user_id: string;
  x_account_id: string;
  publication_kind: PublicationKind;
  target_post_id: string | null;
  payload_json: string;
  payload_sha256: string;
  token_sha256: string;
  state: ApprovalState;
  prepared_at: number;
  expires_at: number;
  approved_at: number | null;
  consumed_at: number | null;
  cancelled_at: number | null;
}

interface ProviderAttemptRow {
  approval_id: string;
  provider_record_id: string;
  provider_status: string;
  confirmed: number;
  updated_at: number;
}

function mapApproval(row: ApprovalRow): PublicationApproval {
  return {
    id: row.id,
    discordUserId: row.discord_user_id,
    xAccountId: row.x_account_id,
    kind: row.publication_kind,
    payload: parseJson(row.payload_json),
    payloadSha256: row.payload_sha256,
    ...(row.target_post_id === null ? {} : { targetPostId: row.target_post_id }),
    state: row.state,
    preparedAt: row.prepared_at,
    expiresAt: row.expires_at,
    ...(row.approved_at === null ? {} : { approvedAt: row.approved_at }),
    ...(row.consumed_at === null ? {} : { consumedAt: row.consumed_at }),
    ...(row.cancelled_at === null ? {} : { cancelledAt: row.cancelled_at }),
  };
}

function assertApprovalScope(row: ApprovalRow, scope: Scope): void {
  assertScope(scope);
  if (row.discord_user_id !== scope.discordUserId || row.x_account_id !== scope.xAccountId) {
    throw new ApprovalError("scope_mismatch", "Publication approval belongs to another account scope");
  }
}

function verifyToken(expectedHash: string, token: string): void {
  const expected = Buffer.from(expectedHash, "hex");
  const actual = Buffer.from(sha256(token), "hex");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new ApprovalError("invalid_token", "Publication approval token is invalid");
  }
}

function verifyPayload(row: ApprovalRow): void {
  const expected = Buffer.from(row.payload_sha256, "hex");
  const actual = Buffer.from(sha256(row.payload_json), "hex");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new ApprovalError(
      "payload_mismatch",
      "Prepared publication payload no longer matches the explicitly approved content",
    );
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
