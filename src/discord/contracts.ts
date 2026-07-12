import type {
  Client,
  RESTPostAPIApplicationCommandsJSONBody,
} from "discord.js";

import type { DiscordConfig } from "../core/types.js";
import type { AgentProgressSink } from "../core/progress.js";

export type DiscordThreadStatus = "creating" | "active" | "failed";

export interface DiscordThreadClaim {
  threadId: string;
  starterMessageId: string;
  guildId: string;
  parentChannelId: string;
  authorizedUserId: string;
  claimedAt: string;
}

export interface DiscordThreadRegistration extends DiscordThreadClaim {
  status: DiscordThreadStatus;
  activatedAt?: string;
}

/**
 * Persistence boundary for Discord-created conversations.
 * `claim` must be atomic and return false when the thread/starter was claimed
 * before, including by another gateway process.
 */
export interface DiscordThreadStore {
  get(threadId: string): Promise<DiscordThreadRegistration | undefined>;
  /** Durable claims that may need recovery after a gateway crash. */
  listCreating?(): Promise<readonly DiscordThreadRegistration[]>;
  claim(claim: DiscordThreadClaim): Promise<boolean>;
  activate(registration: DiscordThreadRegistration): Promise<void>;
  fail(threadId: string, reasonCode: string): Promise<void>;
}

export interface DiscordAttachment {
  id: string;
  name: string;
  url: string;
  size: number;
  contentType?: string;
}

export interface DiscordConversationTurn {
  threadId: string;
  guildId: string;
  parentChannelId: string;
  messageId: string;
  userId: string;
  content: string;
  attachments: readonly DiscordAttachment[];
  createdAt: Date;
  signal: AbortSignal;
  /** Ordered, sanitized activity statuses. Model-authored text is final-only. */
  onProgress: AgentProgressSink;
}

export interface DiscordConversationResponse {
  content: string;
  /** Called after each accepted chunk with the complete accepted prefix. */
  onChunkDelivered?: (deliveredContent: string, chunkIndex: number) => Promise<void> | void;
  /** Called only after every Discord message chunk was accepted. */
  onDelivered?: () => Promise<void> | void;
  /** Called when output is suppressed, interrupted, or not fully delivered. */
  onDeliveryFailed?: () => Promise<void> | void;
}

/** Return final user-visible text. Returning undefined emits no Discord reply. */
export type DiscordConversationRunner = (
  turn: DiscordConversationTurn,
) => Promise<string | DiscordConversationResponse | undefined>;

export interface DiscordModelDescriptor {
  /** Exact value Pi expects when selecting this model. */
  id: string;
  /** Optional user-facing label. */
  name?: string;
  reasoningLevels: readonly string[];
}

export interface DiscordModelSelection {
  modelId: string;
  reasoning: string;
}

export interface DiscordModelController {
  listModels(): Promise<readonly DiscordModelDescriptor[]>;
  getSelection(): Promise<DiscordModelSelection>;
  selectModel(modelId: string): Promise<void>;
  selectReasoning(reasoning: string): Promise<void>;
}

export interface DiscordLogger {
  debug(message: string, context?: Readonly<Record<string, unknown>>): void;
  info(message: string, context?: Readonly<Record<string, unknown>>): void;
  warn(message: string, context?: Readonly<Record<string, unknown>>): void;
  error(message: string, context?: Readonly<Record<string, unknown>>): void;
}

export type DiscordCommandRegistrar = (
  commands: readonly RESTPostAPIApplicationCommandsJSONBody[],
  guildId: string,
) => Promise<void>;

export interface DiscordGatewayOptions {
  config: DiscordConfig;
  botToken: string;
  threadStore: DiscordThreadStore;
  runConversation: DiscordConversationRunner;
  /** Optional runtime-level interrupt for scheduled/heartbeat turns in a thread. */
  interruptConversation?: (threadId: string) => Promise<boolean> | boolean;
  modelController: DiscordModelController;
  /** Called only after Discord has received the restart acknowledgement. */
  onRestart: () => Promise<void> | void;
  logger?: DiscordLogger;
  /** Convert a runtime failure to safe user-visible text. */
  publicErrorMessage?: (error: unknown) => string;
  /** Primarily useful for tests or an application-owned Discord client. */
  client?: Client;
  /** Defaults to true for an internally-created client and false for injection. */
  destroyInjectedClientOnStop?: boolean;
  /** Override REST registration in tests. */
  registerCommands?: DiscordCommandRegistrar;
  modelCacheMilliseconds?: number;
  threadAutoArchiveMinutes?: 60 | 1440 | 4320 | 10080;
  /** Test/operations override; defaults to eight seconds. */
  typingIntervalMilliseconds?: number;
}
