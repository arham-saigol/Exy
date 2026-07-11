import { randomUUID } from "node:crypto";

import type { Scope } from "../core/types.js";
import type {
  DiscordThreadClaim,
  DiscordThreadRegistration,
  DiscordThreadStore,
} from "../discord/contracts.js";
import type { ExyDatabase } from "./database.js";
import { assertScope } from "./state.js";

export interface RegisterDiscordThreadInput extends Scope {
  threadId: string;
  guildId: string;
  parentChannelId: string;
  parentMessageId: string;
  sessionId?: string;
  piSessionId?: string;
}

/** Adapter for the Discord gateway's atomic claim/activate contract. */
export class SqliteDiscordThreadStore implements DiscordThreadStore {
  constructor(
    private readonly database: ExyDatabase,
    private readonly xAccountId: string,
  ) {
    if (xAccountId.trim() === "") throw new TypeError("Connected X account ID must not be empty");
  }

  async get(threadId: string): Promise<DiscordThreadRegistration | undefined> {
    const row = this.database.connection
      .prepare(`
        SELECT thread_id, parent_message_id, guild_id, parent_channel_id,
               discord_user_id, status, claimed_at, activated_at
        FROM discord_threads WHERE thread_id = ? AND x_account_id = ?
      `)
      .get(threadId, this.xAccountId) as unknown as ContractThreadRow | undefined;
    if (row === undefined) return undefined;
    return {
      threadId: row.thread_id,
      starterMessageId: row.parent_message_id,
      guildId: row.guild_id,
      parentChannelId: row.parent_channel_id,
      authorizedUserId: row.discord_user_id,
      claimedAt: row.claimed_at ?? new Date(0).toISOString(),
      status: row.status,
      ...(row.activated_at === null ? {} : { activatedAt: row.activated_at }),
    };
  }

  async listCreating(): Promise<DiscordThreadRegistration[]> {
    const rows = this.database.connection
      .prepare(`
        SELECT thread_id, parent_message_id, guild_id, parent_channel_id,
               discord_user_id, status, claimed_at, activated_at
        FROM discord_threads
        WHERE x_account_id = ? AND status = 'creating'
        ORDER BY created_at, thread_id
      `)
      .all(this.xAccountId) as unknown as ContractThreadRow[];
    return rows.map((row) => ({
      threadId: row.thread_id,
      starterMessageId: row.parent_message_id,
      guildId: row.guild_id,
      parentChannelId: row.parent_channel_id,
      authorizedUserId: row.discord_user_id,
      claimedAt: row.claimed_at ?? new Date(0).toISOString(),
      status: row.status,
      ...(row.activated_at === null ? {} : { activatedAt: row.activated_at }),
    }));
  }

  async claim(claim: DiscordThreadClaim): Promise<boolean> {
    validateContractClaim(claim);
    return this.database.transaction(() => {
      const timestamp = Date.parse(claim.claimedAt);
      const sessionId = randomUUID();
      this.database.connection
        .prepare(`
          INSERT INTO agent_sessions(
            id, discord_user_id, x_account_id, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?)
        `)
        .run(sessionId, claim.authorizedUserId, this.xAccountId, timestamp, timestamp);
      const result = this.database.connection
        .prepare(`
          INSERT INTO discord_threads(
            thread_id, guild_id, parent_channel_id, parent_message_id,
            discord_user_id, x_account_id, session_id, status, claimed_at,
            created_at, last_activity_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'creating', ?, ?, ?)
          ON CONFLICT DO NOTHING
        `)
        .run(
          claim.threadId,
          claim.guildId,
          claim.parentChannelId,
          claim.starterMessageId,
          claim.authorizedUserId,
          this.xAccountId,
          sessionId,
          claim.claimedAt,
          timestamp,
          timestamp,
        );
      if (Number(result.changes) === 0) {
        this.database.connection.prepare("DELETE FROM agent_sessions WHERE id = ?").run(sessionId);
        return false;
      }
      return true;
    });
  }

