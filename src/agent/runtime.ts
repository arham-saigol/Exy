import { randomUUID } from "node:crypto";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import type { ConfigStore } from "../config/store.js";
import type { ExyPaths } from "../config/paths.js";
import type { ModelPreference, Scope } from "../core/types.js";
import type { AgentProgressEvent, AgentProgressSink } from "../core/progress.js";
import type { CandidateMappingRepository } from "../db/candidates.js";
import type { PublicationDraftRepository } from "../db/drafts.js";
import type { JsonValue } from "../db/json.js";
import type { DiscordThreadRepository, DiscordThreadRecord } from "../db/threads.js";
import type { ModelPreferenceRepository } from "../db/state.js";
import type { ExaClient } from "../providers/exa.js";
import type { SupermemoryClient } from "../providers/supermemory.js";
import type { XquikClient } from "../providers/xquik.js";
import type { ZernioClient } from "../providers/zernio.js";
import type { ScheduledJobStore } from "../scheduler/index.js";
import type { SkillRegistry } from "../skills/index.js";
import type { ReplyOpportunityVerifier } from "../verifier/reply-verifier.js";
import type { PresentReplyOpportunityInput } from "../verifier/reply-verifier.js";
import { createAutomationTools } from "./automation-tools.js";
import type { PiModelService, SelectableModel } from "./model-service.js";
import { memoryContainerTag } from "./scope.js";
import { EXY_SYSTEM_PROMPT } from "./system-prompt.js";
import { createExyTools, type StageReplyOpportunityResult } from "./tools.js";
import { createSubagentTools } from "./subagents.js";
import { formatActivatedSkillStatus, formatToolStatus } from "./tool-status.js";
import {
  extractXPostIds,
  guardRawXSearchNarrative,
  guardUnconfirmedPublicationClaims,
  guardUnverifiedXPostUrls,
} from "./output-guard.js";

export interface AgentRuntimeLogger {
  info(message: string, context?: Readonly<Record<string, unknown>>): void;
  warn(message: string, context?: Readonly<Record<string, unknown>>): void;
  error(message: string, context?: Readonly<Record<string, unknown>>): void;
}

export interface ExyAgentRuntimeOptions {
  paths: ExyPaths;
  configStore: ConfigStore;
  modelService: PiModelService;
  threads: DiscordThreadRepository;
  modelPreferences: ModelPreferenceRepository;
  candidates: CandidateMappingRepository;
  verifier: ReplyOpportunityVerifier;
  drafts: PublicationDraftRepository;
  jobs: ScheduledJobStore;
  skills: SkillRegistry;
  xquik: XquikClient;
  zernio: ZernioClient;
  exa: ExaClient;
  supermemory: SupermemoryClient;
  logger: AgentRuntimeLogger;
  dryRunPublishing?: boolean;
  onHeartbeatChanged?: () => Promise<void> | void;
}

export interface RunAgentTurnInput {
  threadId: string;
  content: string;
  messageId?: string;
  attachmentUrls?: readonly string[];
  signal?: AbortSignal;
  automated?: boolean;
  onProgress?: AgentProgressSink;
}

export interface AgentTurnDelivery {
  content: string;
  onChunkDelivered(deliveredContent: string, chunkIndex: number): Promise<void>;
  onDelivered(): Promise<void>;
  onDeliveryFailed(): Promise<void>;
}

interface LiveSession {
  session: AgentSession;
  record: DiscordThreadRecord;
  preference: ModelPreference;
}

interface StagedRecommendation {
  key: string;
  postId: string;
  canonicalUrl: string;
  rationale: string;
  suggestedReply?: string;
  candidate?: JsonValue;
  input: PresentReplyOpportunityInput;
}

interface RecommendationTurn {
  staged: Map<string, StagedRecommendation>;
}

const NOOP_SIGNAL = new AbortController().signal;

export class ExyAgentRuntime {
  private readonly live = new Map<string, LiveSession>();
  private readonly queues = new Map<string, Promise<void>>();
  private readonly activeTurns = new Map<string, AbortController>();
  private readonly recommendationTurns = new Map<string, RecommendationTurn>();
  private readonly recommendationReservations = new Set<string>();
  private modelMutation: Promise<void> = Promise.resolve();

