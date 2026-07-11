import { randomUUID } from "node:crypto";

import type { ResolvedXCandidate, XCandidate } from "./contracts.js";
import { ProviderHttp, type FetchLike, type QueryValue } from "./http.js";

const DEFAULT_BASE_URL = "https://xquik.com/api/v1";

export interface XquikClientOptions {
  fetch?: FetchLike;
  baseUrl?: string;
  maxResolvedCandidates?: number;
  createCandidateRef?: () => string;
}

export type XquikQueryType = "Latest" | "Top";
export type XquikTriState = "include" | "exclude" | "only";
export type XquikMediaType = "images" | "videos" | "gifs" | "media" | "links" | "none";

export interface SearchTweetsInput {
  query: string;
  queryType?: XquikQueryType;
  limit?: number;
  cursor?: string;
  fromUser?: string;
  toUser?: string;
  mentioning?: string;
  language?: string;
  sinceDate?: string;
  untilDate?: string;
  mediaType?: XquikMediaType;
  minFaves?: number;
  minRetweets?: number;
  minReplies?: number;
  minQuotes?: number;
  verifiedOnly?: boolean;
  replies?: XquikTriState;
  retweets?: XquikTriState;
  quotes?: XquikTriState;
  exactPhrase?: string;
  excludeWords?: string;
  anyWords?: string;
  hashtags?: string;
  cashtags?: string;
  url?: string;
  conversationId?: string;
  inReplyToTweetId?: string;
  quotesOfTweetId?: string;
  retweetsOfTweetId?: string;
}

export interface SearchTweetsResult {
  candidates: XCandidate[];
  hasNextPage: boolean;
  nextCursor?: string;
}

interface XquikTweetAuthor {
  id?: string;
  username?: string;
  name?: string;
}

interface XquikTweet {
  id?: string;
  text?: string;
  createdAt?: string;
  likeCount?: number;
  replyCount?: number;
  retweetCount?: number;
  quoteCount?: number;
  viewCount?: number;
  author?: XquikTweetAuthor;
}

interface XquikSearchResponse {
  tweets?: XquikTweet[];
  has_next_page?: boolean;
  next_cursor?: string;
}

interface StoredCandidate {
  value: ResolvedXCandidate;
  postId: string;
}

/**
 * Xquik search deliberately returns opaque references. Callers must resolve a
 * selected reference before verifier/publishing work can access its post ID.
 */
export class XquikClient {
  readonly #http: ProviderHttp;
  readonly #resolved = new Map<string, StoredCandidate>();
  readonly #postRefs = new Map<string, string>();
  readonly #maxResolvedCandidates: number;
  readonly #createCandidateRef: () => string;

