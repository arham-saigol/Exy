import { randomUUID } from "node:crypto";

import type { PublishResult } from "./contracts.js";
import { ProviderHttp, type FetchLike, type QueryValue } from "./http.js";

const DEFAULT_BASE_URL = "https://zernio.com/api/v1";

export interface ZernioClientOptions {
  fetch?: FetchLike;
  baseUrl?: string;
  createRequestId?: () => string;
}

export interface ZernioProfileRef {
  _id: string;
  name?: string;
  slug?: string;
}

export interface ZernioAccount {
  _id: string;
  platform: string;
  profileId?: ZernioProfileRef;
  username?: string;
  displayName?: string;
  profileUrl?: string;
  isActive?: boolean;
  status?: string;
}

export interface ListAccountsInput {
  platform?: "twitter";
  status?: "connected";
  page?: number;
  limit?: number;
}

export interface ListAccountsResponse {
  accounts: ZernioAccount[];
  hasAnalyticsAccess?: boolean;
  pagination?: unknown;
}

export interface ZernioAccountHealth {
  accountId?: string;
  platform?: string;
  tokenValid?: boolean;
  canPost?: boolean;
  canFetchAnalytics?: boolean;
  missingPermissions?: string[];
  issues?: unknown[];
  reconnectRequired?: boolean;
  [key: string]: unknown;
}

export interface ZernioAccountsHealthResponse {
  summary?: {
    total?: number;
    healthy?: number;
    warning?: number;
    error?: number;
    needsReconnect?: number;
  };
  accounts: ZernioAccountHealth[];
}

export interface ZernioMediaItem {
  type: "image" | "video" | "gif" | "document";
  url: string;
  title?: string;
  altText?: string;
  filename?: string;
  size?: number;
  mimeType?: string;
  thumbnail?: string;
  instagramThumbnail?: string;
}

export interface ZernioTwitterPlatformData {
  replyToTweetId?: string;
  replySettings?: "following" | "mentionedUsers" | "subscribers" | "verified";
}

export interface ZernioPlatformTarget {
  platform: "twitter";
  accountId: string;
  customContent?: string;
  customMedia?: readonly ZernioMediaItem[];
  platformSpecificData?: ZernioTwitterPlatformData;
}

export interface ZernioPostRequest {
  content?: string;
  mediaItems?: readonly ZernioMediaItem[];
  platforms: readonly ZernioPlatformTarget[];
  publishNow: true;
}

export interface PublishOriginalInput {
  accountId: string;
  content?: string;
  mediaItems?: readonly ZernioMediaItem[];
  requestId?: string;
}

export interface PublishReplyInput extends PublishOriginalInput {
  replyToTweetId: string;
}

export interface ValidatePostInput {
  accountId: string;
  content?: string;
  mediaItems?: readonly ZernioMediaItem[];
  replyToTweetId?: string;
}

export interface ZernioValidationIssue {
  platform?: string;
  error?: string;
  warning?: string;
}

export interface ZernioValidationResult {
  valid: boolean;
  message?: string;
  warnings?: ZernioValidationIssue[];
  errors?: ZernioValidationIssue[];
}

export interface ZernioPlatformPublish {
  platform?: string;
  accountId?: string | { _id?: string };
  status?: string;
  publishedAt?: string;
  platformPostId?: string;
  platformPostUrl?: string;
  errorCategory?: string;
  errorSource?: string;
}

export interface ZernioPost {
  _id?: string;
  status?: string;
  publishedAt?: string;
  platforms?: ZernioPlatformPublish[];
}

export interface ZernioPostResponse {
  post?: ZernioPost;
  existingPost?: ZernioPost;
  message?: string;
}

export interface GetAnalyticsInput {
  postId?: string;
  platform?: "twitter";
  accountId?: string;
  fromDate?: string;
  toDate?: string;
  source?: "all" | "late" | "external";
  page?: number;
  limit?: number;
  sortBy?: string;
  order?: "asc" | "desc";
}

export interface ZernioAnalyticsResult<T = unknown> {
  state: "ready" | "pending";
  httpStatus: number;
  data: T;
}

export interface ZernioAnalyticsMetrics {
  impressions?: number;
  reach?: number;
  likes?: number;
  comments?: number;
  shares?: number;
  saves?: number;
  clicks?: number;
  views?: number;
  follows?: number;
  engagementRate?: number;
  lastUpdated?: string;
}

export interface ZernioPlatformAnalytics {
  platform?: string;
  status?: string;
  platformPostId?: string;
  accountId?: string;
  accountUsername?: string;
  analytics?: ZernioAnalyticsMetrics;
  syncStatus?: string;
  platformPostUrl?: string;
  errorMessage?: string | null;
}