  constructor(private readonly options: ExyAgentRuntimeOptions) {}

  async runTurn(input: RunAgentTurnInput): Promise<AgentTurnDelivery> {
    return this.enqueue(input.threadId, async () => {
      const controller = new AbortController();
      this.activeTurns.set(input.threadId, controller);
      const signal = input.signal === undefined
        ? controller.signal
        : AbortSignal.any([input.signal, controller.signal]);
      try {
        return await this.runTurnExclusive({ ...input, signal });
      } finally {
        if (this.activeTurns.get(input.threadId) === controller) this.activeTurns.delete(input.threadId);
      }
    });
  }

  async listModels(): Promise<readonly { id: string; name?: string; reasoningLevels: readonly string[] }[]> {
    const config = await this.options.configStore.readConfig();
    if (!config.model) return [];
    return (await this.options.modelService.listProviderModels(config.model.provider)).map((model) => ({
      id: model.id,
      name: model.name,
      reasoningLevels: model.reasoningLevels,
    }));
  }

  async getSelection(): Promise<{ modelId: string; reasoning: string }> {
    const config = await this.options.configStore.readConfig();
    if (!config.model) throw new Error("No default model is configured; run exy login");
    return { modelId: config.model.modelId, reasoning: config.model.reasoning };
  }

  async selectModel(modelId: string): Promise<void> {
    await this.mutateModel(async () => {
      const config = await this.options.configStore.readConfig();
      if (!config.model) throw new Error("No default model is configured; run exy login");
      const selected = (await this.options.modelService.listProviderModels(config.model.provider)).find((model) => model.id === modelId);
      if (!selected) throw new Error("That model was not returned by Pi");
      const reasoning = selected.reasoningLevels.includes(config.model.reasoning)
        ? config.model.reasoning
        : (selected.reasoningLevels.includes("medium") ? "medium" : selected.reasoningLevels[0]);
      if (!reasoning) throw new Error("Pi returned no valid reasoning level for that model");
      const preference: ModelPreference = { provider: selected.provider, modelId: selected.id, reasoning };
      await this.options.configStore.updateModel(preference);
      await this.applyPreferenceToIdleSessions(preference, selected);
    });
  }

  async selectReasoning(reasoning: string): Promise<void> {
    await this.mutateModel(async () => {
      const config = await this.options.configStore.readConfig();
      if (!config.model) throw new Error("No default model is configured; run exy login");
      const selected = await this.options.modelService.resolvePreference({
        ...config.model,
        reasoning: reasoning as ModelPreference["reasoning"],
      });
      const preference: ModelPreference = { ...config.model, reasoning: reasoning as ModelPreference["reasoning"] };
      await this.options.configStore.updateModel(preference);
      await this.applyPreferenceToIdleSessions(preference, selected);
    });
  }

  async interrupt(threadId: string): Promise<boolean> {
    const controller = this.activeTurns.get(threadId);
    const current = this.live.get(threadId);
    const streaming = current?.session.isStreaming === true;
    if (controller) controller.abort("Agent turn interrupted");
    if (streaming) await current.session.abort();
    return controller !== undefined || streaming;
  }

  async dispose(): Promise<void> {
    for (const controller of this.activeTurns.values()) controller.abort("Runtime disposed");
    await Promise.allSettled(
      [...this.live.values()].map(async ({ session }) => {
        if (session.isStreaming) await session.abort();
        session.dispose();
      }),
    );
    this.live.clear();
  }

