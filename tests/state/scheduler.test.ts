import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ExyDatabase } from "../../src/db/database.js";
import { SchedulerEngine } from "../../src/scheduler/engine.js";
import { initialRunAt, validateSchedule } from "../../src/scheduler/schedule.js";
import { ScheduledJobStore } from "../../src/scheduler/store.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "exy-scheduler-"));
  temporaryDirectories.push(directory);
  return join(directory, "state.sqlite");
}

describe("persistent scheduler", () => {
  it("atomically prevents overlapping claims and retains run history", () => {
    let now = 10_000;
    const path = databasePath();
    const firstDatabase = new ExyDatabase(path);
    const secondDatabase = new ExyDatabase(path);
    const first = new ScheduledJobStore(firstDatabase, () => now);
    const second = new ScheduledJobStore(secondDatabase, () => now);
    const job = first.create({
      name: "one time research",
      task: "agent:research",
      schedule: { kind: "once", at: now },
      payload: { topic: "x" },
    });

    const claim = first.claim(job.id, "runner-one", 1_000, now);
    expect(claim).toBeDefined();
    expect(second.claim(job.id, "runner-two", 1_000, now)).toBeUndefined();
    expect(first.complete(claim!.run.id, "runner-one", { status: "succeeded", result: { ok: true } }, now + 1))
      .toBe(true);
    expect(first.listRuns(job.id)).toMatchObject([{ status: "succeeded", result: { ok: true } }]);

    firstDatabase.close();
    secondDatabase.close();
    const reopened = new ExyDatabase(path);
    expect(new ScheduledJobStore(reopened).listRuns(job.id)).toHaveLength(1);
    reopened.close();
  });

  it("marks an expired execution lease abandoned before future work", () => {
    let now = 1_000;
    const database = new ExyDatabase(databasePath());
    const store = new ScheduledJobStore(database, () => now);
    const job = store.create({
      name: "heartbeat",
      task: "heartbeat",
      schedule: { kind: "interval", everyMs: 1_000 },
    });
    now = 2_000;
    expect(store.claim(job.id, "dead-runner", 1_000, now)).toBeDefined();
    now = 3_001;
    expect(store.cleanupAbandoned(now)).toBe(1);
    expect(store.listRuns(job.id)[0]).toMatchObject({ status: "abandoned" });
    database.close();
  });

  it("executes only registered in-process handlers", async () => {
    let now = 10_000;
    const database = new ExyDatabase(databasePath());
    const store = new ScheduledJobStore(database, () => now);
    store.create({
      name: "safe task",
      task: "test:handler",
      schedule: { kind: "once", at: now },
      payload: { value: 7 },
    });
    const scheduler = new SchedulerEngine(store, { runnerId: "test-runner", leaseMs: 1_000 });
    scheduler.register("test:handler", ({ payload }) => ({ seen: payload }));
    expect(await scheduler.runDueOnce(now)).toBe(1);
    expect(store.listRuns()[0]).toMatchObject({ status: "succeeded", result: { seen: { value: 7 } } });
    database.close();
  });

  it("aborts a still-live handler when another runner reclaims its expired lease", async () => {
    let now = 1_000;
    const database = new ExyDatabase(databasePath());
    const firstStore = new ScheduledJobStore(database, () => now);
    const secondStore = new ScheduledJobStore(database, () => now);
    const job = firstStore.create({
      name: "cooperative fence",
      task: "test:fenced",
      schedule: { kind: "interval", everyMs: 1_000 },
    });
    now = 2_000;
    const scheduler = new SchedulerEngine(firstStore, { runnerId: "old-runner", leaseMs: 1_000 });
    let handlerStarted!: () => void;
    const started = new Promise<void>((resolve) => (handlerStarted = resolve));
    let observedAbort = false;
    scheduler.register("test:fenced", async ({ signal }) => {
      handlerStarted();
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          observedAbort = true;
          reject(new Error("lease lost"));
        }, { once: true });
      });
    });
    const oldRun = scheduler.runDueOnce(now);
    await started;

    now = 3_001;
    expect(secondStore.cleanupAbandoned(now)).toBe(1);
    const reclaimed = secondStore.claim(job.id, "new-runner", 1_000, now);
    expect(reclaimed).toBeDefined();
    secondStore.complete(reclaimed!.run.id, "new-runner", { status: "succeeded" }, now);

    await oldRun;
    expect(observedAbort).toBe(true);
    expect(firstStore.listRuns(job.id).map((run) => run.status).sort()).toEqual(["abandoned", "succeeded"]);
    database.close();
  });
});

describe("schedule validation", () => {
  it("accepts five-field cron and rejects second-field cron", () => {
    expect(() => validateSchedule({ kind: "cron", expression: "*/5 * * * *", timezone: "UTC" })).not.toThrow();
    expect(() => validateSchedule({ kind: "cron", expression: "0 */5 * * * *", timezone: "UTC" })).toThrow(/five fields/i);
    expect(initialRunAt({ kind: "cron", expression: "0 12 * * *", timezone: "UTC" }, Date.UTC(2026, 0, 1)))
      .toBe(Date.UTC(2026, 0, 1, 12));
  });
});
