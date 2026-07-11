import {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  MessageType,
  REST,
  Routes,
  ThreadAutoArchiveDuration,
  type AnyThreadChannel,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
  type Interaction,
  type Message,
} from "discord.js";

import { chunkDiscordMessage } from "./chunking.js";
import { buildDiscordApplicationCommands } from "./commands.js";
import type {
  DiscordAttachment,
  DiscordGatewayOptions,
  DiscordLogger,
  DiscordModelDescriptor,
  DiscordThreadClaim,
  DiscordThreadRegistration,
} from "./contracts.js";
import {
  decideDiscordMessageRoute,
  type DiscordRoutingMessage,
} from "./routing.js";
import { PerKeySerialQueue } from "./serial-queue.js";

type GatewayState = "stopped" | "starting" | "running" | "stopping";

interface AuthorizedInteractionScope {
  allowed: boolean;
  threadId?: string;
}

interface ModelCache {
  expiresAt: number;
  models: readonly DiscordModelDescriptor[];
}

const NOOP_LOGGER: DiscordLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const SAFE_RUNTIME_ERROR =
  "Exy couldn't complete that turn. Check `exy logs` for details.";
const SAFE_THREAD_ERROR =
  "I couldn't create the Exy thread. Check the bot's channel permissions and `exy logs`.";

export class DiscordGateway {
  private readonly options: DiscordGatewayOptions;
  private readonly client: Client;
  private readonly logger: DiscordLogger;
  private readonly ownsClient: boolean;
  private readonly queues = new PerKeySerialQueue();
  private readonly activeRuns = new Map<string, AbortController>();

  private state: GatewayState = "stopped";
  private startPromise: Promise<void> | undefined;
  private stopPromise: Promise<void> | undefined;
  private listenersAttached = false;
  private modelCache: ModelCache | undefined;

  private readonly messageListener = (message: Message): void => {
    void this.handleMessage(message).catch((error: unknown) => {
      this.logger.error("Discord message handling failed", errorLogContext(error));
    });
  };

  private readonly interactionListener = (interaction: Interaction): void => {
    void this.handleInteraction(interaction).catch((error: unknown) => {
      this.logger.error(
        "Discord interaction handling failed",
        errorLogContext(error),
      );
    });
  };

  private readonly clientErrorListener = (error: Error): void => {
    this.logger.error("Discord client error", errorLogContext(error));
  };

  constructor(options: DiscordGatewayOptions) {
    this.options = options;
    this.logger = options.logger ?? NOOP_LOGGER;
    this.client =
      options.client ??
      new Client({
        intents: [
          GatewayIntentBits.Guilds,
          GatewayIntentBits.GuildMessages,
          GatewayIntentBits.MessageContent,
        ],
      });
    this.ownsClient =
      options.client === undefined || options.destroyInjectedClientOnStop === true;
  }

  get isRunning(): boolean {
    return this.state === "running";
  }

  async start(): Promise<void> {
    if (this.state === "running") {
      return;
    }
    if (this.startPromise !== undefined) {
      return this.startPromise;
    }

    this.startPromise = this.startInternal();
    try {
      await this.startPromise;
    } finally {
      this.startPromise = undefined;
    }
  }

  async stop(): Promise<void> {
    if (this.stopPromise !== undefined) {
      return this.stopPromise;
    }

    this.stopPromise = this.stopInternal();
    try {
      await this.stopPromise;
    } finally {
      this.stopPromise = undefined;
    }
  }

  /** Interrupt the currently executing turn for one Discord thread. */
  interrupt(threadId: string): boolean {
    const controller = this.activeRuns.get(threadId);
    if (controller === undefined) {
      return false;
    }
    controller.abort(new Error("Interrupted by the authorized Discord user"));
    return true;
  }

  private async startInternal(): Promise<void> {
    if (this.state === "stopping") {
      await this.stopPromise;
    }
    if (this.state === "running") {
      return;
    }

    this.state = "starting";
    this.attachListeners();

    try {
      if (!this.client.isReady()) {
        await this.client.login(this.options.botToken);
      }
      await this.registerCommands();
      await this.recoverCreatingThreads();
      this.state = "running";
      this.logger.info("Discord gateway started");
    } catch (error: unknown) {
      this.state = "stopped";
      this.detachListeners();
      if (this.ownsClient) {
        await this.client.destroy().catch(() => undefined);
      }
      throw error;
    }
  }

