import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Scope } from "../core/types.js";
import type { PublicationApprovalRepository } from "../db/approvals.js";
import type { CandidateMappingRepository } from "../db/candidates.js";
import type { JsonValue } from "../db/json.js";
import type { ExaClient } from "../providers/exa.js";
import type { SupermemoryClient } from "../providers/supermemory.js";
import type { XquikClient } from "../providers/xquik.js";
import type { ZernioClient } from "../providers/zernio.js";
import { canonicalizeXPost } from "../verifier/canonicalize.js";
import { formatApprovalCode } from "./approval-code.js";
import { memoryContainerTag } from "./scope.js";

export interface ExyToolDependencies {
  scope: Scope;
  threadId: string;
  sessionId: string;
  xquik: XquikClient;
  zernio: ZernioClient;
  exa: ExaClient;
  supermemory: SupermemoryClient;
  candidates: CandidateMappingRepository;
  stageReplyOpportunity(input: {
    post: string;
    rationale: string;
    suggestedReply?: string;
    candidate?: JsonValue;
  }): StageReplyOpportunityResult;
  approvals: PublicationApprovalRepository;
  xAccountLabel: string;
  dryRunPublishing?: boolean;
  extraTools?: readonly ToolDefinition[];
}

export interface StageReplyOpportunityResult {
  status: "staged" | "already_recommended" | "pending_delivery";
  presented: boolean;
  alreadyRecommended: boolean;
  pendingDelivery: boolean;
  canonicalUrl: string;
  instruction: string;
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

function requireCandidate(deps: ExyToolDependencies, candidateRef: string) {
  const candidate = deps.candidates.findByReference(deps.sessionId, candidateRef);
  if (!candidate) {
    throw new Error("Candidate reference was not found in this conversation. Search X again before using it.");
  }
  return candidate;
}

interface PublicationPayload {
  kind: "reply" | "original";
  content: string;
  accountId: string;
  targetPostId?: string;
}

function publicationPayload(value: JsonValue): PublicationPayload {
  if (!value || Array.isArray(value) || typeof value !== "object") throw new Error("Stored publication payload is invalid");
  const candidate = value as Record<string, JsonValue>;
  if (
    (candidate.kind !== "reply" && candidate.kind !== "original") ||
    typeof candidate.content !== "string" ||
    typeof candidate.accountId !== "string"
  ) {
    throw new Error("Stored publication payload is invalid");
  }
  if (candidate.kind === "reply" && typeof candidate.targetPostId !== "string") {
    throw new Error("Stored reply payload has no target post ID");
  }
  return {
    kind: candidate.kind,
    content: candidate.content,
    accountId: candidate.accountId,
    ...(typeof candidate.targetPostId === "string" ? { targetPostId: candidate.targetPostId } : {}),
  };
}

export function createExyTools(deps: ExyToolDependencies): ToolDefinition[] {
  const containerTag = memoryContainerTag(deps.scope);

  const searchX = defineTool({
    name: "search_x",
    label: "Search X",
    description:
      "Search Xquik for raw X post candidates. Results deliberately use opaque candidateRef values and are not recommendations. Before showing any candidate as a reply opportunity, call recommend_reply_opportunity.",
    parameters: Type.Object({
      query: Type.String({ minLength: 1, description: "X search syntax or natural keywords" }),
      sort: Type.Optional(Type.Union([Type.Literal("Latest"), Type.Literal("Top")])),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
      minimumLikes: Type.Optional(Type.Integer({ minimum: 0 })),
      language: Type.Optional(Type.String()),
    }),
    execute: async (_id, input, signal) => {
      const page = await deps.xquik.searchTweets({
        query: input.query,
        queryType: input.sort ?? "Latest",
        limit: input.limit ?? 10,
        ...(input.minimumLikes === undefined ? {} : { minFaves: input.minimumLikes }),
        ...(input.language === undefined ? {} : { language: input.language }),
      }, signal);
      for (const raw of page.candidates) {
        const resolved = deps.xquik.resolveCandidate(raw.candidateRef);
        if (!resolved) continue;
        deps.candidates.put({
          sessionId: deps.sessionId,
          candidateRef: raw.candidateRef,
          postId: resolved.postId,
          canonicalUrl: resolved.canonicalUrl,
          candidate: asJson(raw),
        });
      }
      return text({
        notice: "Raw search results only. Do not expose or describe one as an opportunity until the verifier accepts it.",
        candidates: page.candidates,
        hasNextPage: page.hasNextPage,
        ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
      });
    },
  });

  const recommendReply = defineTool({
    name: "recommend_reply_opportunity",
    label: "Verify and recommend reply opportunity",
    description:
      "Mandatory presentation boundary for any X post that will be framed as a reply opportunity. Accept either an Xquik candidateRef or a direct numeric post ID/X URL. The recommendation is persisted only after the final response includes the returned canonical URL and Discord confirms delivery. If presented=false, say it was already recommended and do not frame it as new.",
    parameters: Type.Object({
      candidateRef: Type.Optional(Type.String({ minLength: 1 })),
      post: Type.Optional(Type.String({ minLength: 1, maxLength: 500, description: "Direct X post ID or status URL when no Xquik candidateRef exists" })),
      rationale: Type.String({ minLength: 1, maxLength: 2000 }),
      suggestedReply: Type.Optional(Type.String({ maxLength: 5000 })),
    }),
    execute: async (_id, input) => {
      if ((input.candidateRef === undefined) === (input.post === undefined)) {
        throw new Error("Provide exactly one of candidateRef or post");
      }
      const candidate = input.candidateRef === undefined ? undefined : requireCandidate(deps, input.candidateRef);
      const result = deps.stageReplyOpportunity({
        post: candidate?.postId ?? input.post!,
        rationale: input.rationale,
        ...(input.suggestedReply === undefined ? {} : { suggestedReply: input.suggestedReply }),
        ...(candidate?.candidate === undefined ? {} : { candidate: candidate.candidate }),
      });
      if (result.status === "pending_delivery") {
        return text({
          presented: false,
          alreadyRecommended: false,
          pendingDelivery: true,
          instruction: result.instruction,
        });
      }
      if (!result.presented) {
        return text({ presented: false, alreadyRecommended: true, instruction: result.instruction });
      }
      return text({
        presented: true,
        url: result.canonicalUrl,
        ...(candidate?.candidate === undefined ? {} : { candidate: candidate.candidate }),
        rationale: input.rationale,
        ...(input.suggestedReply ? { suggestedReply: input.suggestedReply } : {}),
        instruction: `${result.instruction} Include the exact returned canonical URL in the final response or it will not be recorded as presented.`,
      });
    },
  });

  const searchWeb = defineTool({
    name: "search_web",
    label: "Search the web",
    description: "Search current web information through Exa. Use when external, current, or source-backed context is useful.",
    parameters: Type.Object({
      query: Type.String({ minLength: 1 }),
      resultCount: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
      includeDomains: Type.Optional(Type.Array(Type.String(), { maxItems: 20 })),
    }),
    execute: async (_id, input, signal) =>
      text(
        await deps.exa.search({
          query: input.query,
          numResults: input.resultCount ?? 8,
          type: "auto",
          ...(input.includeDomains ? { includeDomains: input.includeDomains } : {}),
          contents: { text: { maxCharacters: 2500 }, highlights: true },
        }, signal),
      ),
  });

  const renderOriginalDraft = defineTool({
    name: "render_original_post_draft",
    label: "Render original-post draft",
    description: "Required presentation boundary for every original-post draft. It preserves exact draft text after X research and keeps original drafts outside the reply-opportunity verifier. This never publishes or creates an approval.",
    parameters: Type.Object({ content: Type.String({ minLength: 1, maxLength: 25_000 }) }),
    execute: async (_id, input) => text({ kind: "original_draft", exactContent: input.content, published: false }),
  });

  const fetchWeb = defineTool({
    name: "fetch_web_page",
    label: "Fetch web page",
    description: "Fetch the readable contents of a known URL through Exa.",
    parameters: Type.Object({ url: Type.String({ format: "uri" }) }),
    execute: async (_id, input, signal) => text(await deps.exa.fetchPage({ url: input.url, text: { maxCharacters: 20_000 } }, signal)),
  });

  const searchMemory = defineTool({
    name: "search_memory",
    label: "Search long-term memory",
    description: "Retrieve voice, preferences, strategy, prior conversation, and task history from this user and connected-X-account scope only.",
    parameters: Type.Object({ query: Type.String({ minLength: 1 }), limit: Type.Optional(Type.Integer({ minimum: 2, maximum: 20 })) }),
    execute: async (_id, input, signal) =>
      text(await deps.supermemory.search({ containerTag, q: input.query, searchMode: "hybrid", limit: input.limit ?? 5 }, signal)),
  });

  const storeMemory = defineTool({
    name: "store_memory",
    label: "Store long-term memory",
    description: "Store a durable user voice, preference, X strategy, or task-history fact in this isolated Supermemory scope.",
    parameters: Type.Object({
      content: Type.String({ minLength: 1, maxLength: 10_000 }),
      category: Type.Union([
        Type.Literal("voice"),
        Type.Literal("preference"),
        Type.Literal("strategy"),
        Type.Literal("task_history"),
      ]),
      stable: Type.Optional(Type.Boolean({ description: "True for a stable profile fact" })),
    }),
    execute: async (_id, input, signal) =>
      text(
        await deps.supermemory.addContext({
          containerTag,
          memories: [{ content: input.content, isStatic: input.stable ?? false, metadata: { category: input.category } }],
        }, signal),
      ),
  });

  const preparePublication = defineTool({
    name: "prepare_x_publication",
    label: "Prepare X publication approval",
    description:
      "Validate and prepare an immutable reply or original post for explicit user approval. This never publishes. Show the exact content/target and instruct the user to send `approve <approvalCode>` in a later message.",
    parameters: Type.Object({
      kind: Type.Union([Type.Literal("reply"), Type.Literal("original")]),
      content: Type.String({ minLength: 1, maxLength: 25_000 }),
      candidateRef: Type.Optional(Type.String({ description: "For a searched reply target; mutually exclusive with post" })),
      post: Type.Optional(Type.String({ minLength: 1, maxLength: 500, description: "Direct reply target post ID or X status URL; mutually exclusive with candidateRef" })),
    }),
    execute: async (_id, input, signal) => {
      if (input.kind === "reply" && ((input.candidateRef === undefined) === (input.post === undefined))) {
        throw new Error("Reply preparation requires exactly one candidateRef or direct post ID/URL");
      }
      if (input.kind === "original" && (input.candidateRef !== undefined || input.post !== undefined)) {
        throw new Error("Original-post preparation must not include a reply target");
      }
      const candidate = input.kind === "reply" && input.candidateRef !== undefined
        ? requireCandidate(deps, input.candidateRef)
        : undefined;
      const target = input.kind === "reply"
        ? candidate ?? canonicalizeXPost(input.post!)
        : undefined;
      const validation = await deps.zernio.validatePost({
        accountId: deps.scope.xAccountId,
        content: input.content,
        ...(target ? { replyToTweetId: target.postId } : {}),
      }, signal);
      if (!validation.valid) {
        return text({ prepared: false, validation, instruction: "Fix validation errors; no approval was created." });
      }
      // A prepared reply displays its target in the approval card. Route that
      // presentation through the verifier even if Pi skipped the explicit
      // recommendation tool. Previously recommended targets remain usable.
      if (target) {
        const stage = deps.stageReplyOpportunity({
          post: target.postId,
          rationale: "Selected as the target for this prepared reply.",
          suggestedReply: input.content,
          ...(candidate?.candidate === undefined ? {} : { candidate: candidate.candidate }),
        });
        if (stage.status === "pending_delivery") {
          return text({
            prepared: false,
            verifierPending: true,
            instruction: "This reply target is pending delivery in another Exy conversation. Retry after that delivery settles; no approval was created.",
          });
        }
      }
      const payload: PublicationPayload = {
        kind: input.kind,
        content: input.content,
        accountId: deps.scope.xAccountId,
        ...(target ? { targetPostId: target.postId } : {}),
      };
      const prepared = deps.approvals.prepare({
        ...deps.scope,
        kind: input.kind,
        payload: asJson(payload),
        ...(target ? { targetPostId: target.postId } : {}),
      });
      return text({
        prepared: true,
        approvalId: prepared.approval.id,
        approvalCode: formatApprovalCode(prepared.approval.id, prepared.approvalToken),
        exactContent: input.content,
        account: deps.xAccountLabel,
        ...(target ? { target: target.canonicalUrl } : { target: "new original X post" }),
        expiresAt: new Date(prepared.approval.expiresAt).toISOString(),
        instruction: "Do not publish yet. Ask the user to send: approve <approvalCode>",
      });
    },
  });

  const publishApproved = defineTool({
    name: "publish_approved_x",
    label: "Publish approved X content",
    description:
      "Publish one exact, explicitly approved preparation through Zernio. Takes only the approval ID; content cannot be changed here. Never call before the gateway reports that the user approval was accepted.",
    parameters: Type.Object({ approvalId: Type.String({ format: "uuid" }) }),
    execute: async (_id, input, signal) => {
      const approval = deps.approvals.consume(input.approvalId, deps.scope);
      const payload = publicationPayload(approval.payload);
      if (payload.accountId !== deps.scope.xAccountId || payload.kind !== approval.kind) {
        throw new Error("Approved publication scope or kind does not match the current account");
      }
      if (deps.dryRunPublishing) {
        return text({
          confirmed: false,
          providerStatus: "dry_run",
          message: "Dry-run mode consumed the approval but intentionally made no provider publication request.",
        });
      }
      const result = payload.kind === "reply"
        ? await deps.zernio.publishReply({
            accountId: payload.accountId,
            content: payload.content,
            replyToTweetId: payload.targetPostId!,
            requestId: approval.id,
          }, signal)
        : await deps.zernio.publishOriginal({
            accountId: payload.accountId,
            content: payload.content,
            requestId: approval.id,
          }, signal);
      if (result.providerRecordId) {
        deps.approvals.recordProviderAttempt(approval.id, deps.scope, {
          providerRecordId: result.providerRecordId,
          providerStatus: result.providerStatus,
          confirmed: result.confirmed,
        });
      }
      return text(result);
    },
  });

  const account = defineTool({
    name: "inspect_x_account",
    label: "Inspect X account",
    description: "Retrieve details and connection health for the configured X account through Zernio.",
    parameters: Type.Object({}),
    execute: async (_id, _input, signal) => {
      let page = 1;
      let configured: Awaited<ReturnType<ZernioClient["listAccounts"]>>["accounts"][number] | undefined;
      let hasAnalyticsAccess: boolean | undefined;
      while (!configured) {
        const listing = await deps.zernio.listAccounts({
          platform: "twitter",
          status: "connected",
          page,
          limit: 100,
        }, signal);
        hasAnalyticsAccess = listing.hasAnalyticsAccess;
        configured = listing.accounts.find((candidate) => candidate._id === deps.scope.xAccountId);
        const lastPage = listing.pagination?.pages;
        if (configured || (lastPage === undefined ? listing.accounts.length < 100 : page >= lastPage)) break;
        page += 1;
      }
      if (!configured) throw new Error("The configured X account is not available to the authenticated Zernio user");
      const health = await deps.zernio.getAccountHealth(deps.scope.xAccountId, signal);
      return text({ account: configured, health, hasAnalyticsAccess });
    },
  });

  const analytics = defineTool({
    name: "inspect_x_analytics",
    label: "Inspect X analytics",
    description: "Retrieve post analytics or account follower growth for the configured X account through Zernio.",
    parameters: Type.Object({
      mode: Type.Union([Type.Literal("posts"), Type.Literal("followers")]),
      postId: Type.Optional(Type.String()),
      fromDate: Type.Optional(Type.String({ description: "YYYY-MM-DD" })),
      toDate: Type.Optional(Type.String({ description: "YYYY-MM-DD" })),
      page: Type.Optional(Type.Integer({ minimum: 1 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
      sortBy: Type.Optional(Type.Union([
        Type.Literal("date"),
        Type.Literal("engagement"),
        Type.Literal("impressions"),
        Type.Literal("reach"),
        Type.Literal("likes"),
        Type.Literal("comments"),
        Type.Literal("shares"),
        Type.Literal("saves"),
        Type.Literal("clicks"),
        Type.Literal("views"),
        Type.Literal("follows"),
      ])),
      order: Type.Optional(Type.Union([Type.Literal("asc"), Type.Literal("desc")])),
      granularity: Type.Optional(Type.Union([Type.Literal("daily"), Type.Literal("weekly"), Type.Literal("monthly")])),
    }),
    execute: async (_id, input, signal) => {
      if (input.mode === "followers") {
        if (!input.fromDate || !input.toDate) throw new Error("Follower analytics requires fromDate and toDate");
        return text(
          await deps.zernio.getFollowerStats({
            accountIds: [deps.scope.xAccountId],
            fromDate: input.fromDate,
            toDate: input.toDate,
            ...(input.granularity ? { granularity: input.granularity } : {}),
          }, signal),
        );
      }
      return text(
        await deps.zernio.getAnalytics({
          platform: "twitter",
          accountId: deps.scope.xAccountId,
          ...(input.postId ? { postId: input.postId } : {}),
          ...(input.fromDate ? { fromDate: input.fromDate } : {}),
          ...(input.toDate ? { toDate: input.toDate } : {}),
          page: input.page ?? 1,
          limit: input.limit ?? 50,
          ...(input.sortBy ? { sortBy: input.sortBy } : {}),
          order: input.order ?? "desc",
        }, signal),
      );
    },
  });

  const postHistory = defineTool({
    name: "list_x_post_history",
    label: "List X post history",
    description: "List a page of past posts for the configured X account through Zernio, including Zernio-authored or externally synced posts.",
    parameters: Type.Object({
      page: Type.Optional(Type.Integer({ minimum: 1 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
      source: Type.Optional(Type.Union([Type.Literal("zernio"), Type.Literal("external")])),
      status: Type.Optional(Type.Union([
        Type.Literal("draft"),
        Type.Literal("scheduled"),
        Type.Literal("published"),
        Type.Literal("failed"),
      ])),
      dateFrom: Type.Optional(Type.String({ description: "YYYY-MM-DD" })),
      dateTo: Type.Optional(Type.String({ description: "YYYY-MM-DD" })),
      search: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
      sortBy: Type.Optional(Type.Union([
        Type.Literal("scheduled-desc"),
        Type.Literal("scheduled-asc"),
        Type.Literal("created-desc"),
        Type.Literal("created-asc"),
        Type.Literal("status"),
        Type.Literal("platform"),
      ])),
    }),
    execute: async (_id, input, signal) => text(await deps.zernio.listPosts({
      accountId: deps.scope.xAccountId,
      page: input.page ?? 1,
      limit: input.limit ?? 20,
      source: input.source ?? "zernio",
      ...(input.status ? { status: input.status } : {}),
      ...(input.dateFrom ? { dateFrom: input.dateFrom } : {}),
      ...(input.dateTo ? { dateTo: input.dateTo } : {}),
      ...(input.search ? { search: input.search } : {}),
      sortBy: input.sortBy ?? "created-desc",
    }, signal)),
  });

  const inspectPublicationStatus = defineTool({
    name: "inspect_x_publication_status",
    label: "Inspect X publication status",
    description: "Recheck the exact Zernio provider record already bound to a consumed publication approval in this user/X-account scope.",
    parameters: Type.Object({
      approvalId: Type.String({ format: "uuid" }),
    }),
    execute: async (_id, input, signal) => {
      const approval = deps.approvals.getForScope(input.approvalId, deps.scope);
      if (approval.state !== "consumed") throw new Error("Publication status can only be checked after an approved item was consumed");
      const attempt = deps.approvals.getProviderAttempt(input.approvalId, deps.scope);
      if (!attempt) throw new Error("This approval has no bound Zernio provider record to inspect");
      const result = await deps.zernio.getPublishResult(attempt.providerRecordId, deps.scope.xAccountId, signal);
      deps.approvals.recordProviderAttempt(input.approvalId, deps.scope, {
        providerRecordId: attempt.providerRecordId,
        providerStatus: result.providerStatus,
        confirmed: result.confirmed,
      });
      return text(result);
    },
  });

  return [
    searchX,
    recommendReply,
    renderOriginalDraft,
    searchWeb,
    fetchWeb,
    searchMemory,
    storeMemory,
    preparePublication,
    publishApproved,
    inspectPublicationStatus,
    account,
    analytics,
    postHistory,
    ...(deps.extraTools ?? []),
  ];
}
