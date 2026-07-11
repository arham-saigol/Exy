import type { MemoryContext } from "./contracts.js";
import { ProviderHttp, type FetchLike } from "./http.js";

const DEFAULT_BASE_URL = "https://api.supermemory.ai";
const CONTAINER_TAG_PATTERN = /^[a-zA-Z0-9_:-]+$/;

export interface SupermemoryClientOptions {
  fetch?: FetchLike;
  baseUrl?: string;
}

export interface MemoryMetadata {
  readonly [key: string]: unknown;
}

export interface AddConversationInput {
  containerTag: string;
  content: string;
  customId?: string;
  metadata?: MemoryMetadata;
}

export interface AddDocumentResponse {
  id: string;
  status: string;
}

export interface MemoryFactInput {
  content: string;
  isStatic?: boolean;
  metadata?: MemoryMetadata;
}

export interface AddContextInput {
  containerTag: string;
  memories: readonly MemoryFactInput[];
}

export interface AddedMemory {
  id: string;
  memory: string;
  isStatic: boolean;
  createdAt: string;
}

export interface AddContextResponse {
  documentId: string;
  memories: AddedMemory[];
}

export interface ProfileInput {
  containerTag: string;
  q?: string;
  threshold?: number;
}

export interface SupermemoryProfile {
  static: string[];
  dynamic: string[];
}

export interface ProfileResponse {
  profile: SupermemoryProfile;
  searchResults?: SupermemorySearchResult[];
}

export type SupermemorySearchMode = "memories" | "hybrid" | "documents";

export interface SearchMemoryInput {
  containerTag: string;
  q: string;
  searchMode?: SupermemorySearchMode;
  limit?: number;
  threshold?: number;
  rerank?: boolean;
}

export interface SupermemorySearchResult {
  id: string;
  memory?: string;
  chunk?: string;
  similarity?: number;
  metadata?: MemoryMetadata;
  updatedAt?: string;
  version?: number;
}

export interface SearchMemoryResponse {
  results: SupermemorySearchResult[];
  timing?: unknown;
  total?: number;
}

export class SupermemoryClient {
  readonly #http: ProviderHttp;

  constructor(apiKey: string, options: SupermemoryClientOptions = {}) {
    this.#http = new ProviderHttp({
      provider: "supermemory",
      baseUrl: options.baseUrl ?? DEFAULT_BASE_URL,
      headers: { Authorization: `Bearer ${apiKey}` },
      secrets: [apiKey],
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    });
  }

  /** A read-only authentication/connectivity probe. */
  async checkCredentials(): Promise<{ ok: true }> {
    await this.#http.request<unknown>({ path: "v3/documents/processing" });
    return { ok: true };
  }

  /**
   * Queues a conversation or task-history document for memory extraction.
   * A stable customId can be reused for incremental conversation updates.
   */
  async addConversation(input: AddConversationInput, signal?: AbortSignal): Promise<AddDocumentResponse> {
    assertContainerTag(input.containerTag);
    if (input.content.trim().length === 0) throw new TypeError("Memory content must not be empty.");

    const response = await this.#http.request<AddDocumentResponse>({
      path: "v3/documents",
      method: "POST",
      body: {
        content: input.content,
        containerTag: input.containerTag,
        ...(input.customId === undefined ? {} : { customId: input.customId }),
        ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
      },
      ...(signal === undefined ? {} : { signal }),
    });
    return response.data;
  }

  /** Stores known voice, preference, or strategy facts directly. */
  async addContext(input: AddContextInput, signal?: AbortSignal): Promise<AddContextResponse> {
    assertContainerTag(input.containerTag);
    if (input.memories.length === 0 || input.memories.length > 100) {
      throw new RangeError("Supermemory accepts between 1 and 100 memories per request.");
    }
    for (const memory of input.memories) {
      if (memory.content.trim().length === 0 || memory.content.length > 10_000) {
        throw new RangeError("Each memory must contain between 1 and 10,000 characters.");
      }
    }

    const response = await this.#http.request<AddContextResponse>({
      path: "v4/memories",
      method: "POST",
      body: {
        containerTag: input.containerTag,
        memories: input.memories.map((memory) => ({
          content: memory.content,
          ...(memory.isStatic === undefined ? {} : { isStatic: memory.isStatic }),
          ...(memory.metadata === undefined ? {} : { metadata: memory.metadata }),
        })),
      },
      ...(signal === undefined ? {} : { signal }),
    });
    return response.data;
  }

  async getProfile(input: ProfileInput, signal?: AbortSignal): Promise<ProfileResponse> {
    assertContainerTag(input.containerTag);
    const response = await this.#http.request<ProfileResponse>({
      path: "v4/profile",
      method: "POST",
      body: {
        containerTag: input.containerTag,
        ...(input.q === undefined ? {} : { q: input.q }),
        ...(input.threshold === undefined ? {} : { threshold: input.threshold }),
      },
      ...(signal === undefined ? {} : { signal }),
    });
    return response.data;
  }

  async search(input: SearchMemoryInput, signal?: AbortSignal): Promise<SearchMemoryResponse> {
    assertContainerTag(input.containerTag);
    if (input.q.trim().length === 0) throw new TypeError("Memory search query must not be empty.");

    const response = await this.#http.request<SearchMemoryResponse>({
      path: "v4/search",
      method: "POST",
      body: {
        q: input.q,
        containerTag: input.containerTag,
        searchMode: input.searchMode ?? "hybrid",
        limit: input.limit ?? 5,
        threshold: input.threshold ?? 0.6,
        ...(input.rerank === undefined ? {} : { rerank: input.rerank }),
      },
      ...(signal === undefined ? {} : { signal }),
    });
    return response.data;
  }

  /** Convenience method that keeps profile and semantic recall in one namespace. */
  async recallContext(input: SearchMemoryInput, signal?: AbortSignal): Promise<MemoryContext> {
    const [profile, search] = await Promise.all([
      this.getProfile({ containerTag: input.containerTag }, signal),
      this.search(input, signal),
    ]);
    return {
      static: profile.profile.static,
      dynamic: profile.profile.dynamic,
      relevant: search.results.flatMap((result) => {
        const value = result.memory ?? result.chunk;
        return value === undefined ? [] : [value];
      }),
    };
  }
}

export function assertContainerTag(containerTag: string): void {
  if (
    containerTag.length === 0
    || containerTag.length > 100
    || !CONTAINER_TAG_PATTERN.test(containerTag)
  ) {
    throw new TypeError(
      "containerTag must be 1-100 characters and contain only letters, numbers, underscores, colons, or hyphens.",
    );
  }
}