  private async stopInternal(): Promise<void> {
    if (this.startPromise !== undefined && this.state === "starting") {
      await this.startPromise.catch(() => undefined);
    }
    if (this.state === "stopped") {
      return;
    }

    this.state = "stopping";
    this.detachListeners();
    for (const controller of this.activeRuns.values()) {
      controller.abort(new Error("Discord gateway is stopping"));
    }

    await withTimeout(this.queues.drain(), 5_000);

    if (this.ownsClient) {
      await this.client.destroy().catch((error: unknown) => {
        this.logger.warn("Discord client shutdown failed", errorLogContext(error));
      });
    }

    this.activeRuns.clear();
    this.state = "stopped";
    this.logger.info("Discord gateway stopped");
  }

  private attachListeners(): void {
    if (this.listenersAttached) {
      return;
    }
    this.client.on(Events.MessageCreate, this.messageListener);
    this.client.on(Events.InteractionCreate, this.interactionListener);
    this.client.on(Events.Error, this.clientErrorListener);
    this.listenersAttached = true;
  }

  private detachListeners(): void {
    if (!this.listenersAttached) {
      return;
    }
    this.client.off(Events.MessageCreate, this.messageListener);
    this.client.off(Events.InteractionCreate, this.interactionListener);
    this.client.off(Events.Error, this.clientErrorListener);
    this.listenersAttached = false;
  }

  private async registerCommands(): Promise<void> {
    const commands = buildDiscordApplicationCommands();
    if (this.options.registerCommands !== undefined) {
      await this.options.registerCommands(commands);
      return;
    }

    const rest = new REST({ version: "10" }).setToken(this.options.botToken);
    await Promise.all(
      [...this.client.guilds.cache.keys()].map((guildId) =>
        rest.put(
          Routes.applicationGuildCommands(this.options.config.applicationId, guildId),
          { body: commands },
        ),
      ),
    );
  }

  private async handleMessage(message: Message): Promise<void> {
    if (this.state !== "running") {
      return;
    }

    const channelKind = message.channel.isThread()
      ? "thread"
      : message.guildId !== null && (
          message.channel.type === ChannelType.GuildText
          || message.channel.type === ChannelType.GuildAnnouncement
        )
        ? "parent"
        : "other";

    const mayInspectState =
      !message.author.bot &&
      (message.type === MessageType.Default || message.type === MessageType.Reply) &&
      message.guildId !== null &&
      message.author.id === this.options.config.authorizedUserId;
    let registration =
      mayInspectState && (channelKind === "parent" || channelKind === "thread")
        ? await this.options.threadStore.get(
            channelKind === "parent" ? message.id : message.channelId,
          )
        : undefined;
    if (
      channelKind === "thread"
      && registration?.status === "creating"
      && message.channel.isThread()
      && this.isRecoverableThread(message.channel, registration)
    ) {
      try {
        const active: DiscordThreadRegistration = {
          ...registration,
          status: "active",
          activatedAt: new Date().toISOString(),
        };
        await this.options.threadStore.activate(active);
        registration = active;
        this.logger.info("Recovered Discord thread claim from an in-thread message", {
          threadId: active.threadId,
        });
      } catch (error) {
        this.logger.error("Discord thread claim recovery failed", errorLogContext(error));
      }
    }
    const botId = this.client.user?.id;
    const guildPart = message.guildId === null ? {} : { guildId: message.guildId };
    const routingMessage: DiscordRoutingMessage = {
      messageId: message.id,
      ...guildPart,
      channelId: message.channelId,
      channelKind,
      authorId: message.author.id,
      authorIsBot: message.author.bot,
      isUserMessage:
        message.type === MessageType.Default ||
        message.type === MessageType.Reply,
      mentionsBot: botId !== undefined && message.mentions.users.has(botId),
      starterHasThread: message.hasThread,
      starterRegistered:
        channelKind === "parent" &&
        registration !== undefined &&
        this.registrationMatchesConfig(registration),
      threadRegistered:
        channelKind === "thread" &&
        registration?.status === "active" &&
        message.channel.isThread() &&
        this.registrationMatchesThread(registration, message.channel),
    };
    const decision = decideDiscordMessageRoute(this.options.config, routingMessage);

    if (decision.action === "ignore") {
      this.logger.debug("Discord message ignored", { reason: decision.reason });
      return;
    }

    if (decision.action === "create_thread") {
      await this.createThreadAndRun(message);
      return;
    }

    if (!message.channel.isThread()) {
      // Defensive: the pure router and Discord channel projection should make
      // this unreachable.
      return;
    }
    await this.enqueueConversation(message.channel, message);
  }

