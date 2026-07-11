import { describe, expect, it } from "vitest";

import {
  decideDiscordMessageRoute,
  type DiscordRoutingMessage,
} from "../../src/discord/routing.js";

const config = {
  authorizedUserId: "user-1",
};

function parentMessage(
  overrides: Partial<DiscordRoutingMessage> = {},
): DiscordRoutingMessage {
  return {
    messageId: "message-1",
    guildId: "guild-1",
    channelId: "parent-1",
    channelKind: "parent",
    authorId: "user-1",
    authorIsBot: false,
    isUserMessage: true,
    mentionsBot: true,
    starterHasThread: false,
    starterRegistered: false,
    threadRegistered: false,
    ...overrides,
  };
}

function threadMessage(
  overrides: Partial<DiscordRoutingMessage> = {},
): DiscordRoutingMessage {
  return {
    ...parentMessage(),
    messageId: "message-2",
    channelId: "thread-1",
    channelKind: "thread",
    mentionsBot: false,
    threadRegistered: true,
    ...overrides,
  };
}

describe("decideDiscordMessageRoute", () => {
  it("accepts the authorized user from any guild", () => {
    expect(
      decideDiscordMessageRoute(config, parentMessage({ guildId: "guild-2" })),
    ).toEqual({ action: "create_thread", starterMessageId: "message-1" });
  });

  it("rejects direct messages", () => {
    expect(
      decideDiscordMessageRoute(config, parentMessage({ guildId: undefined })),
    ).toEqual({ action: "ignore", reason: "direct_message" });
  });

  it("rejects a message from the wrong user", () => {
    expect(
      decideDiscordMessageRoute(config, parentMessage({ authorId: "user-2" })),
    ).toEqual({ action: "ignore", reason: "wrong_user" });
  });

  it("accepts mentions in any projected guild text channel", () => {
    expect(
      decideDiscordMessageRoute(
        config,
        parentMessage({ channelId: "parent-2" }),
      ),
    ).toEqual({ action: "create_thread", starterMessageId: "message-1" });
  });

  it("creates a thread for an authorized parent-channel mention", () => {
    expect(decideDiscordMessageRoute(config, parentMessage())).toEqual({
      action: "create_thread",
      starterMessageId: "message-1",
    });
  });

  it("ignores an unmentioned message in the parent channel", () => {
    expect(
      decideDiscordMessageRoute(config, parentMessage({ mentionsBot: false })),
    ).toEqual({ action: "ignore", reason: "missing_mention" });
  });

  it("continues an existing registered Exy thread without a mention", () => {
    expect(decideDiscordMessageRoute(config, threadMessage())).toEqual({
      action: "continue_thread",
      threadId: "thread-1",
    });
  });

  it("rejects an arbitrary sibling thread", () => {
    expect(
      decideDiscordMessageRoute(
        config,
        threadMessage({ threadRegistered: false }),
      ),
    ).toEqual({ action: "ignore", reason: "unregistered_thread" });
  });

  it("rejects bot messages", () => {
    expect(
      decideDiscordMessageRoute(config, parentMessage({ authorIsBot: true })),
    ).toEqual({ action: "ignore", reason: "bot_message" });
  });

  it.each([
    "system message",
    "thread starter message",
  ])("rejects a %s", () => {
    expect(
      decideDiscordMessageRoute(config, parentMessage({ isUserMessage: false })),
    ).toEqual({ action: "ignore", reason: "non_user_message" });
  });

  it("rejects a duplicate starter already claimed by Exy", () => {
    expect(
      decideDiscordMessageRoute(
        config,
        parentMessage({ starterRegistered: true, starterHasThread: true }),
      ),
    ).toEqual({ action: "ignore", reason: "duplicate_starter" });
  });

  it("does not adopt a pre-existing non-Exy thread", () => {
    expect(
      decideDiscordMessageRoute(
        config,
        parentMessage({ starterHasThread: true }),
      ),
    ).toEqual({ action: "ignore", reason: "starter_already_has_thread" });
  });
});
