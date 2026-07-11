import { Cron } from "croner";

export type JobSchedule = IntervalSchedule | OnceSchedule | CronSchedule;

export interface IntervalSchedule {
  kind: "interval";
  everyMs: number;
}

export interface OnceSchedule {
  kind: "once";
  at: number;
}

export interface CronSchedule {
  kind: "cron";
  /** Deliberately five fields: minute hour day-of-month month day-of-week. */
  expression: string;
  timezone?: string;
}

export function validateSchedule(schedule: JobSchedule): void {
  switch (schedule.kind) {
    case "interval":
      if (!Number.isSafeInteger(schedule.everyMs) || schedule.everyMs < 1_000) {
        throw new TypeError("Interval must be a whole number of milliseconds and at least one second");
      }
      return;
    case "once":
      if (!Number.isSafeInteger(schedule.at) || schedule.at < 0) {
        throw new TypeError("One-time schedule must use a non-negative epoch-millisecond timestamp");
      }
      return;
    case "cron": {
      const expression = schedule.expression.trim();
      if (expression.split(/\s+/).length !== 5) {
        throw new TypeError("Cron expressions must contain exactly five fields (minute through weekday)");
      }
      const timezone = schedule.timezone ?? "UTC";
      assertTimezone(timezone);
      try {
        new Cron(expression, { timezone, paused: true }).stop();
      } catch (error) {
        throw new TypeError(`Invalid cron expression: ${errorMessage(error)}`);
      }
      return;
    }
  }
}

export function initialRunAt(schedule: JobSchedule, now: number): number | null {
  validateSchedule(schedule);
  switch (schedule.kind) {
    case "interval":
      return now + schedule.everyMs;
    case "once":
      return schedule.at;
    case "cron":
      return nextCronRun(schedule, now);
  }
}

/** Computes the next occurrence strictly after `now`, skipping missed backlog. */
export function nextRunAfterClaim(
  schedule: JobSchedule,
  scheduledFor: number,
  now: number,
): number | null {
  switch (schedule.kind) {
    case "once":
      return null;
    case "interval": {
      const elapsed = Math.max(0, now - scheduledFor);
      const intervals = Math.floor(elapsed / schedule.everyMs) + 1;
      return scheduledFor + intervals * schedule.everyMs;
    }
    case "cron":
      return nextCronRun(schedule, Math.max(now, scheduledFor));
  }
}

function nextCronRun(schedule: CronSchedule, after: number): number | null {
  const evaluator = new Cron(schedule.expression.trim(), {
    timezone: schedule.timezone ?? "UTC",
    paused: true,
  });
  try {
    return evaluator.nextRun(new Date(after))?.getTime() ?? null;
  } finally {
    evaluator.stop();
  }
}

function assertTimezone(timezone: string): void {
  if (timezone.trim() === "" || timezone.length > 100) throw new TypeError("Timezone is invalid");
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(0);
  } catch {
    throw new TypeError(`Unknown timezone: ${timezone}`);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
