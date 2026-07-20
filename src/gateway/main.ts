import { REST, Routes } from "discord.js";
import type { ExyPaths } from "../config/paths.js";
import { ConfigStore } from "../config/store.js";
import { ExyAgentRuntime, type AgentRuntimeLogger } from "../agent/runtime.js";
import { PiModelService } from "../agent/model-service.js";
import { safeErrorMessage, ProviderError } from "../core/errors.js";
import {
  CandidateMappingRepository,
  DiscordThreadRepository,
  ExyDatabase,
  ModelPreferenceRepository,
  PublicationDraftRepository,
  SqliteDiscordThreadStore,
} from "../db/index.js";
import { DraftError } from "../db/drafts.js";
import { chunkDiscordMessage, DiscordGateway } from "../discord/index.js";
import { ExaClient, SupermemoryClient, XquikClient, ZernioClient } from "../providers/index.js";
import { readHeartbeatDocument, ScheduledJobStore, SchedulerEngine } from "../scheduler/index.js";
import { SkillRegistry } from "../skills/index.js";
import { ReplyOpportunityVerifier } from "../verifier/index.js";
import { ensureLayout } from "../setup/layout.js";
import { RESTART_EXIT_CODE } from "../setup/systemd.js";
import type { JsonValue } from "../db/json.js";

interface ScheduledAgentPayload {
  prompt: string;
  threadId: string;
  discordUserId: string;
  xAccountId: string;
}

const logger: AgentRuntimeLogger & {
  debug(message: string, context?: Readonly<Record<string, unknown>>): void;
} = {
  debug: (message, context) => log("debug", message, context),
  info: (message, context) => log("info", message, context),
  warn: (message, context) => log("warn", message, context),
  error: (message, context) => log("error", message, context),
};

function log(level: string, message: string, context?: Readonly<Record<string, unknown>>): void {
  const record = { timestamp: new Date().toISOString(), level, message, ...(context ? { context } : {}) };
  const line = JSON.stringify(record);
  if (level === "error") console.error(line);
  else console.log(line);
}

function scheduledPayload(value: JsonValue): ScheduledAgentPayload {
  if (!value || Array.isArray(value) || typeof value !== "object") throw new Error("Scheduled job payload is invalid");
  const payload = value as Record<string, JsonValue>;
  if (
    typeof payload.prompt !== "string" ||
    typeof payload.threadId !== "string" ||
    typeof payload.discordUserId !== "string" ||
    typeof payload.xAccountId !== "string"
  ) throw new Error("Scheduled job payload is invalid");
  return payload as unknown as ScheduledAgentPayload;
}

