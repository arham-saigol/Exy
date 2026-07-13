export interface Migration {
  version: number;
  name: string;
  sql: string;
}

/**
 * Append-only schema migrations. A migration is committed together with its
 * schema_migrations row, so a process crash cannot leave a half-applied schema.
 */
export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "initial-state",
    sql: `
      CREATE TABLE key_value (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL CHECK (json_valid(value_json)),
        updated_at INTEGER NOT NULL
      ) STRICT;

      CREATE TABLE model_preferences (
        discord_user_id TEXT NOT NULL,
        x_account_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        model_id TEXT NOT NULL,
        reasoning TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (discord_user_id, x_account_id)
      ) STRICT;

      CREATE TABLE agent_sessions (
        id TEXT PRIMARY KEY,
        discord_user_id TEXT NOT NULL,
        x_account_id TEXT NOT NULL,
        pi_session_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;

      CREATE TABLE discord_threads (
        thread_id TEXT PRIMARY KEY,
        guild_id TEXT NOT NULL,
        parent_channel_id TEXT NOT NULL,
        parent_message_id TEXT NOT NULL,
        discord_user_id TEXT NOT NULL,
        x_account_id TEXT NOT NULL,
        session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE RESTRICT,
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('creating', 'active', 'failed')),
        claimed_at TEXT,
        activated_at TEXT,
        failure_reason TEXT,
        archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
        created_at INTEGER NOT NULL,
        last_activity_at INTEGER NOT NULL,
        UNIQUE (guild_id, parent_message_id),
        UNIQUE (session_id)
      ) STRICT;

      CREATE INDEX discord_threads_route_idx
        ON discord_threads(guild_id, parent_channel_id, discord_user_id);

      CREATE TABLE reply_recommendations (
        id TEXT PRIMARY KEY,
        discord_user_id TEXT NOT NULL,
        x_account_id TEXT NOT NULL,
        post_id TEXT NOT NULL CHECK (length(post_id) > 0 AND post_id NOT GLOB '*[^0-9]*'),
        canonical_url TEXT NOT NULL,
        presented_url TEXT NOT NULL,
        thread_id TEXT,
        session_id TEXT REFERENCES agent_sessions(id) ON DELETE SET NULL,
        metadata_json TEXT CHECK (metadata_json IS NULL OR json_valid(metadata_json)),
        recommended_at INTEGER NOT NULL,
        UNIQUE (discord_user_id, x_account_id, post_id)
      ) STRICT;

      CREATE INDEX reply_recommendations_scope_time_idx
        ON reply_recommendations(discord_user_id, x_account_id, recommended_at DESC);

      CREATE TABLE publication_approvals (
        id TEXT PRIMARY KEY,
        discord_user_id TEXT NOT NULL,
        x_account_id TEXT NOT NULL,
        publication_kind TEXT NOT NULL CHECK (publication_kind IN ('reply', 'original')),
        target_post_id TEXT CHECK (
          target_post_id IS NULL OR
          (length(target_post_id) > 0 AND target_post_id NOT GLOB '*[^0-9]*')
        ),
        payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
        payload_sha256 TEXT NOT NULL,
        token_sha256 TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('prepared', 'approved', 'consumed', 'cancelled', 'expired')),
        prepared_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        approved_at INTEGER,
        consumed_at INTEGER,
        cancelled_at INTEGER,
        CHECK (
          (publication_kind = 'reply' AND target_post_id IS NOT NULL) OR
          (publication_kind = 'original' AND target_post_id IS NULL)
        )
      ) STRICT;

      CREATE INDEX publication_approvals_scope_state_idx
        ON publication_approvals(discord_user_id, x_account_id, state, expires_at);

      CREATE TABLE scheduled_jobs (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        task TEXT NOT NULL,
        schedule_kind TEXT NOT NULL CHECK (schedule_kind IN ('interval', 'once', 'cron')),
        interval_ms INTEGER CHECK (interval_ms IS NULL OR interval_ms >= 1000),
        run_at INTEGER,
        cron_expression TEXT,
        timezone TEXT NOT NULL DEFAULT 'UTC',
        payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
        next_run_at INTEGER,
        last_run_at INTEGER,
        lease_owner TEXT,
        lease_expires_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        deleted_at INTEGER,
        CHECK (
          (schedule_kind = 'interval' AND interval_ms IS NOT NULL AND run_at IS NULL AND cron_expression IS NULL) OR
          (schedule_kind = 'once' AND interval_ms IS NULL AND run_at IS NOT NULL AND cron_expression IS NULL) OR
          (schedule_kind = 'cron' AND interval_ms IS NULL AND run_at IS NULL AND cron_expression IS NOT NULL)
        ),
        CHECK ((lease_owner IS NULL) = (lease_expires_at IS NULL))
      ) STRICT;

      CREATE UNIQUE INDEX scheduled_jobs_active_name_idx
        ON scheduled_jobs(name) WHERE deleted_at IS NULL;
      CREATE INDEX scheduled_jobs_due_idx
        ON scheduled_jobs(next_run_at)
        WHERE enabled = 1 AND deleted_at IS NULL;

      CREATE TABLE job_runs (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL,
        job_name TEXT NOT NULL,
        task TEXT NOT NULL,
        runner_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'abandoned')),
        scheduled_for INTEGER NOT NULL,
        started_at INTEGER NOT NULL,
        finished_at INTEGER,
        error TEXT,
        result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json))
      ) STRICT;

      CREATE INDEX job_runs_job_started_idx ON job_runs(job_id, started_at DESC);
      CREATE INDEX job_runs_status_started_idx ON job_runs(status, started_at);
    `,
  },
  {
    version: 2,
    name: "publication-provider-attempts",
    sql: `
      CREATE TABLE publication_provider_attempts (
        approval_id TEXT PRIMARY KEY REFERENCES publication_approvals(id) ON DELETE CASCADE,
        provider_record_id TEXT NOT NULL UNIQUE,
        provider_status TEXT NOT NULL,
        confirmed INTEGER NOT NULL CHECK (confirmed IN (0, 1)),
        updated_at INTEGER NOT NULL
      ) STRICT;
    `,
  },
  // Versions 1 and 2 retain the retired approval tables because migrations are
  // append-only and existing installations may already have applied them. No
  // runtime code reads or writes those tables after this migration.
  {
    version: 3,
    name: "conversation-publication-drafts",
    sql: `
      CREATE TABLE publication_drafts (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        discord_user_id TEXT NOT NULL,
        x_account_id TEXT NOT NULL,
        publication_kind TEXT NOT NULL CHECK (publication_kind IN ('reply', 'original')),
        target_post_id TEXT CHECK (
          target_post_id IS NULL OR
          (length(target_post_id) > 0 AND target_post_id NOT GLOB '*[^0-9]*')
        ),
        payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
        payload_sha256 TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('current', 'superseded', 'consumed')),
        created_at INTEGER NOT NULL,
        consumed_at INTEGER,
        CHECK (
          (publication_kind = 'reply' AND target_post_id IS NOT NULL) OR
          (publication_kind = 'original' AND target_post_id IS NULL)
        )
      ) STRICT;

      CREATE UNIQUE INDEX publication_drafts_one_current_per_thread_idx
        ON publication_drafts(thread_id) WHERE state = 'current';
      CREATE INDEX publication_drafts_scope_time_idx
        ON publication_drafts(discord_user_id, x_account_id, thread_id, created_at DESC);

      CREATE TABLE publication_draft_provider_attempts (
        draft_id TEXT PRIMARY KEY REFERENCES publication_drafts(id) ON DELETE CASCADE,
        provider_record_id TEXT NOT NULL UNIQUE,
        provider_status TEXT NOT NULL,
        confirmed INTEGER NOT NULL CHECK (confirmed IN (0, 1)),
        updated_at INTEGER NOT NULL
      ) STRICT;
    `,
  },
];