export interface ZernioSinglePostAnalytics {
  postId?: string;
  latePostId?: string | null;
  status?: string;
  content?: string;
  publishedAt?: string;
  analytics?: ZernioAnalyticsMetrics;
  platformAnalytics?: ZernioPlatformAnalytics[];
  syncStatus?: string;
  message?: string | null;
}

export interface ZernioAnalyticsListResponse {
  overview?: Record<string, unknown>;
  posts?: Array<ZernioSinglePostAnalytics & { _id?: string; platforms?: ZernioPlatformAnalytics[] }>;
  pagination?: { page?: number; limit?: number; total?: number; pages?: number };
  accounts?: ZernioAccount[];
  hasAnalyticsAccess?: boolean;
}

export type ZernioAnalyticsResponse = ZernioSinglePostAnalytics | ZernioAnalyticsListResponse;

export interface GetFollowerStatsInput {
  accountIds: readonly string[];
  fromDate: string;
  toDate: string;
  granularity?: "daily" | "weekly" | "monthly";
}

export interface ZernioFollowerStatsResponse {
  accounts?: Array<{
    _id?: string;
    platform?: string;
    username?: string;
    currentFollowers?: number;
    growth?: number;
    growthPercentage?: number;
    dataPoints?: number;
  }>;
  stats?: Record<string, Array<{ date: string; followers: number }>>;
  dateRange?: { from?: string; to?: string };
  granularity?: "daily" | "weekly" | "monthly";
}

export class ZernioClient {
  readonly #http: ProviderHttp;
  readonly #createRequestId: () => string;

  constructor(apiKey: string, options: ZernioClientOptions = {}) {
    this.#http = new ProviderHttp({
      provider: "zernio",
      baseUrl: options.baseUrl ?? DEFAULT_BASE_URL,
      headers: { Authorization: `Bearer ${apiKey}` },
      secrets: [apiKey],
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    });
    this.#createRequestId = options.createRequestId ?? randomUUID;
  }

  async listAccounts(input: ListAccountsInput = {}): Promise<ListAccountsResponse> {
    const response = await this.#http.request<ListAccountsResponse>({
      path: "accounts",
      query: compactQuery({
        platform: input.platform ?? "twitter",
        status: input.status ?? "connected",
        page: input.page ?? 1,
        limit: input.limit ?? 100,
      }),
    });
    return response.data;
  }

  async getAccountHealth(accountId: string): Promise<ZernioAccountHealth> {
    assertNonEmpty("accountId", accountId);
    const response = await this.#http.request<ZernioAccountHealth>({
      path: `accounts/${encodeURIComponent(accountId)}/health`,
    });
    return response.data;
  }

  async getAccountsHealth(): Promise<ZernioAccountsHealthResponse> {
    const response = await this.#http.request<ZernioAccountsHealthResponse>({
      path: "accounts/health",
      query: { platform: "twitter" },
    });
    return response.data;
  }

  /** Content-only dry run. It neither publishes nor validates account access. */
  async validatePost(input: ValidatePostInput, signal?: AbortSignal): Promise<ZernioValidationResult> {
    const body = buildPostBody(input, false);
    const response = await this.#http.request<ZernioValidationResult>({
      path: "tools/validate/post",
      method: "POST",
      body,
      ...(signal === undefined ? {} : { signal }),
    });
    return response.data;
  }

  async publishOriginal(input: PublishOriginalInput, signal?: AbortSignal): Promise<PublishResult> {
    const body = buildPostBody(input, true);
    return this.#publish(body, input.accountId, input.requestId, signal);
  }

  async publishReply(input: PublishReplyInput, signal?: AbortSignal): Promise<PublishResult> {
    const body = buildPostBody(input, true);
    return this.#publish(body, input.accountId, input.requestId, signal);
  }

  async getPost(postId: string, signal?: AbortSignal): Promise<ZernioPostResponse> {
    assertNonEmpty("postId", postId);
    const response = await this.#http.request<ZernioPostResponse>({
      path: `posts/${encodeURIComponent(postId)}`,
      ...(signal === undefined ? {} : { signal }),
    });
    return response.data;
  }

  /** Polls a Zernio record and applies the same target-level success rule as publish. */
  async getPublishResult(postId: string, accountId: string, signal?: AbortSignal): Promise<PublishResult> {
    const response = await this.getPost(postId, signal);
    return interpretPublishResponse(response, accountId);
  }

  async getAnalytics<T = ZernioAnalyticsResponse>(input: GetAnalyticsInput = {}, signal?: AbortSignal): Promise<ZernioAnalyticsResult<T>> {
    const response = await this.#http.request<T>({
      path: "analytics",
      query: compactQuery({
        postId: input.postId,
        platform: input.platform,
        accountId: input.accountId,
        fromDate: input.fromDate,
        toDate: input.toDate,
        source: input.source,
        page: input.page,
        limit: input.limit,
        sortBy: input.sortBy,
        order: input.order,
      }),
      ...(signal === undefined ? {} : { signal }),
    });
    return {
      state: response.status === 202 ? "pending" : "ready",
      httpStatus: response.status,
      data: response.data,
    };
  }

  async getFollowerStats<T = ZernioFollowerStatsResponse>(input: GetFollowerStatsInput, signal?: AbortSignal): Promise<T> {
    if (input.accountIds.length === 0) throw new RangeError("At least one account ID is required.");
    const response = await this.#http.request<T>({
      path: "accounts/follower-stats",
      query: {
        accountIds: input.accountIds.join(","),
        fromDate: input.fromDate,
        toDate: input.toDate,
        granularity: input.granularity ?? "daily",
      },
      ...(signal === undefined ? {} : { signal }),
    });
    return response.data;
  }

  async #publish(body: ZernioPostRequest, accountId: string, requestId?: string, signal?: AbortSignal): Promise<PublishResult> {
    const response = await this.#http.request<ZernioPostResponse>({
      path: "posts",
      method: "POST",
      headers: { "x-request-id": requestId ?? this.#createRequestId() },
      body,
      ...(signal === undefined ? {} : { signal }),
    });
    return interpretPublishResponse(response.data, accountId);
  }
}