function heartbeatHasWork(content: string): boolean {
  const withoutComments = content.replace(/<!--([\s\S]*?)-->/gu, "");
  return withoutComments
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .some((line) => line !== "" && !/^#{1,6}(?:\s|$)/u.test(line));
}

async function sendToDiscordThread(
  rest: REST,
  threadId: string,
  content: string,
  onChunkDelivered?: (deliveredContent: string, chunkIndex: number) => Promise<void> | void,
): Promise<void> {
  let deliveredContent = "";
  let chunkIndex = 0;
  for (const chunk of chunkDiscordMessage(content)) {
    await rest.post(Routes.channelMessages(threadId), {
      body: { content: chunk, allowed_mentions: { parse: [] } },
    });
    deliveredContent += chunk;
    await onChunkDelivered?.(deliveredContent, chunkIndex);
    chunkIndex += 1;
  }
}

function publicError(error: unknown): string {
  if (error instanceof ProviderError || error instanceof DraftError) return safeErrorMessage(error);
  return "Exy could not complete that operation. Check `exy logs` for the sanitized diagnostic.";
}

export async function runGateway(paths: ExyPaths): Promise<number> {
  await ensureLayout(paths);
  const configStore = new ConfigStore(paths);
  const config = await configStore.readConfig();
  const secrets = await configStore.readSecrets();
  if (!config.model) throw new Error("No default Pi model is configured; run exy login");
  const xAccountId = config.providers.zernioAccountId;
  if (!xAccountId) throw new Error("No connected Zernio X account is configured; rerun exy setup");

  const modelService = new PiModelService(paths.piAuthFile);
  if (!(await modelService.validateAuthentication(config.model.provider))) {
    throw new Error(`Pi authentication for ${config.model.provider} is unavailable; run exy login`);
  }
  await modelService.resolvePreference(config.model);
  if (config.writingModel) {
    if (!(await modelService.validateAuthentication("opencode-go"))) {
      throw new Error("OpenCode Go authentication for the writing subagent is unavailable; run exy login");
    }
    await modelService.resolveWritingPreference(config.writingModel);
  }

  const database = new ExyDatabase(paths.databaseFile);
  const threads = new DiscordThreadRepository(database);
  const threadStore = new SqliteDiscordThreadStore(database, xAccountId);
  const modelPreferences = new ModelPreferenceRepository(database);
  const candidates = new CandidateMappingRepository(database);
  const verifier = new ReplyOpportunityVerifier(database);
  const drafts = new PublicationDraftRepository(database);
  const jobs = new ScheduledJobStore(database);
  const skills = new SkillRegistry(paths.skillsDir);
  const xquik = new XquikClient(secrets.xquikApiKey);
  const zernio = new ZernioClient(secrets.zernioApiKey);
  const exa = new ExaClient(secrets.exaApiKey);
  const supermemory = new SupermemoryClient(secrets.supermemoryApiKey);
  const rest = new REST({ version: "10" }).setToken(secrets.discordBotToken);
  const scheduler = new SchedulerEngine(jobs, {
    onError: (error) => logger.error("Scheduler tick failed", { error: safeErrorMessage(error) }),
  });

  let runtime!: ExyAgentRuntime;
  const syncHeartbeat = async (): Promise<void> => {
    const current = await configStore.readConfig();
    const existing = jobs.list(true).find((job) => job.task === "heartbeat" && job.name === "system:heartbeat");
    const schedule = { kind: "interval" as const, everyMs: current.heartbeat.intervalMinutes * 60_000 };
    const payload = {
      deliveryThreadId: current.heartbeat.deliveryThreadId ?? "",
      discordUserId: current.discord.authorizedUserId,
      xAccountId,
    };
    if (existing) {
      jobs.update(existing.id, { schedule, enabled: current.heartbeat.enabled, payload });
    } else {
      jobs.create({
        name: "system:heartbeat",
        task: "heartbeat",
        schedule,
        enabled: current.heartbeat.enabled,
        payload,
      });
    }
  };

  runtime = new ExyAgentRuntime({
    paths,
    configStore,
    modelService,
    threads,
    modelPreferences,
    candidates,
    verifier,
    drafts,
    jobs,
    skills,
    xquik,
    zernio,
    exa,
    supermemory,
    logger,
    dryRunPublishing: process.env.EXY_DRY_RUN === "1",
    onHeartbeatChanged: syncHeartbeat,
  });

  scheduler.register("agent_prompt", async ({ jobId, payload, signal, runId }) => {
    const job = scheduledPayload(payload);
    const current = await configStore.readConfig();
    const registration = await threadStore.get(job.threadId);
    if (
      job.discordUserId !== current.discord.authorizedUserId
      || job.xAccountId !== xAccountId
      || registration?.status !== "active"
    ) {
      jobs.update(jobId, { enabled: false });
      return { skipped: "scope_changed", disabled: true };
    }
    const delivery = await runtime.runTurn({
      threadId: job.threadId,
      content: job.prompt,
      messageId: `scheduled-${runId}`,
      signal,
      automated: true,
    });
    try {
      await sendToDiscordThread(rest, job.threadId, delivery.content, delivery.onChunkDelivered);
      await delivery.onDelivered();
    } catch (error) {
      await delivery.onDeliveryFailed();
      throw error;
    }
    return { delivered: true, output: delivery.content.slice(0, 4_000) };
  });

  scheduler.register("heartbeat", async ({ signal, runId }) => {
    const current = await configStore.readConfig();
    const document = await readHeartbeatDocument(paths.heartbeatFile, current.heartbeat.enabled);
    if (!document.enabled) return { skipped: "disabled" };
    if (!heartbeatHasWork(document.content)) return { skipped: "empty" };
    const threadId = current.heartbeat.deliveryThreadId;
    if (!threadId) return { skipped: "no_delivery_thread" };
    const registration = await threadStore.get(threadId);
    if (registration?.status !== "active") return { skipped: "delivery_thread_unavailable" };
    const prompt = `This is a dedicated heartbeat execution, not an ordinary chat turn. Activate the exy-automation skill and follow its heartbeat procedure. Read the checklist below, perform only safe in-scope work, and return exactly HEARTBEAT_OK if there is nothing the user needs to see.\n\n<heartbeat_checklist>\n${document.content}\n</heartbeat_checklist>`;
    const delivery = await runtime.runTurn({
      threadId,
      content: prompt,
      messageId: `heartbeat-${runId}`,
      signal,
      automated: true,
    });
    try {
      if (delivery.content.trim() !== "HEARTBEAT_OK") {
        await sendToDiscordThread(rest, threadId, delivery.content, delivery.onChunkDelivered);
      }
      await delivery.onDelivered();
    } catch (error) {
      await delivery.onDeliveryFailed();
      throw error;
    }
    return { acknowledged: delivery.content.trim() === "HEARTBEAT_OK", output: delivery.content.slice(0, 4_000) };
  });

  await syncHeartbeat();

  let finish!: (code: number) => void;
  const finished = new Promise<number>((resolve) => (finish = resolve));
  let shuttingDown = false;
  const requestShutdown = (code: number) => {
    if (shuttingDown) return;
    shuttingDown = true;
    finish(code);
  };

  const discord = new DiscordGateway({
    config: config.discord,
    botToken: secrets.discordBotToken,
    threadStore,
    runConversation: async (turn) =>
      runtime.runTurn({
        threadId: turn.threadId,
        content: turn.content,
        messageId: turn.messageId,
        attachmentUrls: turn.attachments.map((attachment) => attachment.url),
        signal: turn.signal,
        onProgress: turn.onProgress,
      }),
    interruptConversation: (threadId) => runtime.interrupt(threadId),
    modelController: runtime,
    onRestart: () => requestShutdown(RESTART_EXIT_CODE),
    logger,
    publicErrorMessage: publicError,
  });

  const stop = () => requestShutdown(0);
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  scheduler.start();
  try {
    await discord.start();
    logger.info("Exy gateway is ready", {
      dryRunPublishing: process.env.EXY_DRY_RUN === "1",
    });
    return await finished;
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    scheduler.stop({ abortRunning: true });
    await discord.stop();
    const schedulerIdle = await scheduler.waitForIdle(20_000);
    if (!schedulerIdle) logger.warn("Scheduler shutdown timed out; active leases will be recovered on restart");
    await runtime.dispose();
    if (schedulerIdle) database.close();
    else logger.warn("SQLite was intentionally left open until the in-flight scheduler handler exits");
    logger.info("Exy gateway stopped");
  }
}
