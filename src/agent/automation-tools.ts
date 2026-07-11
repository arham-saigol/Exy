import { createHash } from "node:crypto";
import { chmod, open, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ConfigStore } from "../config/store.js";
import type { ExyPaths } from "../config/paths.js";
import type { ExyConfig, Scope } from "../core/types.js";
import type { JsonValue } from "../db/json.js";
import type { JobSchedule, ScheduledJob, ScheduledJobStore } from "../scheduler/index.js";
import { readHeartbeatDocument } from "../scheduler/index.js";
import type { SkillRegistry } from "../skills/index.js";

export interface AutomationToolDependencies {
  scope: Scope;
  threadId: string;
  configStore: ConfigStore;
  paths: ExyPaths;
  jobs: ScheduledJobStore;
  skills: SkillRegistry;
  onHeartbeatChanged?: (config: ExyConfig) => Promise<void> | void;
}

interface AgentJobPayload {
  ownerKey: string;
  displayName: string;
  prompt: string;
  threadId: string;
  discordUserId: string;
  xAccountId: string;
}

function text(value: unknown) {
  return {
    content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
    details: {},
  };
}

function asJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function ownerKey(scope: Scope): string {
  return createHash("sha256")
    .update(`${scope.discordUserId}\0${scope.xAccountId}`, "utf8")
    .digest("hex")
    .slice(0, 16);
}

function jobPayload(job: ScheduledJob): AgentJobPayload | undefined {
  const value = job.payload;
  if (!value || Array.isArray(value) || typeof value !== "object") return undefined;
  const payload = value as Record<string, JsonValue>;
  if (
    typeof payload.ownerKey !== "string" ||
    typeof payload.displayName !== "string" ||
    typeof payload.prompt !== "string" ||
    typeof payload.threadId !== "string" ||
    typeof payload.discordUserId !== "string" ||
    typeof payload.xAccountId !== "string"
  ) return undefined;
  return payload as unknown as AgentJobPayload;
}

function requireOwnedJob(deps: AutomationToolDependencies, id: string): { job: ScheduledJob; payload: AgentJobPayload } {
  const job = deps.jobs.get(id);
  const payload = job && jobPayload(job);
  if (!job || !payload || payload.ownerKey !== ownerKey(deps.scope)) {
    throw new Error("Scheduled job was not found in this user and X-account scope");
  }
  return { job, payload };
}

function projectJob(job: ScheduledJob, payload: AgentJobPayload) {
  return {
    id: job.id,
    name: payload.displayName,
    prompt: payload.prompt,
    deliveryThreadId: payload.threadId,
    schedule: job.schedule,
    enabled: job.enabled,
    ...(job.nextRunAt ? { nextRunAt: new Date(job.nextRunAt).toISOString() } : {}),
    ...(job.lastRunAt ? { lastRunAt: new Date(job.lastRunAt).toISOString() } : {}),
  };
}

function parseSchedule(input: {
  scheduleKind: "interval" | "once" | "cron";
  intervalMinutes?: number;
  runAt?: string;
  cron?: string;
  timezone?: string;
}): JobSchedule {
  switch (input.scheduleKind) {
    case "interval":
      if (!input.intervalMinutes) throw new Error("intervalMinutes is required for interval schedules");
      return { kind: "interval", everyMs: input.intervalMinutes * 60_000 };
    case "once": {
      if (!input.runAt) throw new Error("runAt is required for one-time schedules");
      const at = Date.parse(input.runAt);
      if (!Number.isFinite(at)) throw new Error("runAt must be an ISO 8601 date/time");
      return { kind: "once", at };
    }
    case "cron":
      if (!input.cron) throw new Error("cron is required for cron schedules");
      return { kind: "cron", expression: input.cron, timezone: input.timezone ?? "UTC" };
  }
}

async function writePrivateFileAtomic(path: string, content: string): Promise<void> {
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path).catch(async (error) => {
    await rm(temporary, { force: true });
    throw error;
  });
  if (process.platform !== "win32") await chmod(path, 0o600);
}