  private async createThreadAndRun(message: Message): Promise<void> {
    if (message.guildId === null || message.channel.isThread()) return;
    const now = new Date();
    const claim: DiscordThreadClaim = {
      threadId: message.id,
      starterMessageId: message.id,
      guildId: message.guildId,
      parentChannelId: message.channelId,
      authorizedUserId: this.options.config.authorizedUserId,
      claimedAt: now.toISOString(),
    };

    const claimed = await this.options.threadStore.claim(claim);
    if (!claimed) {
      this.logger.debug("Duplicate Discord thread starter ignored", {
        starterMessageId: message.id,
      });
      return;
    }

    let thread: AnyThreadChannel;
    try {
      thread = await this.startOrRecoverThread(message);
      const registration: DiscordThreadRegistration = {
        ...claim,
        status: "active",
        activatedAt: new Date().toISOString(),
      };
      await this.options.threadStore.activate(registration);
    } catch (error: unknown) {
      await this.options.threadStore
        .fail(message.id, "thread_creation_failed")
        .catch(() => undefined);
      this.logger.error("Discord thread creation failed", errorLogContext(error));
      await message
        .reply({
          content: SAFE_THREAD_ERROR,
          allowedMentions: { parse: [], repliedUser: false },
        })
        .catch(() => undefined);
      return;
    }

    await this.enqueueConversation(thread, message);
  }

  private async startOrRecoverThread(message: Message): Promise<AnyThreadChannel> {
    try {
      return await message.startThread({
        name: makeThreadName(this.removeBotMention(message.content)),
        autoArchiveDuration:
          this.options.threadAutoArchiveMinutes ??
          ThreadAutoArchiveDuration.OneDay,
        reason: "Authorized user mentioned Exy",
      });
    } catch (originalError: unknown) {
      // The thread id equals the source message id. Recover only a thread owned
      // by this bot; never adopt a user-created sibling after an API race.
      const candidate = await this.client.channels.fetch(message.id).catch(() => null);
      if (
        candidate?.isThread() === true &&
        candidate.guildId === message.guildId &&
        candidate.parentId === message.channelId &&
        candidate.ownerId === this.client.user?.id
      ) {
        return candidate;
      }
      throw originalError;
    }
  }

  private async recoverCreatingThreads(): Promise<void> {
    const registrations = await this.options.threadStore.listCreating?.() ?? [];
    for (const registration of registrations) {
      if (!this.registrationMatchesConfig(registration)) continue;
      try {
        await this.recoverCreatingThread(registration);
        this.logger.info("Recovered Discord thread claim at startup", {
          threadId: registration.threadId,
        });
      } catch (error) {
        // Leave the durable claim in creating state. A later restart or a
        // message inside an already-created bot thread can retry safely.
        this.logger.warn("Discord thread claim remains pending recovery", {
          threadId: registration.threadId,
          ...errorLogContext(error),
        });
      }
    }
  }

  private async recoverCreatingThread(registration: DiscordThreadRegistration): Promise<void> {
    const candidate = await this.client.channels.fetch(registration.threadId).catch(() => null);
    let thread: AnyThreadChannel;
    if (candidate?.isThread() === true && this.isRecoverableThread(candidate, registration)) {
      thread = candidate;
    } else {
      const parent = await this.client.channels.fetch(registration.parentChannelId);
      if (parent === null || !parent.isTextBased() || !("messages" in parent)) {
        throw new Error("The Discord parent channel cannot fetch the claimed starter message");
      }
      const starter = await parent.messages.fetch(registration.starterMessageId);
      if (
        starter.id !== registration.starterMessageId
        || starter.channelId !== registration.parentChannelId
        || starter.guildId !== registration.guildId
        || starter.author.id !== registration.authorizedUserId
      ) throw new Error("The claimed Discord starter message no longer matches its durable scope");
      thread = await this.startOrRecoverThread(starter);
    }
    await this.options.threadStore.activate({
      ...registration,
      status: "active",
      activatedAt: new Date().toISOString(),
    });
  }

  private isRecoverableThread(
    thread: AnyThreadChannel,
    registration: DiscordThreadRegistration,
  ): boolean {
    return thread.id === registration.threadId
      && thread.guildId === registration.guildId
      && thread.parentId === registration.parentChannelId
      && thread.ownerId === this.client.user?.id;
  }

