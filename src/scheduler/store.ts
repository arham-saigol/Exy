import { randomUUID } from "node:crypto";

import type { ExyDatabase } from "../db/database.js";
import type { JsonValue } from "../db/json.js";
import { parseJson, serializeJson } from "../db/json.js";
import {
  initialRunAt,
  nextRunAfterClaim,
  type JobSchedule,
  validateSchedule,
} from "./schedule.js";

export interface CreateScheduledJobInput {
  name: string;
  /** Logical handler key registered in-process; never a command or executable. */
  task: string;
  schedule: JobSchedule;
  payload?: JsonValue;
  enabled?: boolean;
}

export interface UpdateScheduledJobInput {
  name?: string;
  task?: string;
  schedule?: JobSchedule;
  payload?: JsonValue;
  enabled?: boolean;
}

export interface ScheduledJob {
  id: string;
  name: string;
  task: string;
  schedule: JobSchedule;
  payload: JsonValue;
  enabled: boolean;
  nextRunAt?: number;
  lastRunAt?: number;
  leaseOwner?: string;
  leaseExpiresAt?: number;
  createdAt: number;
  updatedAt: number;
  deletedAt?: number;
}

export type JobRunStatus = "running" | "succeeded" | "failed" | "abandoned";

export interface JobRun {
  id: string;
  jobId: string;
  jobName: string;
  task: string;
  runnerId: string;
  status: JobRunStatus;
  scheduledFor: number;
  startedAt: number;
  finishedAt?: number;
  error?: string;
  result?: JsonValue;
}

export interface ClaimedJob {
  job: ScheduledJob;
  run: JobRun;
}

export class ScheduledJobStore {
  constructor(
    private readonly database: ExyDatabase,
    private readonly now: () => number = Date.now,
  ) {}

