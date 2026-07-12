import type { AgentProgressEvent } from "../core/progress.js";
import { chunkDiscordMessage } from "./chunking.js";

export interface DiscordProgressMessage {
  edit(content: string): Promise<void>;
}

export interface DiscordProgressTransport {
  send(content: string): Promise<DiscordProgressMessage>;
}

export interface DiscordProgressLogger {
  warn(message: string, context?: Readonly<Record<string, unknown>>): void;
}

export interface DiscordProgressStreamOptions {
  updateIntervalMilliseconds?: number;
}

interface SentChunk {
  content: string;
  message: DiscordProgressMessage;
}

interface AssistantSegment {
  text: string;
  sent: SentChunk[];
}

const DEFAULT_UPDATE_INTERVAL_MILLISECONDS = 750;

/** Ordered, edit-based delivery for one active Discord run. */
export class DiscordProgressStream {
  private readonly updateIntervalMilliseconds: number;
  private current: AssistantSegment | undefined;
  private timer: NodeJS.Timeout | undefined;
  private operations: Promise<void> = Promise.resolve();
  private finished = false;

  constructor(
    private readonly transport: DiscordProgressTransport,
    private readonly logger: DiscordProgressLogger,
    options: DiscordProgressStreamOptions = {},
  ) {
    const interval = options.updateIntervalMilliseconds
      ?? DEFAULT_UPDATE_INTERVAL_MILLISECONDS;
    if (!Number.isFinite(interval) || interval < 0) {
      throw new RangeError("Discord progress update interval must not be negative");
    }
    this.updateIntervalMilliseconds = interval;
  }

  handle(event: AgentProgressEvent): Promise<void> {
    if (this.finished) return Promise.resolve();
    if (event.type === "assistant_text") {
      if (event.delta === "") return Promise.resolve();
      this.current ??= { text: "", sent: [] };
      this.current.text += event.delta;
      this.scheduleFlush();
      return Promise.resolve();
    }

    return this.enqueue(async () => {
      this.clearTimer();
      await this.flushCurrent();
      this.current = undefined;
      await this.sendSafely(`*${event.message}…*`, "tool status");
    });
  }

  async finish(): Promise<void> {
    if (this.finished) {
      await this.operations;
      return;
    }
    this.finished = true;
    this.clearTimer();
    await this.enqueue(() => this.flushCurrent());
  }

  private scheduleFlush(): void {
    if (this.timer !== undefined) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.enqueue(() => this.flushCurrent());
    }, this.updateIntervalMilliseconds);
    this.timer.unref?.();
  }

  private clearTimer(): void {
    if (this.timer === undefined) return;
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    this.operations = this.operations.then(operation, operation);
    return this.operations;
  }

  private async flushCurrent(): Promise<void> {
    const segment = this.current;
    if (segment === undefined || segment.text === "") return;
    const chunks = chunkDiscordMessage(segment.text);
    for (let index = 0; index < chunks.length; index += 1) {
      const content = chunks[index]!;
      const existing = segment.sent[index];
      if (existing?.content === content) continue;
      if (existing !== undefined) {
        try {
          await existing.message.edit(content);
          existing.content = content;
        } catch (error) {
          this.logFailure("edit assistant progress", error);
        }
        continue;
      }
      const message = await this.sendSafely(content, "assistant progress");
      if (message === undefined) break;
      segment.sent.push({ content, message });
    }
  }

  private async sendSafely(
    content: string,
    kind: string,
  ): Promise<DiscordProgressMessage | undefined> {
    try {
      return await this.transport.send(content);
    } catch (error) {
      this.logFailure(`send ${kind}`, error);
      return undefined;
    }
  }

  private logFailure(operation: string, error: unknown): void {
    this.logger.warn("Discord progress delivery failed", {
      operation,
      errorName: error instanceof Error ? error.name : typeof error,
    });
  }
}
