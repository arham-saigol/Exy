import type { AgentProgressEvent } from "../core/progress.js";

export interface DiscordProgressTransport {
  send(content: string): Promise<void>;
}

export interface DiscordProgressLogger {
  warn(message: string, context?: Readonly<Record<string, unknown>>): void;
}

/** Ordered delivery of complete assistant messages and sanitized activity statuses. */
export class DiscordProgressStream {
  private operations: Promise<void> = Promise.resolve();
  private finished = false;

  constructor(
    private readonly transport: DiscordProgressTransport,
    private readonly logger: DiscordProgressLogger,
  ) {}

  handle(event: AgentProgressEvent): Promise<void> {
    if (this.finished) return Promise.resolve();
    const content = event.type === "tool_status" ? `*${event.message}…*` : event.message;
    return this.enqueue(() => this.sendSafely(content));
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
        operation: "send ordered progress",
        errorName: error instanceof Error ? error.name : typeof error,
      });
    }
  }
}