  async activate(registration: DiscordThreadRegistration): Promise<void> {
    validateContractClaim(registration);
    if (registration.status !== "active") {
      throw new TypeError("Discord thread activation requires active status");
    }
    const activatedAt = registration.activatedAt ?? new Date().toISOString();
    const timestamp = Date.parse(activatedAt);
    if (!Number.isFinite(timestamp)) throw new TypeError("activatedAt must be an ISO timestamp");
    const result = this.database.connection
      .prepare(`
        UPDATE discord_threads SET
          status = 'active', activated_at = ?, failure_reason = NULL,
          last_activity_at = ?
        WHERE thread_id = ? AND status = 'creating'
          AND parent_message_id = ? AND guild_id = ? AND parent_channel_id = ?
          AND discord_user_id = ? AND x_account_id = ?
      `)
      .run(
        activatedAt,
        timestamp,
        registration.threadId,
        registration.starterMessageId,
        registration.guildId,
        registration.parentChannelId,
        registration.authorizedUserId,
        this.xAccountId,
      );
    if (Number(result.changes) !== 1) {
      const existing = await this.get(registration.threadId);
      if (
        existing?.status !== "active" ||
        existing.starterMessageId !== registration.starterMessageId ||
        existing.guildId !== registration.guildId ||
        existing.parentChannelId !== registration.parentChannelId ||
        existing.authorizedUserId !== registration.authorizedUserId
      ) {
        throw new Error("Discord thread claim was not found, mismatched, or is not creating");
      }
    }
  }

  async fail(threadId: string, reasonCode: string): Promise<void> {
    if (reasonCode.trim() === "" || reasonCode.length > 200) {
      throw new TypeError("Discord thread failure reason code is invalid");
    }
    const result = this.database.connection
      .prepare(`
        UPDATE discord_threads SET status = 'failed', failure_reason = ?
        WHERE thread_id = ? AND status = 'creating' AND x_account_id = ?
      `)
      .run(reasonCode, threadId, this.xAccountId);
    if (Number(result.changes) !== 1) {
      const existing = await this.get(threadId);
      if (existing?.status !== "failed") throw new Error("Discord thread claim was not found or is not creating");
    }
  }
}

export interface DiscordThreadRecord extends Scope {
  threadId: string;
  guildId: string;
  parentChannelId: string;
  parentMessageId: string;
  sessionId: string;
  piSessionId?: string;
  archived: boolean;
  createdAt: number;
  lastActivityAt: number;
}

interface DiscordThreadRow {
  thread_id: string;
  guild_id: string;
  parent_channel_id: string;
  parent_message_id: string;
  discord_user_id: string;
  x_account_id: string;
  session_id: string;
  pi_session_id: string | null;
  archived: number;
  created_at: number;
  last_activity_at: number;
}

interface ContractThreadRow {
  thread_id: string;
  parent_message_id: string;
  guild_id: string;
  parent_channel_id: string;
  discord_user_id: string;
  status: DiscordThreadRegistration["status"];
  claimed_at: string | null;
  activated_at: string | null;
}

/** Persistent Discord thread-to-agent-session routing. */
export class DiscordThreadRepository {
  constructor(
    private readonly database: ExyDatabase,
    private readonly now: () => number = Date.now,
  ) {}

