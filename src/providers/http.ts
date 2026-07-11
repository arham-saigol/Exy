import { ProviderError } from "../core/errors.js";

export type FetchLike = typeof fetch;

export type QueryValue = string | number | boolean | null | undefined;

export interface ProviderHttpOptions {
  provider: string;
  baseUrl: string;
  headers?: Readonly<Record<string, string>>;
  secrets?: readonly string[];
  fetch?: FetchLike;
}

export interface ProviderRequest {
  path: string;
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  query?: Readonly<Record<string, QueryValue>>;
  headers?: Readonly<Record<string, string>>;
  body?: unknown;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface ProviderResponse<T> {
  status: number;
  headers: Headers;
  data: T;
}

const GENERIC_SECRET_PATTERNS = [
  /\bBearer\s+[^\s,;]+/gi,
  /\b(?:sk|xq)_[A-Za-z0-9_-]{12,}\b/g,
] as const;

/**
 * Minimal JSON HTTP transport for provider adapters.
 *
 * Request headers and raw response bodies are deliberately never attached to
 * thrown errors. Provider errors only contain an allow-listed status, code,
 * short message, and retry delay.
 */
export class ProviderHttp {
  readonly #provider: string;
  readonly #baseUrl: URL;
  readonly #headers: Readonly<Record<string, string>>;
  readonly #secrets: readonly string[];
  readonly #fetch: FetchLike;

  constructor(options: ProviderHttpOptions) {
    this.#provider = options.provider;
    this.#baseUrl = new URL(ensureTrailingSlash(options.baseUrl));
    this.#headers = options.headers ?? {};
    this.#secrets = (options.secrets ?? []).filter((secret) => secret.length > 0);
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  async request<T>(request: ProviderRequest): Promise<ProviderResponse<T>> {
    const url = new URL(request.path.replace(/^\/+/, ""), this.#baseUrl);
    for (const [key, value] of Object.entries(request.query ?? {})) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }

    const headers: Record<string, string> = {
      Accept: "application/json",
      ...this.#headers,
      ...request.headers,
    };
    let body: string | undefined;
    if (request.body !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(request.body);
    }

    let response: Response;
    try {
      const timeout = AbortSignal.timeout(request.timeoutMs ?? 30_000);
      const signal = request.signal === undefined ? timeout : AbortSignal.any([request.signal, timeout]);
      response = await this.#fetch(url, {
        method: request.method ?? "GET",
        headers,
        signal,
        ...(body === undefined ? {} : { body }),
      });
    } catch (error) {
      const aborted = error instanceof Error && error.name === "AbortError";
      throw new ProviderError({
        provider: this.#provider,
        code: aborted ? "request_aborted" : "network_error",
        message: aborted
          ? "The provider request was interrupted."
          : "The provider request failed before a response was received.",
      });
    }

    let text: string;
    try {
      text = await response.text();
    } catch {
      throw new ProviderError({
        provider: this.#provider,
        status: response.status,
        code: "response_read_error",
        message: "The provider response could not be read.",
      });
    }
    const parsed = parseResponseBody(text);
    if (!response.ok) {
      throw this.#toProviderError(response, parsed);
    }

    if (text.length > 0 && parsed === undefined) {
      throw new ProviderError({
        provider: this.#provider,
        status: response.status,
        code: "invalid_response",
        message: "The provider returned a response that was not valid JSON.",
      });
    }

    return {
      status: response.status,
      headers: response.headers,
      data: parsed as T,
    };
  }

  #toProviderError(response: Response, body: unknown): ProviderError {
    const record = asRecord(body);
    const nestedError = asRecord(record?.error);
    const rawCode = firstString(
      record?.code,
      record?.tag,
      record?.type,
      nestedError?.code,
      nestedError?.tag,
      codeLike(record?.error),
    );
    const rawMessage = firstString(
      record?.message,
      nestedError?.message,
      typeof record?.error === "string" ? record.error : undefined,
    );
    const retryAfterSeconds = parseRetryAfter(response.headers.get("retry-after"), record?.retryAfter);

    return new ProviderError({
      provider: this.#provider,
      status: response.status,
      ...(rawCode === undefined ? {} : { code: sanitize(rawCode, this.#secrets, 120) }),
      message: sanitize(
        rawMessage ?? `The provider returned HTTP ${response.status}.`,
        this.#secrets,
        500,
      ),
      ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
    });
  }
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function parseResponseBody(text: string): unknown {
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string" && value.length > 0);
}

function codeLike(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z][A-Za-z0-9_-]{0,119}$/.test(value) ? value : undefined;
}

function sanitize(value: string, secrets: readonly string[], maxLength: number): string {
  let sanitized = value.replace(/[\r\n\t]+/g, " ");
  for (const secret of secrets) sanitized = sanitized.split(secret).join("[REDACTED]");
  for (const pattern of GENERIC_SECRET_PATTERNS) sanitized = sanitized.replace(pattern, "[REDACTED]");
  sanitized = sanitized.trim();
  return sanitized.length <= maxLength ? sanitized : `${sanitized.slice(0, maxLength - 3)}...`;
}

function parseRetryAfter(header: string | null, bodyValue: unknown): number | undefined {
  if (header !== null) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds;

    const date = Date.parse(header);
    if (!Number.isNaN(date)) return Math.max(0, Math.ceil((date - Date.now()) / 1_000));
  }

  if (typeof bodyValue === "number" && Number.isFinite(bodyValue) && bodyValue >= 0) {
    return bodyValue;
  }
  return undefined;
}
