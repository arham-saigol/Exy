/**
 * The small, Discord-library-independent projection needed to route a message.
 * Keeping this pure makes the authorization boundary easy to exhaustively test.
 */
export interface DiscordRoutingMessage {
  messageId: string;
  guildId?: string;
  channelId: string;
  channelKind: "parent" | "thread" | "other";
  authorId: string;
  authorIsBot: boolean;
  /** True only for ordinary user messages and user replies. */
  isUserMessage: boolean;
  mentionsBot: boolean;
  /** Discord reports that the parent message already owns a thread. */
  starterHasThread: boolean;
  /** A durable Exy registration exists for the starter message/thread id. */
  starterRegistered: boolean;
  /** The current thread is durably registered as an active Exy thread. */
  threadRegistered: boolean;
}

export interface DiscordRoutingConfig {
  authorizedUserId: string;
}

export type DiscordIgnoreReason =
  | "bot_message"
  | "non_user_message"
  | "direct_message"
  | "wrong_user"
  | "wrong_channel"
  | "missing_mention"
  | "duplicate_starter"
  | "starter_already_has_thread"
  | "unregistered_thread";

export type DiscordRoutingDecision =
  | {
      action: "ignore";
      reason: DiscordIgnoreReason;
    }
  | {
      action: "create_thread";
      starterMessageId: string;
    }
  | {
      action: "continue_thread";
      threadId: string;
    };

/**
 * Decide whether a Discord message may enter Exy's runtime.
 *
 * Authorization checks deliberately precede conversational checks so a caller
 * cannot learn whether a message/thread has internal Exy state.
 */
export function decideDiscordMessageRoute(
  config: DiscordRoutingConfig,
  message: DiscordRoutingMessage,
): DiscordRoutingDecision {
  if (message.authorIsBot) {
    return { action: "ignore", reason: "bot_message" };
  }

  if (!message.isUserMessage) {
    return { action: "ignore", reason: "non_user_message" };
  }

  if (message.guildId === undefined) {
    return { action: "ignore", reason: "direct_message" };
  }

  if (message.authorId !== config.authorizedUserId) {
    return { action: "ignore", reason: "wrong_user" };
  }

  if (message.channelKind === "parent") {
    if (!message.mentionsBot) {
      return { action: "ignore", reason: "missing_mention" };
    }

    if (message.starterRegistered) {
      return { action: "ignore", reason: "duplicate_starter" };
    }

    // Never adopt a thread created by somebody else merely because its starter
    // mentions Exy. Exy-created threads are claimed before the API call.
    if (message.starterHasThread) {
      return { action: "ignore", reason: "starter_already_has_thread" };
    }

    return {
      action: "create_thread",
      starterMessageId: message.messageId,
    };
  }

  if (message.channelKind === "thread") {
    if (!message.threadRegistered) {
      return { action: "ignore", reason: "unregistered_thread" };
    }

    return {
      action: "continue_thread",
      threadId: message.channelId,
    };
  }

  return { action: "ignore", reason: "wrong_channel" };
}