  private async enqueueConversation(
    thread: AnyThreadChannel,
    message: Message,
  ): Promise<void> {
    await this.queues.enqueue(thread.id, async () => {
      if (this.state !== "running") {
        return;
      }

      const controller = new AbortController();
      this.activeRuns.set(thread.id, controller);
      try {
        if (message.guildId === null || thread.parentId === null) {
          throw new Error("The Discord thread has no guild or parent channel");
        }
        await thread.sendTyping().catch(() => undefined);
        const result = await this.options.runConversation({
          threadId: thread.id,
          guildId: message.guildId,
          parentChannelId: thread.parentId,
          messageId: message.id,
          userId: message.author.id,
          content: this.removeBotMention(message.content),
          attachments: projectAttachments(message),
          createdAt: message.createdAt,
          signal: controller.signal,
        });

        const response = typeof result === "string" ? { content: result } : result;
        if (!controller.signal.aborted && response !== undefined && response.content.trim() !== "") {
          try {
            await this.sendThreadText(thread, response.content, response.onChunkDelivered);
            await response.onDelivered?.();
          } catch (error) {
            await response.onDeliveryFailed?.();
            throw error;
          }
        } else {
          await response?.onDeliveryFailed?.();
        }
      } catch (error: unknown) {
        if (!controller.signal.aborted && !isAbortError(error)) {
          this.logger.error("Discord conversation failed", errorLogContext(error));
          await this.sendThreadText(thread, this.toPublicErrorMessage(error)).catch(
            () => undefined,
          );
        }
      } finally {
        if (this.activeRuns.get(thread.id) === controller) {
          this.activeRuns.delete(thread.id);
        }
      }
    });
  }

  private async sendThreadText(
    thread: AnyThreadChannel,
    content: string,
    onChunkDelivered?: (deliveredContent: string, chunkIndex: number) => Promise<void> | void,
  ): Promise<void> {
    let deliveredContent = "";
    let chunkIndex = 0;
    for (const chunk of chunkDiscordMessage(content)) {
      await thread.send({
        content: chunk,
        allowedMentions: { parse: [] },
      });
      deliveredContent += chunk;
      await onChunkDelivered?.(deliveredContent, chunkIndex);
      chunkIndex += 1;
    }
  }

  private removeBotMention(content: string): string {
    const botId = this.client.user?.id;
    if (botId === undefined) {
      return content.trim();
    }
    return content.replace(new RegExp(`<@!?${botId}>`, "gu"), "").trim();
  }

  private async handleInteraction(interaction: Interaction): Promise<void> {
    if (this.state !== "running") {
      return;
    }

    if (interaction.isAutocomplete()) {
      await this.handleAutocomplete(interaction);
      return;
    }
    if (!interaction.isChatInputCommand()) {
      return;
    }

    const scope = await this.authorizeInteraction(interaction);
    if (!scope.allowed) {
      await interaction.reply({
        content: "This Exy instance is restricted to its configured user and registered threads.",
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      });
      return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      switch (interaction.commandName) {
        case "model":
          await this.handleModelCommand(interaction);
          break;
        case "reasoning":
          await this.handleReasoningCommand(interaction);
          break;
        case "interrupt":
          await this.handleInterruptCommand(interaction, scope.threadId);
          break;
        case "restart":
          await this.respondToInteraction(interaction, "Restarting the Exy gateway…");
          setTimeout(() => {
            void Promise.resolve().then(() => this.options.onRestart()).catch((error: unknown) => {
              this.logger.error("Requested gateway restart failed", errorLogContext(error));
            });
          }, 250);
          break;
        default:
          await this.respondToInteraction(interaction, "Unknown Exy command.");
      }
    } catch (error: unknown) {
      this.logger.error("Discord command failed", errorLogContext(error));
      await this.respondToInteraction(interaction, this.toPublicErrorMessage(error));
    }
  }

  private async authorizeInteraction(
    interaction: ChatInputCommandInteraction | AutocompleteInteraction,
  ): Promise<AuthorizedInteractionScope> {
    if (
      interaction.guildId === null ||
      interaction.user.id !== this.options.config.authorizedUserId
    ) {
      return { allowed: false };
    }

    const channel = interaction.channel;
    if (
      channel?.type === ChannelType.GuildText
      || channel?.type === ChannelType.GuildAnnouncement
    ) {
      return { allowed: true };
    }

    if (
      channel?.isThread() !== true
    ) {
      return { allowed: false };
    }

    const registration = await this.options.threadStore.get(channel.id);
    if (
      registration?.status !== "active" ||
      !this.registrationMatchesThread(registration, channel)
    ) {
      return { allowed: false };
    }
    return { allowed: true, threadId: channel.id };
  }