  private async runTurnExclusive(input: RunAgentTurnInput): Promise<AgentTurnDelivery> {
    const signal = input.signal ?? NOOP_SIGNAL;
    if (signal.aborted) throw abortError();
    const live = await this.getOrCreateSession(input.threadId);
    if (signal.aborted) throw abortError();
    await this.synchronizeSessionPreference(live);
    if (signal.aborted) throw abortError();
    await live.session.reload();

    const scope: Scope = { discordUserId: live.record.discordUserId, xAccountId: live.record.xAccountId };
    const content = input.content;
    const memory = await this.recallMemory(scope, content, signal);
    if (signal.aborted) throw abortError();
    const attachments = input.attachmentUrls?.length
      ? `\n<discord_attachments>${input.attachmentUrls.map((url) => `\n- ${url}`).join("")}</discord_attachments>`
      : "";
    const prompt = `${memory}${attachments}\n<user_message>${content}</user_message>`;

    const assistantMessages: string[] = [];
    let activeAssistantMessage = -1;
    const streamedAssistantMessages = new Set<number>();
    const recommendationTurn = this.beginRecommendationTurn(input.threadId);
    const allowedPostIds = new Set<string>();
    const exactDraftContents: string[] = [];
    let rawXCandidatesExposed = false;
    let alreadyRecommendedCount = 0;
    let publishSummary: string | undefined;
    let publicationConfirmed = false;
    let progressQueue = Promise.resolve();
    const emitProgress = (event: AgentProgressEvent): void => {
      if (input.onProgress === undefined) return;
      progressQueue = progressQueue
        .then(() => input.onProgress?.(event))
        .then(() => undefined)
        .catch((error: unknown) => {
          this.options.logger.warn("Agent progress delivery failed", safeContext(error));
        });
    };
    const unsubscribe = live.session.subscribe((event) => {
      if (event.type === "message_start" && event.message.role === "assistant") {
        activeAssistantMessage = assistantMessages.push("") - 1;
      }
      if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
        const delta = event.assistantMessageEvent.delta;
        if (activeAssistantMessage < 0) activeAssistantMessage = assistantMessages.push("") - 1;
        assistantMessages[activeAssistantMessage] += delta;
      }
      if (
        event.type === "message_end"
        && event.message.role === "assistant"
        && event.message.content.some((item) => item.type === "toolCall")
        && activeAssistantMessage >= 0
      ) {
        const invokesWriter = event.message.content.some((item) =>
          item.type === "toolCall" && item.name === "spawn_writing_subagent",
        );
        const intermediate = invokesWriter ? "" : (assistantMessages[activeAssistantMessage]?.trim() ?? "");
        if (intermediate !== "") {
          const searchGuarded = guardRawXSearchNarrative(
            intermediate,
            rawXCandidatesExposed,
            alreadyRecommendedCount,
          );
          const preserveExactFencedContent = exactDraftContents.length > 0;
          const preserveGatewayFencedContent = preserveExactFencedContent || recommendationTurn.staged.size > 0;
          const claimGuarded = guardUnconfirmedPublicationClaims(
            searchGuarded,
            publicationConfirmed,
            { preserveFencedContent: preserveGatewayFencedContent, preserveExactContent: exactDraftContents },
          );
          const safeIntermediate = guardUnverifiedXPostUrls(
            claimGuarded,
            scope,
            this.options.verifier,
            allowedPostIds,
            { preserveFencedContent: preserveExactFencedContent, preserveExactContent: exactDraftContents },
          ).trim();
          if (safeIntermediate !== "" && input.onProgress !== undefined) {
            emitProgress({ type: "assistant_text", message: safeIntermediate });
            streamedAssistantMessages.add(activeAssistantMessage);
          }
        }
      }
      if (event.type === "tool_execution_start" && event.toolName !== "activate_agent_skill") {
        emitProgress({
          type: "tool_status",
          message: formatToolStatus(event.toolName, event.args),
        });
      }
      if (event.type === "tool_execution_end") {
        const data = toolResultJson(event.result);
        if (event.toolName === "activate_agent_skill" && !event.isError) {
          const status = formatActivatedSkillStatus(data?.name);
          if (status !== undefined) emitProgress({ type: "tool_status", message: status });
        }
        // Direct search results expose raw candidates to the coordinator. A research
        // subagent's result is a synthesized brief, even when that child searched X.
        if (event.toolName === "search_x" && !event.isError) rawXCandidatesExposed = true;
        if (
          event.toolName === "recommend_reply_opportunity"
          && !event.isError
          && data?.presented === false
          && data.alreadyRecommended === true
        ) alreadyRecommendedCount += 1;
        if (event.toolName === "publish_current_x_draft" || event.toolName === "inspect_x_publication_status") {
          publishSummary = event.isError
            ? `Publication was not confirmed.\n${safeOutcomeField(toolResultText(event.result), "The provider operation failed; review `exy logs`.")}`
            : formatPublicationOutcome(data);
          publicationConfirmed = !event.isError && data?.confirmed === true;
          if (!event.isError && data?.confirmed === true) {
            for (const postId of extractXPostIds(JSON.stringify(data))) allowedPostIds.add(postId);
          }
        }
        if (
          (event.toolName === "save_x_draft" || event.toolName === "spawn_writing_subagent")
          && !event.isError
          && data?.stored === true
        ) {
          for (const postId of extractXPostIds(JSON.stringify(event.result))) allowedPostIds.add(postId);
          if (typeof data?.exactContent === "string") exactDraftContents.push(data.exactContent);
        }
      }
    });
    const abort = () => void live.session.abort().catch(() => undefined);
    signal.addEventListener("abort", abort, { once: true });
    let promptSucceeded = false;
    try {
      await live.session.prompt(prompt);
      await progressQueue;
      if (signal.aborted) throw abortError();
      promptSucceeded = true;
    } finally {
      await progressQueue;
      signal.removeEventListener("abort", abort);
      unsubscribe();
      this.options.threads.touch(input.threadId);
      this.recommendationTurns.delete(input.threadId);
      if (!promptSucceeded) {
        this.releaseRecommendationTurn(recommendationTurn);
      }
    }

