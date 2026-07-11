import { describe, expect, it } from "vitest";

import { PerKeySerialQueue } from "../../src/discord/serial-queue.js";

describe("PerKeySerialQueue", () => {
  it("serializes work for one thread", async () => {
    const queue = new PerKeySerialQueue();
    const events: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = queue.enqueue("thread", async () => {
      events.push("first:start");
      await firstGate;
      events.push("first:end");
    });
    const second = queue.enqueue("thread", async () => {
      events.push("second:start");
    });

    await Promise.resolve();
    expect(events).toEqual(["first:start"]);
    releaseFirst?.();
    await Promise.all([first, second]);
    expect(events).toEqual(["first:start", "first:end", "second:start"]);
  });

  it("does not let a rejection poison later work", async () => {
    const queue = new PerKeySerialQueue();
    const failed = queue.enqueue("thread", async () => {
      throw new Error("expected");
    });
    const succeeded = queue.enqueue("thread", async () => "ok");

    await expect(failed).rejects.toThrow("expected");
    await expect(succeeded).resolves.toBe("ok");
  });

  it("allows separate threads to make progress independently", async () => {
    const queue = new PerKeySerialQueue();
    let releaseA: (() => void) | undefined;
    const gateA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    let threadBStarted = false;

    const threadA = queue.enqueue("thread-a", async () => gateA);
    const threadB = queue.enqueue("thread-b", async () => {
      threadBStarted = true;
    });

    await threadB;
    expect(threadBStarted).toBe(true);
    releaseA?.();
    await threadA;
  });
});