  register(input: RegisterDiscordThreadInput): DiscordThreadRecord {
    assertScope(input);
    for (const [label, value] of [
      ["thread ID", input.threadId],
      ["guild ID", input.guildId],
      ["parent channel ID", input.parentChannelId],
      ["parent message ID", input.parentMessageId],
    ] as const) {
      if (value.trim() === "") throw new TypeError(`${label} must not be empty`);
    }

    return this.database.transaction(() => {
      const existing = this.findByParentMessage(input.guildId, input.parentMessageId);
      if (existing !== undefined) {
        if (
          existing.threadId !== input.threadId ||
          existing.parentChannelId !== input.parentChannelId ||
          existing.discordUserId !== input.discordUserId ||
          existing.xAccountId !== input.xAccountId
        ) {
          throw new Error("Discord starter message is already registered to another route scope");
        }
        return existing;
      }

      const timestamp = this.now();
      const sessionId = input.sessionId ?? randomUUID();
      this.database.connection
        .prepare(`
          INSERT INTO agent_sessions(
            id, discord_user_id, x_account_id, pi_session_id, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?)
        `)
        .run(
          sessionId,
          input.discordUserId,
          input.xAccountId,
          input.piSessionId ?? null,
          timestamp,
          timestamp,
        );
      this.database.connection
        .prepare(`
          INSERT INTO discord_threads(
            thread_id, guild_id, parent_channel_id, parent_message_id,
            discord_user_id, x_account_id, session_id, created_at, last_activity_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          input.threadId,
          input.guildId,
          input.parentChannelId,
          input.parentMessageId,
          input.discordUserId,
          input.xAccountId,
          sessionId,
          timestamp,
          timestamp,
        );

      const created = this.findByThreadId(input.threadId);
      if (created === undefined) throw new Error("Failed to register Discord thread");
      return created;
    });
  }

  findByThreadId(threadId: string): DiscordThreadRecord | undefined {
    const row = this.database.connection
      .prepare(`${THREAD_SELECT} WHERE t.thread_id = ?`)
      .get(threadId) as unknown as DiscordThreadRow | undefined;
    return row === undefined ? undefined : mapThread(row);
  }

  findByParentMessage(guildId: string, parentMessageId: string): DiscordThreadRecord | undefined {
    const row = this.database.connection
      .prepare(`${THREAD_SELECT} WHERE t.guild_id = ? AND t.parent_message_id = ?`)
      .get(guildId, parentMessageId) as unknown as DiscordThreadRow | undefined;
    return row === undefined ? undefined : mapThread(row);
  }

  touch(threadId: string): boolean {
    const timestamp = this.now();
    return this.database.transaction(() => {
      const result = this.database.connection
        .prepare("UPDATE discord_threads SET last_activity_at = ? WHERE thread_id = ?")
        .run(timestamp, threadId);
      if (Number(result.changes) === 1) {
        this.database.connection
          .prepare(`
            UPDATE agent_sessions SET updated_at = ?
            WHERE id = (SELECT session_id FROM discord_threads WHERE thread_id = ?)
          `)
          .run(timestamp, threadId);
        return true;
      }
      return false;
    });
  }

  setPiSessionId(threadId: string, piSessionId: string): boolean {
    if (piSessionId.trim() === "") throw new TypeError("Pi session ID must not be empty");
    const result = this.database.connection
      .prepare(`
        UPDATE agent_sessions SET pi_session_id = ?, updated_at = ?
        WHERE id = (SELECT session_id FROM discord_threads WHERE thread_id = ?)
      `)
      .run(piSessionId, this.now(), threadId);
    return Number(result.changes) === 1;
  }

  setArchived(threadId: string, archived: boolean): boolean {
    const result = this.database.connection
      .prepare("UPDATE discord_threads SET archived = ? WHERE thread_id = ?")
      .run(archived ? 1 : 0, threadId);
    return Number(result.changes) === 1;
  }
}

const THREAD_SELECT = `
  SELECT t.thread_id, t.guild_id, t.parent_channel_id, t.parent_message_id,
         t.discord_user_id, t.x_account_id, t.session_id, s.pi_session_id,
         t.archived, t.created_at, t.last_activity_at
  FROM discord_threads t
  JOIN agent_sessions s ON s.id = t.session_id
`;

function mapThread(row: DiscordThreadRow): DiscordThreadRecord {
  return {
    threadId: row.thread_id,
    guildId: row.guild_id,
    parentChannelId: row.parent_channel_id,
    parentMessageId: row.parent_message_id,
    discordUserId: row.discord_user_id,
    xAccountId: row.x_account_id,
    sessionId: row.session_id,
    ...(row.pi_session_id === null ? {} : { piSessionId: row.pi_session_id }),
    archived: row.archived === 1,
    createdAt: row.created_at,
    lastActivityAt: row.last_activity_at,
  };
}

function validateContractClaim(claim: DiscordThreadClaim): void {
  for (const [label, value] of [
    ["thread ID", claim.threadId],
    ["starter message ID", claim.starterMessageId],
    ["guild ID", claim.guildId],
    ["parent channel ID", claim.parentChannelId],
    ["authorized user ID", claim.authorizedUserId],
  ] as const) {
    if (value.trim() === "") throw new TypeError(`${label} must not be empty`);
  }
  if (!Number.isFinite(Date.parse(claim.claimedAt))) throw new TypeError("claimedAt must be an ISO timestamp");
}
