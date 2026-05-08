// SPDX-License-Identifier: Apache-2.0

// Server-beta-local copy of the worker provider error classification model.
// Phase 5 anti-pattern guard: src/server/* must not import from
// src/services/worker/*, so we duplicate the small, stable error model here.
// Worker code keeps src/services/worker/provider-errors.ts unchanged.

export type ServerProviderErrorClass =
  | 'transient'
  | 'unrecoverable'
  | 'rate_limit'
  | 'quota_exhausted'
  | 'auth_invalid'
  | 'parse_error'
  | (string & {});

export class ServerClassifiedProviderError extends Error {
  readonly kind: ServerProviderErrorClass;
  readonly retryAfterMs?: number;
  readonly cause: unknown;

  constructor(
    message: string,
    opts: {
      kind: ServerProviderErrorClass;
      cause: unknown;
      retryAfterMs?: number;
    },
  ) {
    super(message);
    this.name = 'ServerClassifiedProviderError';
    this.kind = opts.kind;
    this.cause = opts.cause;
    if (opts.retryAfterMs !== undefined) {
      this.retryAfterMs = opts.retryAfterMs;
    }
  }
}

export function isServerClassified(err: unknown): err is ServerClassifiedProviderError {
  return err instanceof ServerClassifiedProviderError;
}

/**
 * Parse Retry-After header (seconds or HTTP-date). Returns ms or undefined.
 * Behavior intentionally mirrors the worker providers' helper so server
 * retries match worker retry policy.
 */
export function parseRetryAfterMs(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (!Number.isNaN(seconds) && seconds >= 0) {
    return Math.floor(seconds * 1000);
  }
  const dateMs = Date.parse(value);
  if (!Number.isNaN(dateMs)) {
    const delta = dateMs - Date.now();
    return delta > 0 ? delta : 0;
  }
  return undefined;
}

interface ClassifyHttpInput {
  status?: number;
  bodyText?: string;
  headers?: Headers | { get(name: string): string | null };
  cause: unknown;
  providerLabel: string;
}

/**
 * Generic HTTP-error → ServerClassifiedProviderError mapping shared by
 * Gemini and OpenRouter server adapters. Provider-specific overrides (e.g.
 * Anthropic OverloadedError, Gemini quota body markers) are layered on top
 * by the per-provider classifier wrappers in this module.
 */
export function classifyHttpProviderError(input: ClassifyHttpInput): ServerClassifiedProviderError {
  const { status, providerLabel } = input;
  const body = input.bodyText ?? '';
  const lower = body.toLowerCase();
  const retryAfterMs = input.headers ? parseRetryAfterMs(input.headers.get('retry-after')) : undefined;

  if (
    lower.includes('quota exceeded') ||
    lower.includes('insufficient credits') ||
    lower.includes('insufficient_quota') ||
    lower.includes('resource_exhausted')
  ) {
    return new ServerClassifiedProviderError(
      `${providerLabel} quota exhausted${status !== undefined ? ` (status ${status})` : ''}`,
      { kind: 'quota_exhausted', cause: input.cause },
    );
  }

  if (status === 429) {
    return new ServerClassifiedProviderError(`${providerLabel} rate limit (429)`, {
      kind: 'rate_limit',
      cause: input.cause,
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    });
  }

  if (status === 401 || status === 403) {
    return new ServerClassifiedProviderError(`${providerLabel} auth error (status ${status})`, {
      kind: 'auth_invalid',
      cause: input.cause,
    });
  }

  if (status === 400 || status === 404) {
    return new ServerClassifiedProviderError(`${providerLabel} bad request (status ${status})`, {
      kind: 'unrecoverable',
      cause: input.cause,
    });
  }

  if (status !== undefined && status >= 500 && status < 600) {
    return new ServerClassifiedProviderError(`${providerLabel} upstream error (status ${status})`, {
      kind: 'transient',
      cause: input.cause,
    });
  }

  if (status === undefined) {
    const message = input.cause instanceof Error ? input.cause.message : String(input.cause);
    return new ServerClassifiedProviderError(`${providerLabel} network error: ${message}`, {
      kind: 'transient',
      cause: input.cause,
    });
  }

  return new ServerClassifiedProviderError(
    `${providerLabel} API error: ${status}${body ? ` - ${body.substring(0, 200)}` : ''}`,
    { kind: 'unrecoverable', cause: input.cause },
  );
}
