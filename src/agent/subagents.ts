import {
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  SessionManager,
  type ExtensionContext,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ConfigStore } from "../config/store.js";
import type { ExyPaths } from "../config/paths.js";
import type { ModelPreference } from "../core/types.js";
import type { PiModelService, SelectableModel } from "./model-service.js";
import {
  RESEARCH_SUBAGENT_SYSTEM_PROMPT,
  WRITING_SUBAGENT_SYSTEM_PROMPT,
} from "./subagent-prompts.js";

export interface SpecializedSubagentRequest {
  role: "research" | "writing";
  systemPrompt: string;
  prompt: string;
  model: SelectableModel;
  preference: ModelPreference;
  tools: readonly ToolDefinition[];
  signal?: AbortSignal;
}

export interface SpecializedSubagentResult {
  output: string;
  searchedX: boolean;
}

export type SpecializedSubagentRunner = (
  request: SpecializedSubagentRequest,
) => Promise<SpecializedSubagentResult>;

export interface SubagentToolDependencies {
  paths: ExyPaths;
  configStore: ConfigStore;
  modelService: PiModelService;
  researchTools: readonly ToolDefinition[];
  skillTools: readonly ToolDefinition[];
  saveDraft(input: {
    kind: "reply" | "original";
    content: string;
    candidateRef?: string;
    post?: string;
  }, signal: AbortSignal | undefined, context: ExtensionContext): ReturnType<ToolDefinition["execute"]>;
  runner?: SpecializedSubagentRunner;
}

function text(value: unknown) {
  return {
    content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
    details: {},
  };
}

export function terminalAssistantText(messages: readonly unknown[]): string {
  const message = messages.at(-1) as {
    role?: unknown;
    content?: unknown;
    stopReason?: unknown;
    errorMessage?: unknown;
  } | undefined;
  if (message?.role !== "assistant") throw new Error("Subagent did not finish with an assistant response");
  if (typeof message.stopReason === "string" && message.stopReason !== "stop") {
    throw new Error(typeof message.errorMessage === "string" && message.errorMessage.trim()
      ? message.errorMessage
      : `Subagent stopped with ${message.stopReason}`);
  }
  if (!Array.isArray(message.content)) return "";
  return message.content
    .flatMap((part) => part && typeof part === "object"
      && (part as { type?: unknown }).type === "text"
      && typeof (part as { text?: unknown }).text === "string"
      ? [(part as { text: string }).text]
      : [])
    .join("");
}

export async function runPiSpecializedSubagent(
  paths: ExyPaths,
  modelService: PiModelService,
  request: SpecializedSubagentRequest,
): Promise<SpecializedSubagentResult> {
  if (request.signal?.aborted) {
    const error = new Error(`${request.role} subagent was interrupted`);
    error.name = "AbortError";
    throw error;
  }
  const loader = new DefaultResourceLoader({
    cwd: paths.workspaceDir,
    agentDir: paths.piAgentDir,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPromptOverride: () => request.systemPrompt,
  });
  await loader.reload();
  const { session } = await createAgentSession({
    cwd: paths.workspaceDir,
    agentDir: paths.piAgentDir,
    modelRuntime: await modelService.modelRuntime,
    model: request.model.model,
    thinkingLevel: request.preference.reasoning,
    noTools: "builtin",
    customTools: [...request.tools],
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(paths.workspaceDir),
  });
  let searchedX = false;
  const unsubscribe = session.subscribe((event) => {
    if (event.type === "tool_execution_end" && event.toolName === "search_x" && !event.isError) searchedX = true;
  });
  const abort = () => void session.abort().catch(() => undefined);
  request.signal?.addEventListener("abort", abort, { once: true });
  try {
    if (request.signal?.aborted) {
      await session.abort().catch(() => undefined);
      const error = new Error(`${request.role} subagent was interrupted`);
      error.name = "AbortError";
      throw error;
    }
    await session.prompt(request.prompt);
    if (request.signal?.aborted) {
      const error = new Error(`${request.role} subagent was interrupted`);
      error.name = "AbortError";
      throw error;
    }
    const output = terminalAssistantText(session.messages);
    if (!output.trim()) throw new Error(`${request.role} subagent returned no usable text`);
    return { output, searchedX };
  } finally {
    request.signal?.removeEventListener("abort", abort);
    unsubscribe();
    session.dispose();
  }
}

