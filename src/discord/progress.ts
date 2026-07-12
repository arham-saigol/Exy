import type { AgentProgressEvent } from "../core/progress.js";

export interface DiscordProgressTransport {
  send(content: string): Promise<void>;
}

export interface DiscordProgressLogger {
  warn(message: string, context?: Readonly<Record<string, unknown>>): void;
}

/** Ordered delivery of sanitized activity statuses for one active Discord run. */
export class DiscordProgressStream {
  private operations: Promise<void> = Promise.resolve();
  private finished = false;

  constructor(
    private readonly transport: DiscordProgressTransport,
    private readonly logger: DiscordProgressLogger,
  ) {}

  handle(event: AgentProgressEvent): Promise<void> {
    if (this.finished) return Promise.resolve();
    return this.enqueue(() => this.sendSafely(`*${event.message}…*`));
  }

  async finish(): Promise<void> {
    if (this.finished) {
      await this.operations;
      return;
    }
    this.finished = true;
    await this.operations;
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    this.operations = this.operations.then(operation, operation);
    return this.operations;
  }

  private async sendSafely(content: string): Promise<void> {
    try {
      await this.transport.send(content);
    } catch (error) {
      this.logger.warn("Discord progress delivery failed", {
        operation: "send tool status",
        errorName: error instanceof Error ? error.name : typeof error,
      });
    }
  }
}
