/** A small per-key FIFO that never lets one rejected task poison the queue. */
export class PerKeySerialQueue {
  private readonly tails = new Map<string, Promise<void>>();

  enqueue<T>(key: string, task: () => Promise<T>): Promise<T> {
    const predecessor = this.tails.get(key) ?? Promise.resolve();
    const result = predecessor.then(task, task);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );

    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) {
        this.tails.delete(key);
      }
    });

    return result;
  }

  async drain(): Promise<void> {
    await Promise.allSettled([...this.tails.values()]);
  }

  get size(): number {
    return this.tails.size;
  }
}