  create(input: CreateScheduledJobInput): ScheduledJob {
    validateName(input.name);
    validateTask(input.task);
    validateSchedule(input.schedule);
    const timestamp = this.now();
    const enabled = input.enabled ?? true;
    const id = randomUUID();
    const columns = scheduleColumns(input.schedule);
    this.database.connection
      .prepare(`
        INSERT INTO scheduled_jobs(
          id, name, task, schedule_kind, interval_ms, run_at, cron_expression, timezone,
          payload_json, enabled, next_run_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        id,
        input.name.trim(),
        input.task,
        columns.kind,
        columns.intervalMs,
        columns.runAt,
        columns.cronExpression,
        columns.timezone,
        serializeJson(input.payload ?? {}),
        enabled ? 1 : 0,
        enabled ? initialRunAt(input.schedule, timestamp) : null,
        timestamp,
        timestamp,
      );
    return requireJob(this.get(id), "Failed to create scheduled job");
  }

  update(id: string, patch: UpdateScheduledJobInput): ScheduledJob {
    const existing = requireJob(this.get(id), "Scheduled job was not found");
    const schedule = patch.schedule ?? existing.schedule;
    const name = patch.name ?? existing.name;
    const task = patch.task ?? existing.task;
    const payload = patch.payload ?? existing.payload;
    const enabled = patch.enabled ?? existing.enabled;
    validateName(name);
    validateTask(task);
    validateSchedule(schedule);

    const timestamp = this.now();
    let nextRunAt = existing.nextRunAt ?? null;
    if (!enabled) nextRunAt = null;
    else if (!existing.enabled || patch.schedule !== undefined) {
      nextRunAt = initialRunAt(schedule, timestamp);
    }
    const columns = scheduleColumns(schedule);
    const result = this.database.connection
      .prepare(`
        UPDATE scheduled_jobs SET
          name = ?, task = ?, schedule_kind = ?, interval_ms = ?, run_at = ?,
          cron_expression = ?, timezone = ?, payload_json = ?, enabled = ?,
          next_run_at = ?, updated_at = ?
        WHERE id = ? AND deleted_at IS NULL
      `)
      .run(
        name.trim(),
        task,
        columns.kind,
        columns.intervalMs,
        columns.runAt,
        columns.cronExpression,
        columns.timezone,
        serializeJson(payload),
        enabled ? 1 : 0,
        nextRunAt,
        timestamp,
        id,
      );
    if (Number(result.changes) !== 1) throw new Error("Scheduled job was not found");
    return requireJob(this.get(id), "Failed to update scheduled job");
  }

  get(id: string, includeDeleted = false): ScheduledJob | undefined {
    const row = this.database.connection
      .prepare(`SELECT * FROM scheduled_jobs WHERE id = ? ${includeDeleted ? "" : "AND deleted_at IS NULL"}`)
      .get(id) as unknown as ScheduledJobRow | undefined;
    return row === undefined ? undefined : mapJob(row);
  }

  list(includeDisabled = true): ScheduledJob[] {
    const rows = this.database.connection
      .prepare(`
        SELECT * FROM scheduled_jobs
        WHERE deleted_at IS NULL ${includeDisabled ? "" : "AND enabled = 1"}
        ORDER BY name, id
      `)
      .all() as unknown as ScheduledJobRow[];
    return rows.map(mapJob);
  }

  remove(id: string): boolean {
    const timestamp = this.now();
    const result = this.database.connection
      .prepare(`
        UPDATE scheduled_jobs
        SET enabled = 0, next_run_at = NULL, deleted_at = ?, updated_at = ?
        WHERE id = ? AND deleted_at IS NULL
      `)
      .run(timestamp, timestamp, id);
    return Number(result.changes) === 1;
  }

  due(limit = 25, now = this.now()): ScheduledJob[] {
    assertLimit(limit);
    const rows = this.database.connection
      .prepare(`
        SELECT * FROM scheduled_jobs
        WHERE deleted_at IS NULL AND enabled = 1 AND next_run_at IS NOT NULL
          AND next_run_at <= ? AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
        ORDER BY next_run_at, id LIMIT ?
      `)
      .all(now, now, limit) as unknown as ScheduledJobRow[];
    return rows.map(mapJob);
  }

  /** Atomic across gateway processes because it executes under BEGIN IMMEDIATE. */
  claim(jobId: string, runnerId: string, leaseMs = 5 * 60_000, now = this.now()): ClaimedJob | undefined {
    validateRunner(runnerId);
    validateLease(leaseMs);
    return this.database.transaction(() => {
      const row = this.database.connection
        .prepare("SELECT * FROM scheduled_jobs WHERE id = ?")
        .get(jobId) as unknown as ScheduledJobRow | undefined;
      if (
        row === undefined ||
        row.deleted_at !== null ||
        row.enabled !== 1 ||
        row.next_run_at === null ||
        row.next_run_at > now
      ) {
        return undefined;
      }

      if (row.lease_owner !== null && row.lease_expires_at !== null) {
        if (row.lease_expires_at > now) return undefined;
        this.abandonForJob(row.id, now, "Execution lease expired before completion");
      }

      const schedule = scheduleFromRow(row);
      const scheduledFor = row.next_run_at;
      const nextRunAt = nextRunAfterClaim(schedule, scheduledFor, now);
      const runId = randomUUID();
      const enabled = schedule.kind === "once" ? 0 : row.enabled;
      const leaseExpiresAt = now + leaseMs;
      const update = this.database.connection
        .prepare(`
          UPDATE scheduled_jobs SET
            enabled = ?, next_run_at = ?, last_run_at = ?, lease_owner = ?,
            lease_expires_at = ?, updated_at = ?
          WHERE id = ? AND deleted_at IS NULL AND enabled = 1
            AND next_run_at = ? AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
        `)
        .run(
          enabled,
          nextRunAt,
          now,
          runnerId,
          leaseExpiresAt,
          now,
          row.id,
          scheduledFor,
          now,
        );
      if (Number(update.changes) !== 1) return undefined;

      this.database.connection
        .prepare(`
          INSERT INTO job_runs(
            id, job_id, job_name, task, runner_id, status, scheduled_for, started_at
          ) VALUES (?, ?, ?, ?, ?, 'running', ?, ?)
        `)
        .run(runId, row.id, row.name, row.task, runnerId, scheduledFor, now);

      return {
        job: mapJob({
          ...row,
          enabled,
          next_run_at: nextRunAt,
          last_run_at: now,
          lease_owner: runnerId,
          lease_expires_at: leaseExpiresAt,
          updated_at: now,
        }),
        run: {
          id: runId,
          jobId: row.id,
          jobName: row.name,
          task: row.task,
          runnerId,
          status: "running",
          scheduledFor,
          startedAt: now,
        },
      };
    });
  }

  renew(runId: string, runnerId: string, leaseMs = 5 * 60_000, now = this.now()): boolean {
    validateRunner(runnerId);
    validateLease(leaseMs);
    const result = this.database.connection
      .prepare(`
        UPDATE scheduled_jobs SET lease_expires_at = ?, updated_at = ?
        WHERE id = (
          SELECT job_id FROM job_runs
          WHERE id = ? AND runner_id = ? AND status = 'running'
        ) AND lease_owner = ?
      `)
      .run(now + leaseMs, now, runId, runnerId, runnerId);
    return Number(result.changes) === 1;
  }

  complete(
    runId: string,
    runnerId: string,
    outcome: { status: "succeeded"; result?: JsonValue } | { status: "failed"; error: string },
    now = this.now(),
  ): boolean {
    validateRunner(runnerId);
    return this.database.transaction(() => {
      const resultJson = outcome.status === "succeeded" && outcome.result !== undefined
        ? serializeJson(outcome.result)
        : null;
      const error = outcome.status === "failed" ? truncate(outcome.error, 4_000) : null;
      const update = this.database.connection
        .prepare(`
          UPDATE job_runs SET status = ?, finished_at = ?, error = ?, result_json = ?
          WHERE id = ? AND runner_id = ? AND status = 'running'
        `)
        .run(outcome.status, now, error, resultJson, runId, runnerId);
      if (Number(update.changes) !== 1) return false;
      this.database.connection
        .prepare(`
          UPDATE scheduled_jobs SET lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
          WHERE id = (SELECT job_id FROM job_runs WHERE id = ?) AND lease_owner = ?
        `)
        .run(now, runId, runnerId);
      return true;
    });
  }

  cleanupAbandoned(now = this.now()): number {
    return this.database.transaction(() => {
      const expired = this.database.connection
        .prepare(`
          SELECT id FROM scheduled_jobs
          WHERE lease_owner IS NOT NULL AND lease_expires_at <= ?
        `)
        .all(now) as Array<{ id: string }>;
      let abandoned = 0;
      for (const { id } of expired) {
        abandoned += this.abandonForJob(id, now, "Gateway stopped renewing the execution lease");
      }
      return abandoned;
    });
  }

  listRuns(jobId?: string, limit = 100): JobRun[] {
    assertLimit(limit, 1_000);
    const rows = (jobId === undefined
      ? this.database.connection
          .prepare("SELECT * FROM job_runs ORDER BY started_at DESC, id DESC LIMIT ?")
          .all(limit)
      : this.database.connection
          .prepare("SELECT * FROM job_runs WHERE job_id = ? ORDER BY started_at DESC, id DESC LIMIT ?")
          .all(jobId, limit)) as unknown as JobRunRow[];
    return rows.map(mapRun);
  }

  private abandonForJob(jobId: string, now: number, reason: string): number {
    const update = this.database.connection
      .prepare(`
        UPDATE job_runs SET status = 'abandoned', finished_at = ?, error = ?
        WHERE job_id = ? AND status = 'running'
      `)
      .run(now, truncate(reason, 4_000), jobId);
    this.database.connection
      .prepare(`
        UPDATE scheduled_jobs
        SET lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
        WHERE id = ?
      `)
      .run(now, jobId);
    return Number(update.changes);
  }
}

interface ScheduledJobRow {
  id: string;
  name: string;
  task: string;
  schedule_kind: JobSchedule["kind"];
  interval_ms: number | null;
  run_at: number | null;
  cron_expression: string | null;
  timezone: string;
  payload_json: string;
  enabled: number;
  next_run_at: number | null;
  last_run_at: number | null;
  lease_owner: string | null;
  lease_expires_at: number | null;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

interface JobRunRow {
  id: string;
  job_id: string;
  job_name: string;
  task: string;
  runner_id: string;
  status: JobRunStatus;
  scheduled_for: number;
  started_at: number;
  finished_at: number | null;
  error: string | null;
  result_json: string | null;
}

function mapJob(row: ScheduledJobRow): ScheduledJob {
  return {
    id: row.id,
    name: row.name,
    task: row.task,
    schedule: scheduleFromRow(row),
    payload: parseJson(row.payload_json),
    enabled: row.enabled === 1,
    ...(row.next_run_at === null ? {} : { nextRunAt: row.next_run_at }),
    ...(row.last_run_at === null ? {} : { lastRunAt: row.last_run_at }),
    ...(row.lease_owner === null ? {} : { leaseOwner: row.lease_owner }),
    ...(row.lease_expires_at === null ? {} : { leaseExpiresAt: row.lease_expires_at }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.deleted_at === null ? {} : { deletedAt: row.deleted_at }),
  };
}

function mapRun(row: JobRunRow): JobRun {
  return {
    id: row.id,
    jobId: row.job_id,
    jobName: row.job_name,
    task: row.task,
    runnerId: row.runner_id,
    status: row.status,
    scheduledFor: row.scheduled_for,
    startedAt: row.started_at,
    ...(row.finished_at === null ? {} : { finishedAt: row.finished_at }),
    ...(row.error === null ? {} : { error: row.error }),
    ...(row.result_json === null ? {} : { result: parseJson(row.result_json) }),
  };
}

function scheduleFromRow(row: ScheduledJobRow): JobSchedule {
  switch (row.schedule_kind) {
    case "interval":
      if (row.interval_ms === null) throw new Error(`Corrupt interval job ${row.id}`);
      return { kind: "interval", everyMs: row.interval_ms };
    case "once":
      if (row.run_at === null) throw new Error(`Corrupt one-time job ${row.id}`);
      return { kind: "once", at: row.run_at };
    case "cron":
      if (row.cron_expression === null) throw new Error(`Corrupt cron job ${row.id}`);
      return { kind: "cron", expression: row.cron_expression, timezone: row.timezone };
  }
}

function scheduleColumns(schedule: JobSchedule): {
  kind: JobSchedule["kind"];
  intervalMs: number | null;
  runAt: number | null;
  cronExpression: string | null;
  timezone: string;
} {
  switch (schedule.kind) {
    case "interval":
      return { kind: schedule.kind, intervalMs: schedule.everyMs, runAt: null, cronExpression: null, timezone: "UTC" };
    case "once":
      return { kind: schedule.kind, intervalMs: null, runAt: schedule.at, cronExpression: null, timezone: "UTC" };
    case "cron":
      return {
        kind: schedule.kind,
        intervalMs: null,
        runAt: null,
        cronExpression: schedule.expression.trim(),
        timezone: schedule.timezone ?? "UTC",
      };
  }
}

function validateName(name: string): void {
  if (!/^[\p{L}\p{N}][\p{L}\p{N} _.:-]{0,99}$/u.test(name.trim())) {
    throw new TypeError("Job name must be 1-100 letters/numbers and may contain spaces, _, ., :, or -");
  }
}

function validateTask(task: string): void {
  if (!/^[a-z][a-z0-9:_-]{0,63}$/.test(task)) {
    throw new TypeError("Task must be a 1-64 character registered handler key");
  }
}

function validateRunner(runnerId: string): void {
  if (runnerId.trim() === "" || runnerId.length > 200) throw new TypeError("Runner ID is invalid");
}

function validateLease(leaseMs: number): void {
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 1_000 || leaseMs > 24 * 60 * 60_000) {
    throw new TypeError("Lease must be between one second and 24 hours");
  }
}

function assertLimit(limit: number, max = 100): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > max) {
    throw new TypeError(`Limit must be between 1 and ${max}`);
  }
}

function requireJob(job: ScheduledJob | undefined, message: string): ScheduledJob {
  if (job === undefined) throw new Error(message);
  return job;
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