  private async handleAutocomplete(
    interaction: AutocompleteInteraction,
  ): Promise<void> {
    const scope = await this.authorizeInteraction(interaction).catch(() => ({
      allowed: false,
    }));
    if (!scope.allowed) {
      await interaction.respond([]).catch(() => undefined);
      return;
    }

    try {
      const focused = interaction.options.getFocused(true);
      const query = String(focused.value).toLocaleLowerCase();
      if (interaction.commandName === "model" && focused.name === "model") {
        const models = await this.getModels();
        await interaction.respond(
          models
            .filter((model) =>
              `${model.name ?? ""} ${model.id}`.toLocaleLowerCase().includes(query),
            )
            .filter((model) => model.id.length <= 100)
            .slice(0, 25)
            .map((model) => ({
              name: truncateDiscordString(model.name ?? model.id, 100),
              value: model.id,
            })),
        );
        return;
      }

      if (
        interaction.commandName === "reasoning" &&
        focused.name === "level"
      ) {
        const selection = await this.options.modelController.getSelection();
        const model = (await this.getModels()).find(
          (candidate) => candidate.id === selection.modelId,
        );
        const levels = model?.reasoningLevels ?? [];
        await interaction.respond(
          levels
            .filter((level) => level.toLocaleLowerCase().includes(query))
            .filter((level) => level.length <= 100)
            .slice(0, 25)
            .map((level) => ({
              name: truncateDiscordString(level, 100),
              value: level,
            })),
        );
        return;
      }

      await interaction.respond([]);
    } catch (error: unknown) {
      this.logger.warn("Discord autocomplete failed", errorLogContext(error));
      await interaction.respond([]).catch(() => undefined);
    }
  }

  private async handleModelCommand(
    interaction: ChatInputCommandInteraction,
  ): Promise<void> {
    const requested = interaction.options.getString("model", false);
    const models = await this.getModels(requested !== null);

    if (requested !== null) {
      const selected = models.find((model) => model.id === requested);
      if (selected === undefined) {
        await this.respondToInteraction(
          interaction,
          "That model is not currently exposed by Pi. Use autocomplete or `/model` to refresh the list.",
        );
        return;
      }
      await this.options.modelController.selectModel(selected.id);
    }

    const selection = await this.options.modelController.getSelection();
    const lines = [
      `Active model: \`${escapeInlineCode(selection.modelId)}\``,
      `Reasoning: \`${escapeInlineCode(selection.reasoning)}\``,
      "",
      "Available models:",
      ...models.map((model) =>
        model.name === undefined || model.name === model.id
          ? `- \`${escapeInlineCode(model.id)}\``
          : `- ${model.name} (\`${escapeInlineCode(model.id)}\`)`,
      ),
    ];
    await this.respondToInteraction(interaction, lines.join("\n"));
  }

