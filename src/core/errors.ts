import type { ProviderFailureShape } from "./types.js";

export class ProviderError extends Error {
  readonly provider: string;
  readonly providerMessage: string;
  readonly status: number | undefined;
  readonly code: string | undefined;
  readonly retryAfterSeconds: number | undefined;

  constructor(failure: ProviderFailureShape) {
    super(formatProviderFailure(failure));
    this.name = "ProviderError";
    this.provider = failure.provider;
    this.providerMessage = failure.message;
    this.status = failure.status;
    this.code = failure.code;
    this.retryAfterSeconds = failure.retryAfterSeconds;
  }

  toSafeObject(): ProviderFailureShape {
    return {
      provider: this.provider,
      message: this.providerMessage,
      ...(this.status === undefined ? {} : { status: this.status }),
      ...(this.code === undefined ? {} : { code: this.code }),
      ...(this.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: this.retryAfterSeconds }),
    };
  }
}

function formatProviderFailure(failure: ProviderFailureShape): string {
  const details = [
    ...(failure.status === undefined ? [] : [`HTTP ${failure.status}`]),
    ...(failure.code === undefined ? [] : [`code ${failure.code}`]),
    ...(failure.retryAfterSeconds === undefined ? [] : [`retry after ${failure.retryAfterSeconds}s`]),
  ];
  return details.length === 0 ? failure.message : `${failure.message} (${details.join("; ")})`;
}

export function safeErrorMessage(error: unknown): string {
  if (error instanceof ProviderError) return `${error.provider}: ${error.message}`;
  if (error instanceof Error) return error.message;
  return String(error);
}

const SECRET_PATTERNS = [
  /\bBearer\s+[^\s,;]+/giu,
  /\b(?:sk|xq|sm)_[A-Za-z0-9_-]{10,}\b/gu,
] as const;

/** Sanitize diagnostics produced outside ProviderHttp before terminal/log output. */
export function sanitizeDiagnostic(error: unknown, secrets: readonly string[] = []): string {
  let value = error instanceof Error ? error.message : String(error);
  for (const secret of secrets) {
    if (secret.length > 0) value = value.split(secret).join("[REDACTED]");
  }
  for (const pattern of SECRET_PATTERNS) value = value.replace(pattern, "[REDACTED]");
  value = value.replace(/[\r\n\t]+/gu, " ").trim();
  return value.length <= 500 ? value : `${value.slice(0, 497)}...`;
}