    const recommendationSummaries = [...recommendationTurn.staged.values()].map(formatReplyRecommendation);
    const output = assistantMessages
      .filter((_message, index) => !streamedAssistantMessages.has(index))
      .map((message) => message.trim())
      .filter((message) => message !== "")
      .join("\n\n");
    const guardedModelOutput = guardRawXSearchNarrative(
      output,
      rawXCandidatesExposed && recommendationSummaries.length === 0 && exactDraftContents.length === 0,
      alreadyRecommendedCount,
    );
    const visibleOutput = guardedModelOutput
      || publishSummary
      || recommendationSummaries.join("\n\n")
      || exactDraftContents.at(-1)
      || "I completed the turn but Pi returned no user-visible text.";
    const latestExactDraft = exactDraftContents.at(-1);
    const recommendationIncludesLatestDraft = latestExactDraft !== undefined
      && [...recommendationTurn.staged.values()].some((staged) => staged.suggestedReply === latestExactDraft);
    // Render delegated drafts deterministically. The coordinator can neither
    // substitute different copy nor place an alternative beside the writer's
    // exact saved bytes.
    const draftEnsuredOutput = latestExactDraft
      ? formatDelegatedDraft(
          input.content,
          latestExactDraft,
          recommendationSummaries,
          recommendationIncludesLatestDraft,
        )
      : visibleOutput;
    const preserveExactFencedContent = exactDraftContents.length > 0;
    const preserveGatewayFencedContent = preserveExactFencedContent || recommendationSummaries.length > 0;
    const visiblePostIds = extractXPostIds(draftEnsuredOutput);
    const deliveredRecommendations: StagedRecommendation[] = [];
    for (const staged of recommendationTurn.staged.values()) {
      if (visiblePostIds.has(staged.postId)) {
        deliveredRecommendations.push(staged);
        allowedPostIds.add(staged.postId);
      } else {
        this.recommendationReservations.delete(staged.key);
      }
    }
    const claimGuardedOutput = guardUnconfirmedPublicationClaims(
      draftEnsuredOutput,
      publicationConfirmed,
      { preserveFencedContent: preserveGatewayFencedContent, preserveExactContent: exactDraftContents },
    );
    const finalOutput = guardUnverifiedXPostUrls(
      claimGuardedOutput,
      scope,
      this.options.verifier,
      allowedPostIds,
      { preserveFencedContent: preserveExactFencedContent, preserveExactContent: exactDraftContents },
    );
    return this.createDelivery(scope, input, content, finalOutput, deliveredRecommendations);
  }

  private beginRecommendationTurn(threadId: string): RecommendationTurn {
    const previous = this.recommendationTurns.get(threadId);
    if (previous) this.releaseRecommendationTurn(previous);
    const turn: RecommendationTurn = { staged: new Map() };
    this.recommendationTurns.set(threadId, turn);
    return turn;
  }

  private stageReplyOpportunity(
    threadId: string,
    scope: Scope,
    sessionId: string,
    input: { post: string; rationale: string; suggestedReply?: string; candidate?: JsonValue },
  ): StageReplyOpportunityResult {
    const turn = this.recommendationTurns.get(threadId);
    if (!turn) throw new Error("Reply recommendations can only be staged during an active agent turn");
    const inspection = this.options.verifier.inspect(scope, input.post);
    const key = `${scope.discordUserId}\0${scope.xAccountId}\0${inspection.postId}`;
    if (turn.staged.has(inspection.postId)) {
      return {
        status: "staged",
        presented: true,
        alreadyRecommended: false,
        pendingDelivery: false,
        canonicalUrl: inspection.canonicalUrl,
        instruction: "This reply opportunity is already reserved by the current response and may be presented once.",
      };
    }
    if (inspection.alreadyRecommended) {
      return {
        status: "already_recommended",
        presented: false,
        alreadyRecommended: true,
        pendingDelivery: false,
        canonicalUrl: inspection.canonicalUrl,
        instruction: "This X post was already recommended. Do not present it as a new reply opportunity.",
      };
    }
    if (this.recommendationReservations.has(key)) {
      return {
        status: "pending_delivery",
        presented: false,
        alreadyRecommended: false,
        pendingDelivery: true,
        canonicalUrl: inspection.canonicalUrl,
        instruction: "This X post is pending delivery in another Exy conversation. Do not present it yet; retry after that delivery settles.",
      };
    }

    const metadata = JSON.parse(JSON.stringify({
      rationale: input.rationale,
      suggestedReply: input.suggestedReply ?? null,
      candidate: input.candidate ?? null,
    })) as JsonValue;
    const staged: StagedRecommendation = {
      key,
      postId: inspection.postId,
      canonicalUrl: inspection.canonicalUrl,
      rationale: input.rationale,
      ...(input.suggestedReply === undefined ? {} : { suggestedReply: input.suggestedReply }),
      ...(input.candidate === undefined ? {} : { candidate: input.candidate }),
      input: {
        ...scope,
        post: input.post,
        threadId,
        sessionId,
        metadata,
      },
    };
    turn.staged.set(inspection.postId, staged);
    this.recommendationReservations.add(key);
    return {
      status: "staged",
      presented: true,
      alreadyRecommended: false,
      pendingDelivery: false,
      canonicalUrl: inspection.canonicalUrl,
      instruction: "This reply opportunity is reserved and may be presented once in the final response.",
    };
  }

  private releaseRecommendationTurn(turn: RecommendationTurn): void {
    for (const staged of turn.staged.values()) this.recommendationReservations.delete(staged.key);
  }

  private createDelivery(
    scope: Scope,
    input: RunAgentTurnInput,
    userContent: string,
    content: string,
    recommendations: readonly StagedRecommendation[],
  ): AgentTurnDelivery {
    let settled = false;
    const committed = new Set<string>();
    const observedDeliveredPostIds = new Set<string>();
    const release = () => {
      for (const staged of recommendations) this.recommendationReservations.delete(staged.key);
    };
    const commit = (staged: StagedRecommendation) => {
      if (committed.has(staged.key)) return;
      const result = this.options.verifier.present(staged.input);
      committed.add(staged.key);
      this.recommendationReservations.delete(staged.key);
      if (!result.presented) {
        this.options.logger.warn("A delivered reply recommendation lost its delivery reservation race", {
          postId: staged.postId,
          threadId: input.threadId,
        });
      }
    };
    const commitObserved = () => {
      for (const staged of recommendations) {
        if (observedDeliveredPostIds.has(staged.postId)) commit(staged);
      }
    };
    return {
      content,
      onChunkDelivered: async (deliveredContent) => {
        if (settled) return;
        for (const postId of extractXPostIds(deliveredContent)) {
          observedDeliveredPostIds.add(postId);
        }
        commitObserved();
      },
      onDelivered: async () => {
        if (settled) return;
        settled = true;
        try {
          for (const staged of recommendations) commit(staged);
        } finally {
          release();
        }
        await this.rememberConversation(scope, input, userContent, content, input.signal);
      },
      onDeliveryFailed: async () => {
        if (settled) return;
        settled = true;
        try {
          // A preceding Discord chunk may already have shown a recommendation.
          // Preserve that fact even when a later chunk failed.
          commitObserved();
        } finally {
          release();
        }
      },
    };
  }

  private async getOrCreateSession(threadId: string): Promise<LiveSession> {
    const existing = this.live.get(threadId);
    if (existing) {
      if (this.options.threads.findByThreadId(threadId)?.archived) {
        await this.evictLiveSession(threadId, existing);
        throw new Error("This Discord thread is not an active Exy conversation");
      }
      return existing;
    }
    const record = this.options.threads.findByThreadId(threadId);
    if (!record || record.archived) throw new Error("This Discord thread is not an active Exy conversation");
    const config = await this.options.configStore.readConfig();
    if (!config.model) throw new Error("No Pi model is configured; run exy login");
    const selected = await this.options.modelService.resolvePreference(config.model);

    const manager = record.piSessionId
      ? SessionManager.open(record.piSessionId, this.options.paths.sessionsDir, this.options.paths.workspaceDir)
      : SessionManager.create(this.options.paths.workspaceDir, this.options.paths.sessionsDir, { id: threadId });
    const sessionFile = manager.getSessionFile();
    if (!record.piSessionId && sessionFile) this.options.threads.setPiSessionId(threadId, sessionFile);

    const scope: Scope = { discordUserId: record.discordUserId, xAccountId: record.xAccountId };
    const automationTools = createAutomationTools({
      scope,
      threadId,
      configStore: this.options.configStore,
      paths: this.options.paths,
      jobs: this.options.jobs,
      skills: this.options.skills,
      ...(this.options.onHeartbeatChanged
        ? { onHeartbeatChanged: async () => this.options.onHeartbeatChanged?.() }
        : {}),
    });
    const exyTools = createExyTools({
      scope,
      threadId,
      sessionId: record.sessionId,
      xquik: this.options.xquik,
      zernio: this.options.zernio,
      exa: this.options.exa,
      supermemory: this.options.supermemory,
      candidates: this.options.candidates,
      drafts: this.options.drafts,
      stageReplyOpportunity: (input) => this.stageReplyOpportunity(threadId, scope, record.sessionId, input),
      dryRunPublishing: this.options.dryRunPublishing ?? false,
      extraTools: automationTools,
    });
    const researchToolNames = new Set(["search_x", "search_web", "fetch_web_page"]);
    const skillToolNames = new Set(["list_agent_skills", "activate_agent_skill", "read_agent_skill_resource"]);
    const saveDraftTool = exyTools.find((tool) => tool.name === "save_x_draft");
    if (!saveDraftTool) throw new Error("Exy's internal draft storage tool is unavailable");
    const subagentTools = createSubagentTools({
      paths: this.options.paths,
      configStore: this.options.configStore,
      modelService: this.options.modelService,
      researchTools: exyTools.filter((tool) => researchToolNames.has(tool.name)),
      skillTools: automationTools.filter((tool) => skillToolNames.has(tool.name)),
      saveDraft: (input, signal, context) => saveDraftTool.execute(
        "writing-subagent-draft",
        input,
        signal,
        undefined,
        context,
      ),
    });
    // Draft persistence is reachable only through the writing subagent tool, so
    // the coordinator cannot author copy and save it as if a writer produced it.
    const customTools = [
      ...exyTools.filter((tool) => tool.name !== "save_x_draft"),
      ...subagentTools,
    ];
    const loader = new DefaultResourceLoader({
      cwd: this.options.paths.workspaceDir,
      agentDir: this.options.paths.piAgentDir,
      systemPromptOverride: () => EXY_SYSTEM_PROMPT,
    });
    await loader.reload();
    const { session } = await createAgentSession({
      cwd: this.options.paths.workspaceDir,
      agentDir: this.options.paths.piAgentDir,
      modelRuntime: await this.options.modelService.modelRuntime,
      model: selected.model,
      thinkingLevel: config.model.reasoning,
      noTools: "builtin",
      customTools,
      resourceLoader: loader,
      sessionManager: manager,
    });
    const live: LiveSession = { session, record: { ...record, ...(sessionFile ? { piSessionId: sessionFile } : {}) }, preference: config.model };
    this.live.set(threadId, live);
    this.options.modelPreferences.set(scope, config.model);
    return live;
  }

  private async synchronizeSessionPreference(live: LiveSession): Promise<void> {
    const config = await this.options.configStore.readConfig();
    if (!config.model) throw new Error("No Pi model is configured; run exy login");
    if (
      live.record.discordUserId !== config.discord.authorizedUserId
      || live.record.xAccountId !== config.providers.zernioAccountId
    ) {
      await this.evictLiveSession(live.record.threadId, live);
      throw new Error("This Exy thread belongs to a previous user or connected X-account configuration; start a new parent-channel thread");
    }
    if (
      live.preference.provider === config.model.provider &&
      live.preference.modelId === config.model.modelId &&
      live.preference.reasoning === config.model.reasoning
    ) return;
    const selected = await this.options.modelService.resolvePreference(config.model);
    await live.session.setModel(selected.model);
    live.session.setThinkingLevel(config.model.reasoning);
    live.preference = config.model;
  }

  private async evictLiveSession(threadId: string, live: LiveSession): Promise<void> {
    if (this.live.get(threadId) !== live) return;
    this.live.delete(threadId);
    try {
      try {
        if (live.session.isStreaming) await live.session.abort();
      } finally {
        live.session.dispose();
      }
    } catch {
      // Eviction must preserve the archived/scope-mismatch outcome.
    }
  }

  private async recallMemory(scope: Scope, query: string, signal?: AbortSignal): Promise<string> {
    try {
      const context = await this.options.supermemory.recallContext({
        containerTag: memoryContainerTag(scope),
        q: query || "current X growth task",
        searchMode: "hybrid",
        limit: 6,
      }, signal);
      const lines = [
        ...context.static.map((value) => `- [profile] ${value}`),
        ...context.dynamic.map((value) => `- [recent] ${value}`),
        ...context.relevant.map((value) => `- [relevant] ${value}`),
      ];
      return lines.length === 0
        ? ""
        : `<recalled_user_context>\n${lines.join("\n")}\n</recalled_user_context>\n`;
    } catch (error) {
      if (signal?.aborted) throw abortError();
      this.options.logger.warn("Supermemory recall failed", safeContext(error));
      return "";
    }
  }

  private async rememberConversation(
    scope: Scope,
    input: RunAgentTurnInput,
    userContent: string,
    assistantContent: string,
    signal?: AbortSignal,
  ): Promise<void> {
    try {
      await this.options.supermemory.addConversation({
        containerTag: memoryContainerTag(scope),
        content: `user: ${userContent}\nassistant: ${assistantContent}`,
        customId: `exy-${input.threadId}-${input.messageId ?? randomUUID()}`,
        metadata: {
          type: input.automated ? "scheduled_task" : "conversation",
          discordThreadId: input.threadId,
          xAccountId: scope.xAccountId,
        },
      }, signal);
    } catch (error) {
      this.options.logger.warn("Supermemory conversation storage failed", safeContext(error));
    }
  }

  private async applyPreferenceToIdleSessions(preference: ModelPreference, selected: SelectableModel): Promise<void> {
    await Promise.all(
      [...this.live.values()].map(async (live) => {
        if (live.session.isStreaming) return;
        await live.session.setModel(selected.model);
        live.session.setThinkingLevel(preference.reasoning);
        live.preference = preference;
        const scope = { discordUserId: live.record.discordUserId, xAccountId: live.record.xAccountId };
        this.options.modelPreferences.set(scope, preference);
      }),
    );
  }

  private async mutateModel(operation: () => Promise<void>): Promise<void> {
    const next = this.modelMutation.then(operation, operation);
    this.modelMutation = next.catch(() => undefined);
    return next;
  }

  private async enqueue<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const tail = previous.catch(() => undefined).then(() => gate);
    this.queues.set(key, tail);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (this.queues.get(key) === tail) this.queues.delete(key);
    }
  }
}

