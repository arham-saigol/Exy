import { ProviderError } from "../core/errors.js";
import { ProviderHttp, type FetchLike } from "./http.js";

const DEFAULT_BASE_URL = "https://api.exa.ai";

export interface ExaClientOptions {
  fetch?: FetchLike;
  baseUrl?: string;
}

export type ExaSearchType = "instant" | "fast" | "auto" | "deep-lite" | "deep" | "deep-reasoning";

export interface ExaTextOptions {
  maxCharacters?: number;
  includeHtmlTags?: boolean;
}

export interface ExaHighlightsOptions {
  query?: string;
  maxCharacters?: number;
  numSentences?: number;
  highlightsPerUrl?: number;
}

export interface ExaContentsOptions {
  text?: boolean | ExaTextOptions;
  highlights?: boolean | ExaHighlightsOptions;
  summary?: boolean | { query?: string };
}

export interface ExaSearchInput {
  query: string;
  type?: ExaSearchType;
  numResults?: number;
  includeDomains?: readonly string[];
  excludeDomains?: readonly string[];
  startPublishedDate?: string;
  endPublishedDate?: string;
  category?: string;
  moderation?: boolean;
  contents?: ExaContentsOptions;
}

export interface ExaResult {
  id: string;
  url: string;
  title?: string;
  publishedDate?: string;
  author?: string;
  image?: string;
  favicon?: string;
  text?: string;
  highlights?: string[];
  highlightScores?: number[];
  summary?: string;
}

export interface ExaSearchResponse {
  requestId: string;
  results: ExaResult[];
  costDollars?: unknown;
  output?: unknown;
}

export interface GetContentsInput {
  urls: readonly string[];
  text?: boolean | ExaTextOptions;
  highlights?: boolean | ExaHighlightsOptions;
  summary?: boolean | { query?: string };
  maxAgeHours?: number;
}

export interface ExaContentError {
  tag?: string;
  httpStatusCode?: number;
}

export interface ExaContentStatus {
  id: string;
  status: "success" | "error";
  source?: string;
  error?: ExaContentError;
}

export interface ExaContentsResponse {
  requestId: string;
  results: ExaResult[];
  statuses: ExaContentStatus[];
  costDollars?: unknown;
}

export interface FetchPageInput {
  url: string;
  maxAgeHours?: number;
  text?: boolean | ExaTextOptions;
}

export class ExaClient {
  readonly #http: ProviderHttp;

  constructor(apiKey: string, options: ExaClientOptions = {}) {
    this.#http = new ProviderHttp({
      provider: "exa",
      baseUrl: options.baseUrl ?? DEFAULT_BASE_URL,
      headers: { "x-api-key": apiKey },
      secrets: [apiKey],
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    });
  }

  /**
   * Exa has no documented free core-auth probe. This performs one minimal fast
   * search and can therefore consume usage; doctor/setup should disclose that.
   */
  async checkCredentials(): Promise<{ ok: true }> {
    await this.search({ query: "Exa API connectivity check", type: "fast", numResults: 1 });
    return { ok: true };
  }

  async search(input: ExaSearchInput, signal?: AbortSignal): Promise<ExaSearchResponse> {
    if (input.query.trim().length === 0) throw new TypeError("Web search query must not be empty.");
    if (
      input.numResults !== undefined
      && (!Number.isInteger(input.numResults) || input.numResults < 1 || input.numResults > 100)
    ) {
      throw new RangeError("Exa numResults must be between 1 and 100.");
    }
    if ((input.includeDomains?.length ?? 0) > 1_200 || (input.excludeDomains?.length ?? 0) > 1_200) {
      throw new RangeError("Exa accepts at most 1,200 included or excluded domains.");
    }

    const response = await this.#http.request<ExaSearchResponse>({
      path: "search",
      method: "POST",
      body: {
        query: input.query,
        type: input.type ?? "auto",
        numResults: input.numResults ?? 10,
        ...(input.includeDomains === undefined ? {} : { includeDomains: input.includeDomains }),
        ...(input.excludeDomains === undefined ? {} : { excludeDomains: input.excludeDomains }),
        ...(input.startPublishedDate === undefined ? {} : { startPublishedDate: input.startPublishedDate }),
        ...(input.endPublishedDate === undefined ? {} : { endPublishedDate: input.endPublishedDate }),
        ...(input.category === undefined ? {} : { category: input.category }),
        ...(input.moderation === undefined ? {} : { moderation: input.moderation }),
        ...(input.contents === undefined ? {} : { contents: input.contents }),
      },
      ...(signal === undefined ? {} : { signal }),
    });
    return response.data;
  }

  async getContents(input: GetContentsInput, signal?: AbortSignal): Promise<ExaContentsResponse> {
    if (input.urls.length === 0 || input.urls.length > 100) {
      throw new RangeError("Exa contents accepts between 1 and 100 URLs.");
    }
    for (const url of input.urls) {
      if (url.length === 0 || url.length > 2_048) throw new RangeError("Exa content URLs must be 1-2,048 characters.");
    }
    if (
      input.maxAgeHours !== undefined
      && input.maxAgeHours !== -1
      && input.maxAgeHours !== 0
      && (input.maxAgeHours < 1 || input.maxAgeHours > 720)
    ) {
      throw new RangeError("maxAgeHours must be -1, 0, or between 1 and 720.");
    }

    const response = await this.#http.request<ExaContentsResponse>({
      path: "contents",
      method: "POST",
      body: {
        urls: input.urls,
        text: input.text ?? true,
        ...(input.highlights === undefined ? {} : { highlights: input.highlights }),
        ...(input.summary === undefined ? {} : { summary: input.summary }),
        ...(input.maxAgeHours === undefined ? {} : { maxAgeHours: input.maxAgeHours }),
      },
      ...(signal === undefined ? {} : { signal }),
    });
    return response.data;
  }

  /** Requires both HTTP success and Exa's per-URL success status. */
  async fetchPage(input: FetchPageInput, signal?: AbortSignal): Promise<ExaResult> {
    const response = await this.getContents({
      urls: [input.url],
      text: input.text ?? true,
      ...(input.maxAgeHours === undefined ? {} : { maxAgeHours: input.maxAgeHours }),
    }, signal);
    const status = response.statuses[0];
    if (status === undefined || status.status !== "success") {
      const code = safeExaTag(status?.error?.tag) ?? "content_fetch_failed";
      throw new ProviderError({
        provider: "exa",
        ...(status?.error?.httpStatusCode === undefined ? {} : { status: status.error.httpStatusCode }),
        code,
        message: `Exa could not fetch the requested page (${code}).`,
      });
    }

    const result = response.results.find((candidate) => candidate.url === input.url) ?? response.results[0];
    if (result === undefined) {
      throw new ProviderError({
        provider: "exa",
        code: "content_missing",
        message: "Exa marked the page fetch successful but returned no page content.",
      });
    }
    return result;
  }
}

function safeExaTag(tag: string | undefined): string | undefined {
  return tag !== undefined && /^[A-Z0-9_]{1,80}$/.test(tag) ? tag : undefined;
}
