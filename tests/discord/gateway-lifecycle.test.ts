import { EventEmitter } from "node:events";

import { ChannelType, MessageType, type Client } from "discord.js";
import { describe, expect, it, vi } from "vitest";

import type { DiscordGatewayOptions } from "../../src/discord/contracts.js";
import { DiscordGateway } from "../../src/discord/gateway.js";

class FakeClient extends EventEmitter {
  readonly destroy = vi.fn(async () => undefined);
  readonly login = vi.fn(async () => "token");
  readonly user = { id: "bot-1" };
  readonly channels = { fetch: vi.fn() };

  isReady(): boolean {
    return true;
  }
}

function gatewayOptions(
  client: FakeClient,
  overrides: Partial<DiscordGatewayOptions> = {},
): DiscordGatewayOptions {
  return {
    config: {
      applicationId: "app-1",
      authorizedUserId: "user-1",
    },
    botToken: "test-token",
    client: client as unknown as Client,
    threadStore: {
      get: vi.fn(async () => undefined),
      claim: vi.fn(async () => true),
      activate: vi.fn(async () => undefined),
      fail: vi.fn(async () => undefined),
    },
    runConversation: vi.fn(async () => undefined),
    modelController: {
      listModels: vi.fn(async () => []),
      getSelection: vi.fn(async () => ({ modelId: "model", reasoning: "low" })),
      selectModel: vi.fn(async () => undefined),
      selectReasoning: vi.fn(async () => undefined),
    },
    onRestart: vi.fn(),
    registerCommands: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe("DiscordGateway lifecycle", () => {
  it("starts and stops idempotently while registering discovered-guild commands once", async () => {
    const client = new FakeClient();
    const options = gatewayOptions(client);
    const gateway = new DiscordGateway(options);

    await Promise.all([gateway.start(), gateway.start()]);
    expect(gateway.isRunning).toBe(true);
    expect(options.registerCommands).toHaveBeenCalledTimes(1);
    expect(client.login).not.toHaveBeenCalled();

    await Promise.all([gateway.stop(), gateway.stop()]);
    expect(gateway.isRunning).toBe(false);
    expect(client.destroy).not.toHaveBeenCalled();
    expect(client.listenerCount("messageCreate")).toBe(0);
    expect(client.listenerCount("interactionCreate")).toBe(0);
  });

  it("cleans up listeners after startup registration fails", async () => {
    const client = new FakeClient();
    const options = gatewayOptions(client, {
      registerCommands: vi.fn(async () => {
        throw new Error("registration failed");
      }),
    });
    const gateway = new DiscordGateway(options);

    await expect(gateway.start()).rejects.toThrow("registration failed");
    expect(gateway.isRunning).toBe(false);
    expect(client.listenerCount("messageCreate")).toBe(0);
    expect(client.listenerCount("interactionCreate")).toBe(0);
  });

  it("recovers a bot-owned durable creating thread during startup", async () => {
    const client = new FakeClient();
    const registration = {
      threadId: "starter-1",
      starterMessageId: "starter-1",
      guildId: "guild-1",
      parentChannelId: "parent-1",
      authorizedUserId: "user-1",
      claimedAt: "2026-07-11T00:00:00.000Z",
      status: "creating" as const,
    };
    client.channels.fetch.mockResolvedValue({
      id: "starter-1",
      guildId: "guild-1",
      parentId: "parent-1",
      ownerId: "bot-1",
      isThread: () => true,
    });
    const activate = vi.fn(async () => undefined);
    const gateway = new DiscordGateway(gatewayOptions(client, {
      threadStore: {
        get: vi.fn(async () => undefined),
        listCreating: vi.fn(async () => [registration]),
        claim: vi.fn(async () => true),
        activate,
        fail: vi.fn(async () => undefined),
      },
    }));

    await gateway.start();
    expect(activate).toHaveBeenCalledWith(expect.objectContaining({
      threadId: "starter-1",
      status: "active",
    }));
    await gateway.stop();
  });

  it("can own and destroy an injected client when explicitly requested", async () => {
    const client = new FakeClient();
    const gateway = new DiscordGateway(
      gatewayOptions(client, { destroyInjectedClientOnStop: true }),
    );

    await gateway.start();
    await gateway.stop();
    expect(client.destroy).toHaveBeenCalledTimes(1);
  });

  it("discovers the guild and parent channel from an authorized starter", async () => {
    const client = new FakeClient();
    const claim = vi.fn(async () => true);
    const thread = {
      id: "starter-2",
      guildId: "guild-2",
      parentId: "parent-2",
      isThread: () => true,
      sendTyping: vi.fn(async () => undefined),
      send: vi.fn(async () => undefined),
    };
    const gateway = new DiscordGateway(gatewayOptions(client, {
      threadStore: {
        get: vi.fn(async () => undefined),
        claim,
        activate: vi.fn(async () => undefined),
        fail: vi.fn(async () => undefined),
      },
    }));
    await gateway.start();

    client.emit("messageCreate", {
      id: "starter-2",
      channelId: "parent-2",
      channel: { type: ChannelType.GuildText, isThread: () => false },
      guildId: "guild-2",
      author: { id: "user-1", bot: false },
      type: MessageType.Default,
      mentions: { users: { has: () => true } },
      hasThread: false,
      content: "<@bot-1> hello",
      attachments: [],
      createdAt: new Date(),
      startThread: vi.fn(async () => thread),
      reply: vi.fn(async () => undefined),
    });

    await vi.waitFor(() => expect(claim).toHaveBeenCalledWith(expect.objectContaining({
      guildId: "guild-2",
      parentChannelId: "parent-2",
      authorizedUserId: "user-1",
    })));
    await gateway.stop();
  });

  it("commits a structured response only after Discord delivery succeeds", async () => {
    const client = new FakeClient();
    const onDelivered = vi.fn(async () => undefined);
    const onDeliveryFailed = vi.fn(async () => undefined);
    const onChunkDelivered = vi.fn(async () => undefined);
    const send = vi.fn(async () => ({ id: "response" }));
    const thread = {
      id: "thread-1",
      guildId: "guild-1",
      parentId: "parent-1",
      isThread: () => true,
      sendTyping: vi.fn(async () => undefined),
      send,
    };
    const options = gatewayOptions(client, {
      threadStore: {
        get: vi.fn(async () => ({
          threadId: "thread-1",
          starterMessageId: "thread-1",
          guildId: "guild-1",
          parentChannelId: "parent-1",
          authorizedUserId: "user-1",
          claimedAt: new Date().toISOString(),
          status: "active",
        })),
        claim: vi.fn(async () => true),
        activate: vi.fn(async () => undefined),
        fail: vi.fn(async () => undefined),
      },
      runConversation: vi.fn(async () => ({ content: "recommendation", onChunkDelivered, onDelivered, onDeliveryFailed })),
    });
    const gateway = new DiscordGateway(options);
    await gateway.start();
    client.emit("messageCreate", threadMessage(thread));

    await vi.waitFor(() => expect(onDelivered).toHaveBeenCalledOnce());
    expect(send).toHaveBeenCalledOnce();
    expect(onChunkDelivered).toHaveBeenCalledWith("recommendation", 0);
    expect(onDeliveryFailed).not.toHaveBeenCalled();
    await gateway.stop();
  });

  it("rolls back a structured response when Discord delivery fails", async () => {
    const client = new FakeClient();
    const onDelivered = vi.fn(async () => undefined);
    const onDeliveryFailed = vi.fn(async () => undefined);
    const onChunkDelivered = vi.fn(async () => undefined);
    const thread = {
      id: "thread-1",
      guildId: "guild-1",
      parentId: "parent-1",
      isThread: () => true,
      sendTyping: vi.fn(async () => undefined),
      send: vi.fn(async () => { throw new Error("Discord unavailable"); }),
    };
    const options = gatewayOptions(client, {
      threadStore: {
        get: vi.fn(async () => ({
          threadId: "thread-1",
          starterMessageId: "thread-1",
          guildId: "guild-1",
          parentChannelId: "parent-1",
          authorizedUserId: "user-1",
          claimedAt: new Date().toISOString(),
          status: "active",
        })),
        claim: vi.fn(async () => true),
        activate: vi.fn(async () => undefined),
        fail: vi.fn(async () => undefined),
      },
      runConversation: vi.fn(async () => ({ content: "recommendation", onChunkDelivered, onDelivered, onDeliveryFailed })),
    });
    const gateway = new DiscordGateway(options);
    await gateway.start();
    client.emit("messageCreate", threadMessage(thread));

    await vi.waitFor(() => expect(onDeliveryFailed).toHaveBeenCalledOnce());
    expect(onDelivered).not.toHaveBeenCalled();
    expect(onChunkDelivered).not.toHaveBeenCalled();
    await gateway.stop();
  });
});

function threadMessage(thread: { id: string; isThread(): boolean }): unknown {
  return {
    id: "message-1",
    channelId: thread.id,
    channel: thread,
    guildId: "guild-1",
    author: { id: "user-1", bot: false },
    type: MessageType.Default,
    mentions: { users: { has: () => false } },
    hasThread: false,
    content: "continue",
    attachments: [],
    createdAt: new Date(),
  };
}