export function createAutomationTools(deps: AutomationToolDependencies): ToolDefinition[] {
  const key = ownerKey(deps.scope);

  const listSkills = defineTool({
    name: "list_agent_skills",
    label: "List agent skills",
    description: "List valid open Agent Skills currently discovered in the project's .agents/skills directory.",
    parameters: Type.Object({}),
    execute: async () => text(deps.skills.list().map(({ name, description, compatibility }) => ({ name, description, compatibility }))),
  });

  const activateSkill = defineTool({
    name: "activate_agent_skill",
    label: "Activate agent skill",
    description: "Load one discovered Agent Skill's complete SKILL.md instructions and contained resource list when its procedure is relevant.",
    parameters: Type.Object({ name: Type.String({ minLength: 1, maxLength: 64 }) }),
    execute: async (_id, input) => {
      const skill = deps.skills.activate(input.name);
      return text({ name: skill.name, description: skill.description, instructions: skill.body, resources: skill.resources });
    },
  });

  const readSkillResource = defineTool({
    name: "read_agent_skill_resource",
    label: "Read agent skill resource",
    description: "Read a contained text resource referenced by an activated Agent Skill. Paths cannot escape the selected skill.",
    parameters: Type.Object({
      name: Type.String({ minLength: 1, maxLength: 64 }),
      relativePath: Type.String({ minLength: 1, maxLength: 500 }),
    }),
    execute: async (_id, input) => text(deps.skills.readResource(input.name, input.relativePath)),
  });

  const createJob = defineTool({
    name: "create_scheduled_job",
    label: "Create scheduled work",
    description: "Create persisted agent work using a one-time, interval, or five-field cron schedule. This schedules an Exy prompt; it never creates a host shell command.",
    parameters: Type.Object({
      name: Type.String({ minLength: 1, maxLength: 80 }),
      prompt: Type.String({ minLength: 1, maxLength: 20_000 }),
      scheduleKind: Type.Union([Type.Literal("interval"), Type.Literal("once"), Type.Literal("cron")]),
      intervalMinutes: Type.Optional(Type.Integer({ minimum: 1, maximum: 525_600 })),
      runAt: Type.Optional(Type.String()),
      cron: Type.Optional(Type.String({ maxLength: 200 })),
      timezone: Type.Optional(Type.String({ maxLength: 100 })),
      enabled: Type.Optional(Type.Boolean()),
    }),
    execute: async (_id, input) => {
      const payload: AgentJobPayload = {
        ownerKey: key,
        displayName: input.name.trim(),
        prompt: input.prompt,
        threadId: deps.threadId,
        discordUserId: deps.scope.discordUserId,
        xAccountId: deps.scope.xAccountId,
      };
      const internalName = `${key}:${input.name.trim()}`.slice(0, 100);
      const job = deps.jobs.create({
        name: internalName,
        task: "agent_prompt",
        schedule: parseSchedule(input),
        payload: asJson(payload),
        enabled: input.enabled ?? true,
      });
      return text(projectJob(job, payload));
    },
  });

  const listJobs = defineTool({
    name: "list_scheduled_jobs",
    label: "List scheduled work",
    description: "List persisted scheduled jobs belonging to this user and connected X account.",
    parameters: Type.Object({ includeDisabled: Type.Optional(Type.Boolean()) }),
    execute: async (_id, input) =>
      text(
        deps.jobs.list(input.includeDisabled ?? true).flatMap((job) => {
          const payload = jobPayload(job);
          return payload?.ownerKey === key ? [projectJob(job, payload)] : [];
        }),
      ),
  });

  const updateJob = defineTool({
    name: "update_scheduled_job",
    label: "Update scheduled work",
    description: "Update the name, prompt, enabled state, or complete schedule of an owned persisted job.",
    parameters: Type.Object({
      id: Type.String({ format: "uuid" }),
      name: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
      prompt: Type.Optional(Type.String({ minLength: 1, maxLength: 20_000 })),
      enabled: Type.Optional(Type.Boolean()),
      scheduleKind: Type.Optional(Type.Union([Type.Literal("interval"), Type.Literal("once"), Type.Literal("cron")])),
      intervalMinutes: Type.Optional(Type.Integer({ minimum: 1, maximum: 525_600 })),
      runAt: Type.Optional(Type.String()),
      cron: Type.Optional(Type.String({ maxLength: 200 })),
      timezone: Type.Optional(Type.String({ maxLength: 100 })),
    }),
    execute: async (_id, input) => {
      const { payload } = requireOwnedJob(deps, input.id);
      const nextPayload: AgentJobPayload = {
        ...payload,
        ...(input.name ? { displayName: input.name.trim() } : {}),
        ...(input.prompt ? { prompt: input.prompt } : {}),
      };
      const schedule = input.scheduleKind ? parseSchedule({
        scheduleKind: input.scheduleKind,
        ...(input.intervalMinutes === undefined ? {} : { intervalMinutes: input.intervalMinutes }),
        ...(input.runAt === undefined ? {} : { runAt: input.runAt }),
        ...(input.cron === undefined ? {} : { cron: input.cron }),
        ...(input.timezone === undefined ? {} : { timezone: input.timezone }),
      }) : undefined;
      const updated = deps.jobs.update(input.id, {
        name: `${key}:${nextPayload.displayName}`.slice(0, 100),
        payload: asJson(nextPayload),
        ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
        ...(schedule === undefined ? {} : { schedule }),
      });
      return text(projectJob(updated, nextPayload));
    },
  });

  const removeJob = defineTool({
    name: "remove_scheduled_job",
    label: "Remove scheduled work",
    description: "Disable and soft-delete one owned persisted scheduled job.",
    parameters: Type.Object({ id: Type.String({ format: "uuid" }) }),
    execute: async (_id, input) => {
      requireOwnedJob(deps, input.id);
      return text({ removed: deps.jobs.remove(input.id), id: input.id });
    },
  });

  const jobHistory = defineTool({
    name: "inspect_scheduled_job_history",
    label: "Inspect scheduled work history",
    description: "Inspect recent execution status, timing, concise output, and sanitized failures for an owned job.",
    parameters: Type.Object({ id: Type.String({ format: "uuid" }), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })) }),
    execute: async (_id, input) => {
      requireOwnedJob(deps, input.id);
      return text(deps.jobs.listRuns(input.id, input.limit ?? 20));
    },
  });

  const inspectHeartbeat = defineTool({
    name: "inspect_heartbeat",
    label: "Inspect heartbeat",
    description: "Read the current HEARTBEAT.md and its persisted enabled/interval configuration. Activate the bundled automation skill before changing it.",
    parameters: Type.Object({}),
    execute: async () => {
      const config = await deps.configStore.readConfig();
      const document = await readHeartbeatDocument(deps.paths.heartbeatFile, true);
      return text({ configuration: config.heartbeat, content: document.content });
    },
  });

  const updateHeartbeat = defineTool({
    name: "update_heartbeat",
    label: "Update heartbeat",
    description: "Replace HEARTBEAT.md and/or persist its enabled state and interval. The file is data, not a shell script; never put secrets in it.",
    parameters: Type.Object({
      content: Type.Optional(Type.String({ maxLength: 131_072 })),
      enabled: Type.Optional(Type.Boolean()),
      intervalMinutes: Type.Optional(Type.Integer({ minimum: 1, maximum: 10_080 })),
    }),
    execute: async (_id, input) => {
      if (input.content !== undefined) await writePrivateFileAtomic(deps.paths.heartbeatFile, input.content);
      const next = await deps.configStore.updateConfig((config): ExyConfig => ({
        ...config,
        heartbeat: {
          ...config.heartbeat,
          ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
          ...(input.intervalMinutes === undefined ? {} : { intervalMinutes: input.intervalMinutes }),
          deliveryThreadId: deps.threadId,
        },
      }));
      await deps.onHeartbeatChanged?.(next);
      return text({ updated: true, configuration: next.heartbeat, file: deps.paths.heartbeatFile });
    },
  });

  return [
    listSkills,
    activateSkill,
    readSkillResource,
    createJob,
    listJobs,
    updateJob,
    removeJob,
    jobHistory,
    inspectHeartbeat,
    updateHeartbeat,
  ];
}