function taskPrompt(context: unknown): string {
  return `Complete this assignment using all supplied context.\n\n<task_context>\n${JSON.stringify(context, null, 2)}\n</task_context>`;
}

export function createSubagentTools(deps: SubagentToolDependencies): ToolDefinition[] {
  const runner = deps.runner ?? ((request) => runPiSpecializedSubagent(deps.paths, deps.modelService, request));

  const research = defineTool({
    name: "spawn_research_subagent",
    label: "Research with a specialist",
    description:
      "Spawn a focused research subagent for reply discovery, original-post research, or any substantial current/source-backed investigation. It inherits the main coordinator's current model and reasoning. Pass the user's request and all relevant known context; it can search X and the web repeatedly and use installed skills.",
    parameters: Type.Object({
      userRequest: Type.String({ minLength: 1 }),
      objective: Type.String({ minLength: 1 }),
      knownContext: Type.Optional(Type.String()),
      audienceContext: Type.Optional(Type.String()),
      relevantPreferences: Type.Optional(Type.String()),
    }),
    executionMode: "parallel",
    execute: async (_id, input, signal) => {
      const config = await deps.configStore.readConfig();
      if (!config.model) throw new Error("No main coordinator model is configured; run exy login");
      const selected = await deps.modelService.resolvePreference(config.model);
      const result = await runner({
        role: "research",
        systemPrompt: RESEARCH_SUBAGENT_SYSTEM_PROMPT,
        prompt: taskPrompt(input),
        model: selected,
        preference: config.model,
        tools: [...deps.researchTools, ...deps.skillTools],
        ...(signal ? { signal } : {}),
      });
      return text({
        findings: result.output,
        searchedX: result.searchedX,
        instruction: "Use these findings as internal context. Verify any reply opportunity through recommend_reply_opportunity before presenting it, and pass relevant findings to the writing subagent.",
      });
    },
  });

  const writing = defineTool({
    name: "spawn_writing_subagent",
    label: "Draft with a writing specialist",
    description:
      "Mandatory for every X reply or original-post draft. Spawn the user's selected OpenCode Go writing model. Supply the full request, research, source posts, audience, learned preferences, and other useful context. The returned draft must be saved and shown exactly; do not rewrite it yourself.",
    parameters: Type.Object({
      kind: Type.Union([Type.Literal("reply"), Type.Literal("original")]),
      userRequest: Type.String({ minLength: 1 }),
      researchFindings: Type.Optional(Type.String()),
      sourcePosts: Type.Optional(Type.String()),
      audienceContext: Type.Optional(Type.String()),
      writingPreferences: Type.Optional(Type.String()),
      additionalContext: Type.Optional(Type.String()),
      candidateRef: Type.Optional(Type.String({ minLength: 1, description: "Opaque searched reply target; mutually exclusive with post" })),
      post: Type.Optional(Type.String({ minLength: 1, maxLength: 500, description: "Direct reply target post ID/URL; mutually exclusive with candidateRef" })),
    }),
    executionMode: "sequential",
    execute: async (_id, input, signal, _onUpdate, context) => {
      const config = await deps.configStore.readConfig();
      if (!config.writingModel) {
        throw new Error("No OpenCode Go writing model is configured; run exy login and choose OpenCode Go");
      }
      let selected: SelectableModel;
      try {
        selected = await deps.modelService.resolveWritingPreference(config.writingModel);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`The configured writing model is unavailable. Run exy login and choose another OpenCode Go model. ${detail}`);
      }
      const result = await runner({
        role: "writing",
        systemPrompt: WRITING_SUBAGENT_SYSTEM_PROMPT,
        prompt: taskPrompt(input),
        model: selected,
        preference: config.writingModel,
        tools: deps.skillTools,
        ...(signal ? { signal } : {}),
      });
      if (signal?.aborted) {
        const error = new Error("writing subagent was interrupted before draft persistence");
        error.name = "AbortError";
        throw error;
      }
      if (result.output.length > 25_000) {
        throw new Error("The writing subagent returned more than Exy's existing draft-storage limit of 25,000 characters");
      }
      return deps.saveDraft({
        kind: input.kind,
        content: result.output,
        ...(input.candidateRef === undefined ? {} : { candidateRef: input.candidateRef }),
        ...(input.post === undefined ? {} : { post: input.post }),
      }, signal, context);
    },
  });

  return [research, writing];
}
