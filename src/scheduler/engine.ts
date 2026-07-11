import { hostname } from "node:os";
import { randomUUID } from "node:crypto";

import type { JsonValue } from "../db/json.js";
import type { ClaimedJob, ScheduledJobStore } from "./store.js";

export interface ScheduledTaskContext {
  jobId: string;
  runId: string;
  scheduledFor: number;
  payload: JsonValue;
  signal: AbortSignal;
}

export type ScheduledTaskHandler = (
  context: ScheduledTaskContext,
) => JsonValue | void | Promise<JsonValue | void>;

export interface SchedulerEngineOptions {
  pollIntervalMs?: number;
  leaseMs?: number;
  maxClaimsPerTick?: number;
  runnerId?: string;
  onError?: (error: unknown) => void;
}

/**
 * Polling runtime over the persistent store. Handlers are registered functions,
 * not user-provided commands, keeping schedule CRUD free of shell execution.
 */
export class SchedulerEngine {
  readonly runnerId: string;

  private readonly pollIntervalMs: number;
  private readonly leaseMs: number;
  private readonly maxClaimsPerTick: number;
  private readonly onError: (error: unknown) => void;
  private readonly handlers = new Map<string, ScheduledTaskHandler>();
  private readonly active = new Map<string, AbortController>();
  private timer: NodeJS.Timeout | undefined;
  private ticking = false;

  constructor(
    private readonly store: ScheduledJobStore,
    options: SchedulerEngineOptions = {},
  ) {
    this.pollIntervalMs = options.pollIntervalMs ?? 1_000;
    this.leaseMs = options.leaseMs ?? 5 * 60_000;
    this.maxClaimsPerTick = options.maxClaimsPerTick ?? 10;
    this.runnerId = options.runnerId ?? `${hostname()}:${process.pid}:${randomUUID()}`;
    this.onError = options.onError ?? (() => undefined);
    if (!Number.isSafeInteger(this.pollIntervalMs) || this.pollIntervalMs < 100) {
      throw new TypeError("Scheduler poll interval must be at least 100ms");
    }
    if (!Number.isSafeInteger(this.maxClaimsPerTick) || this.maxClaimsPerTick < 1 || this.maxClaimsPerTick > 100) {
      throw new TypeError("maxClaimsPerTick must be between 1 and 100");
    }
    if (!Number.isSafeInteger(this.leaseMs) || this.leaseMs < 1_000 || this.leaseMs > 24 * 60 * 60_000) {
      throw new TypeError("Scheduler lease must be between one second and 24 hours");
    }
  }

  register(task: string, handler: ScheduledTaskHandler): () => void {
    if (this.handlers.has(task)) throw new Error(`A scheduler handler is already registered for ${task}`);
    this.handlers.set(task, handler);
    return () => {
      if (this.handlers.get(task) === handler) this.handlers.delete(task);
    };
  }

  start(): void {
    if (this.timer !== undefined) return;
    this.store.cleanupAbandoned();
    this.timer = setInterval(() => void this.tickSafely(), this.pollIntervalMs);
    this.timer.unref();
    void this.tickSafely();
  }

  stop(options: { abortRunning?: boolean } = {}): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    if (options.abortRunning) {
      for (const controller of this.active.values()) controller.abort("Scheduler stopped");
    }
  }

  interrupt(runId?: string): number {
    if (runId !== undefined) {
      const controller = this.active.get(runId);
      if (controller === undefined) return 0;
      controller.abort("Scheduled execution interrupted");
      return 1;
    }
    for (const controller of this.active.values()) controller.abort("Scheduled executions interrupted");
    return this.active.size;
  }

  async waitForIdle(timeoutMs = 5_000): Promise<boolean> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0) {
      throw new TypeError("Scheduler drain timeout must be a non-negative integer");
    }
    const deadline = Date.now() + timeoutMs;
    while (this.active.size > 0) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return false;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, Math.min(25, remaining));
        timer.unref();
      });
    }
    return true;
  }

  /** Runs one deterministic polling cycle; useful for startup and tests. */
  async runDueOnce(now = Date.now()): Promise<number> {
    this.store.cleanupAbandoned(now);
    const due = this.store.due(this.maxClaimsPerTick, now);
    const claims: ClaimedJob[] = [];
    for (const job of due) {
      const claim = this.store.claim(job.id, this.runnerId, this.leaseMs, now);
      if (claim !== undefined) claims.push(claim);
    }
    await Promise.all(claims.map(async (claim) => this.execute(claim)));
    return claims.length;
  }

  private async tickSafely(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.runDueOnce();
    } catch (error) {
      this.onError(error);
    } finally {
      this.ticking = false;
    }
  }

  private async execute(claim: ClaimedJob): Promise<void> {
    const controller = new AbortController();
    this.active.set(claim.run.id, controller);
    let leaseLost = false;
    const loseLease = (cause: unknown): void => {
      if (leaseLost) return;
      leaseLost = true;
      const error = cause instanceof Error ? cause : new Error(String(cause));
      controller.abort(error);
      this.onError(error);
    };
    // Renew with multiple chances before expiry, including at the 1s minimum.
    const renewEvery = Math.max(100, Math.floor(this.leaseMs / 3));
    const renewal = setInterval(() => {
      try {
        if (!this.store.renew(claim.run.id, this.runnerId, this.leaseMs)) {
          clearInterval(renewal);
          loseLease(new Error(`Scheduler execution ${claim.run.id} lost its lease`));
        }
      } catch (error) {
        clearInterval(renewal);
        loseLease(error);
      }
    }, renewEvery);
    renewal.unref();

    try {
      const handler = this.handlers.get(claim.job.task);
      if (handler === undefined) throw new Error(`No scheduler handler is registered for task ${claim.job.task}`);
      const result = await handler({
        jobId: claim.job.id,
        runId: claim.run.id,
        scheduledFor: claim.run.scheduledFor,
        payload: claim.job.payload,
        signal: controller.signal,
      });
      if (leaseLost) return;
      const completed = this.store.complete(claim.run.id, this.runnerId, {
        status: "succeeded",
        ...(result === undefined ? {} : { result }),
      });
      if (!completed) loseLease(new Error(`Scheduler execution ${claim.run.id} could not commit completion`));
    } catch (error) {
      if (leaseLost) return;
      const completed = this.store.complete(claim.run.id, this.runnerId, {
        status: "failed",
        error: safeExecutionError(error),
      });
      if (!completed) loseLease(new Error(`Scheduler execution ${claim.run.id} lost its lease after failure`));
    } finally {
      clearInterval(renewal);
      this.active.delete(claim.run.id);
    }
  }
}

function safeExecutionError(error: unknown): string {
  // Do not persist stacks: they can contain payload fragments or environment paths.
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}