function abortError(): Error {
  const error = new Error("Agent turn interrupted");
  error.name = "AbortError";
  return error;
}

function safeContext(error: unknown): Readonly<Record<string, unknown>> {
  return error instanceof Error ? { name: error.name, message: error.message } : { type: typeof error };
}

function toolResultJson(value: unknown): Record<string, unknown> | undefined {
  const text = toolResultText(value);
  if (text === undefined) return undefined;
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function toolResultText(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const content = (value as { content?: unknown }).content;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .filter((item): item is { type: "text"; text: string } => Boolean(
      item && typeof item === "object" && (item as { type?: unknown }).type === "text"
      && typeof (item as { text?: unknown }).text === "string",
    ))
    .map((item) => item.text)
    .join("\n");
  return text || undefined;
}

export function formatPublicationOutcome(data: Record<string, unknown> | undefined): string {
  if (data?.confirmed !== true) {
    const status = safeOutcomeField(data?.providerStatus, "unknown");
    const message = safeOutcomeField(data?.message, "Zernio did not confirm the configured X target as published.");
    return `Publication was not confirmed.\nProvider status: ${status}\n${message}`;
  }
  const status = safeOutcomeField(data.providerStatus, "published");
  const message = safeOutcomeField(data.message, "Zernio confirmed the configured X target as published.");
  const url = typeof data.providerPostUrl === "string" ? `\nPost: ${data.providerPostUrl}` : "";
  return `Zernio confirmed publication for the configured X account.\nProvider status: ${status}\n${message}${url}`;
}

function formatDelegatedDraft(
  userMessage: string,
  exactDraft: string,
  recommendationSummaries: readonly string[],
  recommendationIncludesExactDraft: boolean,
): string {
  const bareCopyRequested = /\b(?:bare|only|just)\b[^\n]{0,40}\b(?:copy|text|post|reply)\b|\b(?:copy|text)\s+only\b/iu.test(userMessage);
  if (bareCopyRequested) return exactDraft;
  if (recommendationIncludesExactDraft) return recommendationSummaries.join("\n\n");
  const renderedDraft = `I'd post this:\n\n${exactDraft}`;
  return recommendationSummaries.length > 0
    ? `${recommendationSummaries.join("\n\n")}\n\n${renderedDraft}`
    : renderedDraft;
}

function formatReplyRecommendation(staged: StagedRecommendation): string {
  const candidate = staged.candidate && typeof staged.candidate === "object" && !Array.isArray(staged.candidate)
    ? staged.candidate as Record<string, JsonValue>
    : undefined;
  const postText = typeof candidate?.text === "string" ? candidate.text : undefined;
  const author = typeof candidate?.authorUsername === "string" ? candidate.authorUsername : undefined;
  return [
    "Reply opportunity",
    `URL: ${staged.canonicalUrl}`,
    ...(author === undefined ? [] : [`Author: @${author.replace(/^@/u, "")}`]),
    ...(postText === undefined ? [] : [markdownBlock("Post", postText)]),
    markdownBlock("Why it fits", staged.rationale),
    ...(staged.suggestedReply === undefined ? [] : [markdownBlock("Suggested reply", staged.suggestedReply)]),
  ].join("\n");
}

function markdownBlock(label: string, content: string): string {
  const longestFence = Math.max(3, ...([...content.matchAll(/`+/gu)].map((match) => (match[0]?.length ?? 0) + 1)));
  const fence = "`".repeat(longestFence);
  return `${label}:\n${fence}\n${content}\n${fence}`;
}

function safeOutcomeField(value: unknown, fallback: string): string {
  if (typeof value !== "string" || value.trim() === "") return fallback;
  const normalized = value.replace(/[\r\n\t]+/gu, " ").trim();
  return normalized.length <= 500 ? normalized : `${normalized.slice(0, 497)}...`;
}