  constructor(apiKey: string, options: XquikClientOptions = {}) {
    this.#http = new ProviderHttp({
      provider: "xquik",
      baseUrl: options.baseUrl ?? DEFAULT_BASE_URL,
      headers: { "x-api-key": apiKey },
      secrets: [apiKey],
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    });
    this.#maxResolvedCandidates = options.maxResolvedCandidates ?? 1_000;
    if (!Number.isInteger(this.#maxResolvedCandidates) || this.#maxResolvedCandidates < 1) {
      throw new RangeError("maxResolvedCandidates must be a positive integer.");
    }
    this.#createCandidateRef = options.createCandidateRef ?? (() => `xc_${randomUUID()}`);
  }

  /** Read-only and free according to Xquik's account endpoint contract. */
  async checkCredentials(): Promise<{ ok: true }> {
    await this.#http.request<unknown>({ path: "account" });
    return { ok: true };
  }

  async searchTweets(input: SearchTweetsInput, signal?: AbortSignal): Promise<SearchTweetsResult> {
    if (input.query.trim().length === 0) throw new TypeError("X search query must not be empty.");
    if (input.limit !== undefined && (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 200)) {
      throw new RangeError("Xquik search limit must be between 1 and 200.");
    }

    const response = await this.#http.request<XquikSearchResponse>({
      path: "x/tweets/search",
      query: compactQuery({
        q: input.query,
        queryType: input.queryType,
        limit: input.limit,
        cursor: input.cursor,
        fromUser: input.fromUser,
        toUser: input.toUser,
        mentioning: input.mentioning,
        language: input.language,
        sinceDate: input.sinceDate,
        untilDate: input.untilDate,
        mediaType: input.mediaType,
        minFaves: input.minFaves,
        minRetweets: input.minRetweets,
        minReplies: input.minReplies,
        minQuotes: input.minQuotes,
        verifiedOnly: input.verifiedOnly,
        replies: input.replies,
        retweets: input.retweets,
        quotes: input.quotes,
        exactPhrase: input.exactPhrase,
        excludeWords: input.excludeWords,
        anyWords: input.anyWords,
        hashtags: input.hashtags,
        cashtags: input.cashtags,
        url: input.url,
        conversationId: input.conversationId,
        inReplyToTweetId: input.inReplyToTweetId,
        quotesOfTweetId: input.quotesOfTweetId,
        retweetsOfTweetId: input.retweetsOfTweetId,
      }),
      ...(signal === undefined ? {} : { signal }),
    });

    const candidates = (response.data.tweets ?? []).flatMap((tweet) => {
      const postId = tweet.id;
      const text = tweet.text;
      if (typeof postId !== "string" || postId.length === 0 || typeof text !== "string") return [];
      return [this.#remember(tweet, postId, text)];
    });

    return {
      candidates,
      hasNextPage: response.data.has_next_page === true,
      ...(typeof response.data.next_cursor === "string" && response.data.next_cursor.length > 0
        ? { nextCursor: response.data.next_cursor }
        : {}),
    };
  }

  resolveCandidate(candidateRef: string): ResolvedXCandidate | undefined {
    const stored = this.#resolved.get(candidateRef);
    if (stored === undefined) return undefined;
    return cloneResolvedCandidate(stored.value);
  }

  forgetCandidate(candidateRef: string): boolean {
    const stored = this.#resolved.get(candidateRef);
    if (stored === undefined) return false;
    this.#resolved.delete(candidateRef);
    this.#postRefs.delete(stored.postId);
    return true;
  }

  #remember(tweet: XquikTweet, postId: string, text: string): XCandidate {
    let candidateRef = this.#postRefs.get(postId);
    if (candidateRef === undefined) {
      candidateRef = this.#createCandidateRef();
      this.#evictIfFull();
      this.#postRefs.set(postId, candidateRef);
    }

    const candidate: XCandidate = {
      candidateRef,
      text,
      ...(tweet.author?.username === undefined ? {} : { authorUsername: tweet.author.username }),
      ...(tweet.author?.name === undefined ? {} : { authorName: tweet.author.name }),
      ...(tweet.createdAt === undefined ? {} : { createdAt: tweet.createdAt }),
      metrics: {
        ...(tweet.likeCount === undefined ? {} : { likes: tweet.likeCount }),
        ...(tweet.replyCount === undefined ? {} : { replies: tweet.replyCount }),
        ...(tweet.retweetCount === undefined ? {} : { reposts: tweet.retweetCount }),
        ...(tweet.quoteCount === undefined ? {} : { quotes: tweet.quoteCount }),
        ...(tweet.viewCount === undefined ? {} : { views: tweet.viewCount }),
      },
    };
    const resolved: ResolvedXCandidate = {
      ...candidate,
      postId,
      canonicalUrl: `https://x.com/i/status/${postId}`,
    };
    this.#resolved.set(candidateRef, { value: resolved, postId });
    return cloneCandidate(candidate);
  }

  #evictIfFull(): void {
    if (this.#resolved.size < this.#maxResolvedCandidates) return;
    const oldestRef = this.#resolved.keys().next().value as string | undefined;
    if (oldestRef !== undefined) this.forgetCandidate(oldestRef);
  }
}

function compactQuery(values: Readonly<Record<string, QueryValue>>): Record<string, QueryValue> {
  return Object.fromEntries(
    Object.entries(values).filter((entry): entry is [string, Exclude<QueryValue, null | undefined>] => {
      return entry[1] !== undefined && entry[1] !== null;
    }),
  );
}

function cloneCandidate(candidate: XCandidate): XCandidate {
  return { ...candidate, metrics: { ...candidate.metrics } };
}

function cloneResolvedCandidate(candidate: ResolvedXCandidate): ResolvedXCandidate {
  return { ...candidate, metrics: { ...candidate.metrics } };
}