function buildPostBody(
  input: ValidatePostInput | PublishOriginalInput | PublishReplyInput,
  publishNow: true,
): ZernioPostRequest;
function buildPostBody(
  input: ValidatePostInput | PublishOriginalInput | PublishReplyInput,
  publishNow: false,
): Omit<ZernioPostRequest, "publishNow">;
function buildPostBody(
  input: ValidatePostInput | PublishOriginalInput | PublishReplyInput,
  publishNow: boolean,
): ZernioPostRequest | Omit<ZernioPostRequest, "publishNow"> {
  assertNonEmpty("accountId", input.accountId);
  const hasContent = input.content !== undefined && input.content.trim().length > 0;
  const hasMedia = input.mediaItems !== undefined && input.mediaItems.length > 0;
  if (!hasContent && !hasMedia) throw new TypeError("A post needs text or at least one media item.");

  const replyToTweetId = "replyToTweetId" in input ? input.replyToTweetId : undefined;
  if (replyToTweetId !== undefined && !/^\d+$/.test(replyToTweetId)) {
    throw new TypeError("replyToTweetId must be an X post ID, not a URL.");
  }
  const platform: ZernioPlatformTarget = {
    platform: "twitter",
    accountId: input.accountId,
    ...(replyToTweetId === undefined ? {} : { platformSpecificData: { replyToTweetId } }),
  };
  const common = {
    ...(input.content === undefined ? {} : { content: input.content }),
    ...(input.mediaItems === undefined ? {} : { mediaItems: input.mediaItems }),
    platforms: [platform],
  };
  return publishNow ? { ...common, publishNow: true } : common;
}

function interpretPublishResponse(response: ZernioPostResponse, accountId: string): PublishResult {
  const post = response.post ?? response.existingPost;
  const target = post?.platforms?.find((item) => {
    return item.platform === "twitter" && extractAccountId(item.accountId) === accountId;
  });
  const providerStatus = target?.status ?? post?.status ?? "unknown";
  const confirmed = target?.status === "published";

  return {
    confirmed,
    ...(post?._id === undefined ? {} : { providerRecordId: post._id }),
    ...(target?.platformPostId === undefined ? {} : { providerPostId: target.platformPostId }),
    ...(target?.platformPostUrl === undefined ? {} : { providerPostUrl: target.platformPostUrl }),
    providerStatus,
    message: confirmed
      ? "Zernio confirmed that the X target was published."
      : target === undefined
        ? "Zernio did not return a status for the requested X account target."
        : `Zernio reported the X target as ${safeStatus(target.status)}${formatErrorCategory(target.errorCategory)}.`,
  };
}

function extractAccountId(accountId: ZernioPlatformPublish["accountId"]): string | undefined {
  if (typeof accountId === "string") return accountId;
  return accountId?._id;
}

function safeStatus(status: string | undefined): string {
  if (status === undefined) return "unknown";
  return /^[a-zA-Z0-9_-]{1,40}$/.test(status) ? status : "unknown";
}

function formatErrorCategory(category: string | undefined): string {
  return category !== undefined && /^[a-z_]{1,40}$/.test(category) ? ` (${category})` : "";
}

function compactQuery(values: Readonly<Record<string, QueryValue>>): Record<string, QueryValue> {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined && value !== null));
}

function assertNonEmpty(name: string, value: string): void {
  if (value.trim().length === 0) throw new TypeError(`${name} must not be empty.`);
}