  private async handleReasoningCommand(
    interaction: ChatInputCommandInteraction,
  ): Promise<void> {
    const requested = interaction.options.getString("level", false);
    const selectionBefore = await this.options.modelController.getSelection();
    const model = (await this.getModels(requested !== null)).find(
      (candidate) => candidate.id === selectionBefore.modelId,
    );
    const levels = model?.reasoningLevels ?? [];

    if (requested !== null) {
      if (!levels.includes(requested)) {
        await this.respondToInteraction(
          interaction,
          "That reasoning level is not supported by the selected model. Use autocomplete or `/reasoning` to refresh the list.",
        );
        return;
      }
      await this.options.modelController.selectReasoning(requested);
    }

    const selection = await this.options.modelController.getSelection();
    await this.respondToInteraction(
      interaction,
      [
        `Active model: \`${escapeInlineCode(selection.modelId)}\``,
        `Reasoning: \`${escapeInlineCode(selection.reasoning)}\``,
        "",
        `Supported levels: ${
          levels.length === 0
            ? "none reported by Pi"
            : levels.map((level) => `\`${escapeInlineCode(level)}\``).join(", ")
        }`,
      ].join("\n"),
    );
  }

  private async handleInterruptCommand(
    interaction: ChatInputCommandInteraction,
    threadId: string | undefined,
  ): Promise<void> {
    if (threadId === undefined) {
      await this.respondToInteraction(
        interaction,
        "Run `/interrupt` inside the Exy thread whose agent turn you want to stop.",
      );
      return;
    }

    let interrupted = this.interrupt(threadId);
    if (!interrupted) interrupted = await this.options.interruptConversation?.(threadId) ?? false;
    await this.respondToInteraction(
      interaction,
      interrupted
        ? "Interrupt requested for this thread."
        : "There is no active agent run in this thread.",
    );
  }

  private async respondToInteraction(
    interaction: ChatInputCommandInteraction,
    content: string,
  ): Promise<void> {
    const chunks = chunkDiscordMessage(content);
    const first = chunks.shift() ?? "No content.";
    await interaction.editReply({
      content: first,
      allowedMentions: { parse: [] },
    });
    for (const chunk of chunks) {
      await interaction.followUp({
        content: chunk,
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      });
    }
  }

  private async getModels(force = false): Promise<readonly DiscordModelDescriptor[]> {
    const now = Date.now();
    if (!force && this.modelCache !== undefined && this.modelCache.expiresAt > now) {
      return this.modelCache.models;
    }

    const models = (await this.options.modelController.listModels()).filter(
      (model) => model.id.trim() !== "",
    );
    this.modelCache = {
      expiresAt: now + (this.options.modelCacheMilliseconds ?? 30_000),
      models,
    };
    return models;
  }

  private toPublicErrorMessage(error: unknown): string {
    if (this.options.publicErrorMessage === undefined) {
      return SAFE_RUNTIME_ERROR;
    }
    try {
      const message = this.options.publicErrorMessage(error).trim();
      return message === "" ? SAFE_RUNTIME_ERROR : message;
    } catch {
      return SAFE_RUNTIME_ERROR;
    }
  }

  private registrationMatchesConfig(
    registration: DiscordThreadRegistration,
  ): boolean {
    return (
      registration.threadId === registration.starterMessageId &&
      registration.authorizedUserId === this.options.config.authorizedUserId
    );
  }

  private registrationMatchesThread(
    registration: DiscordThreadRegistration,
    thread: AnyThreadChannel,
  ): boolean {
    return this.registrationMatchesConfig(registration)
      && registration.threadId === thread.id
      && registration.guildId === thread.guildId
      && registration.parentChannelId === thread.parentId;
  }
}

function projectAttachments(message: Message): DiscordAttachment[] {
  return message.attachments.map((attachment) => ({
    id: attachment.id,
    name: attachment.name,
    url: attachment.url,
    size: attachment.size,
    ...(attachment.contentType === null
      ? {}
      : { contentType: attachment.contentType }),
  }));
}

function makeThreadName(content: string): string {
  const normalized = content.replace(/\s+/gu, " ").trim();
  const suffix = normalized === "" ? "conversation" : normalized;
  return truncateDiscordString(`Exy · ${suffix}`, 100);
}

function truncateDiscordString(value: string, maximumCodeUnits: number): string {
  if (value.length <= maximumCodeUnits) {
    return value;
  }
  let boundary = maximumCodeUnits;
  const previousCodeUnit = value.charCodeAt(boundary - 1);
  if (previousCodeUnit >= 0xd800 && previousCodeUnit <= 0xdbff) {
    boundary -= 1;
  }
  return value.slice(0, boundary);
}

function escapeInlineCode(value: string): string {
  return value.replace(/`/gu, "'");
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function errorLogContext(error: unknown): Readonly<Record<string, unknown>> {
  if (!(error instanceof Error)) {
    return { errorType: typeof error };
  }
  const candidate = error as Error & { code?: unknown; status?: unknown };
  return {
    errorName: error.name,
    errorMessage: error.message,
    ...(typeof candidate.code === "string" || typeof candidate.code === "number"
      ? { errorCode: candidate.code }
      : {}),
    ...(typeof candidate.status === "number"
      ? { httpStatus: candidate.status }
      : {}),
  };
}

async function withTimeout(promise: Promise<void>, milliseconds: number): Promise<void> {
  let timeout: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<void>((resolve) => {
    timeout = setTimeout(resolve, milliseconds);
  });
  await Promise.race([promise, timeoutPromise]);
  if (timeout !== undefined) {
    clearTimeout(timeout);
  }
}
