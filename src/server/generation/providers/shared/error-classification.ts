// SPDX-License-Identifier: Apache-2.0

// Server-beta-local copy of the worker provider error classification model.
// Phase 5 anti-pattern guard: src/server/* must not import from
// src/services/worker/*, so we duplicate the small, stable error model here.
// Worker code keeps src/services/worker/provider-errors.ts unchanged.

import { namesPeriodRateLimit } from '../../../../shared/period-rate-limit.js';

export type ServerProviderErrorClass =
  | 'transient'
  | 'unrecoverable'
  | 'rate_limit'
  | 'quota_exhausted'
  | 'auth_invalid'
  | 'parse_error'
  | (string & {});

/**
 * What one paid generate call ended as — the worker's "never pay twice" model
 * (src/services/worker/provider-errors.ts PaidSendOutcome), duplicated here
 * because src/server may not import from the worker:
 *  - `refused_before_work`: a 429; nothing was billed.
 *  - `ambiguous`: no answer (network error, our own timeout) or a 5xx. The
 *    work may have run and been billed.
 *  - `output_failure`: a response arrived and its body could not be used
 *    (litellm's 200 "Unable to get json response"). Billed; never resent.
 *  - `rejected`: a definite refusal (auth, quota, bad request).
 */
export type ServerPaidSendOutcome = 'refused_before_work' | 'ambiguous' | 'output_failure' | 'rejected';

/**
 * Paid generate calls one outbox job may make before an ambiguous failure is
 * no longer retried: the first call plus one resend (the worker's
 * DEFAULT_MAX_PAID_SENDS_PER_BATCH). A rate limit is not a paid call and keeps
 * the job's full max_attempts.
 */
export const SERVER_MAX_PAID_SENDS_PER_JOB = 2;

export class ServerClassifiedProviderError extends Error {
  readonly kind: ServerProviderErrorClass;
  readonly retryAfterMs?: number;
  readonly cause: unknown;
  readonly paidSendOutcome?: ServerPaidSendOutcome;

  constructor(
    message: string,
    opts: {
      kind: ServerProviderErrorClass;
      cause: unknown;
      retryAfterMs?: number;
      /** Overrides the outcome derived from `kind` (serverPaidSendOutcomeOf). */
      paidSendOutcome?: ServerPaidSendOutcome;
    },
  ) {
    super(message);
    this.name = 'ServerClassifiedProviderError';
    this.kind = opts.kind;
    this.cause = opts.cause;
    if (opts.retryAfterMs !== undefined) {
      this.retryAfterMs = opts.retryAfterMs;
    }
    if (opts.paidSendOutcome !== undefined) {
      this.paidSendOutcome = opts.paidSendOutcome;
    }
  }
}

/** An explicit outcome wins; else rate_limit was refused before work, transient is ambiguous, the rest rejected. */
export function serverPaidSendOutcomeOf(error: ServerClassifiedProviderError): ServerPaidSendOutcome {
  if (error.paidSendOutcome) return error.paidSendOutcome;
  if (error.kind === 'rate_limit') return 'refused_before_work';
  if (error.kind === 'transient') return 'ambiguous';
  return 'rejected';
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
  const cause = status === undefined
    ? input.cause
    : new Error(`${providerLabel} HTTP error (status ${status})`);

  if (
    lower.includes('quota exceeded') ||
    lower.includes('insufficient credits') ||
    lower.includes('insufficient_quota') ||
    // `RESOURCE_EXHAUSTED` is Gemini's status string for *every* 429, whatever
    // it is actually refusing, so it cannot decide on the 429 path — the same
    // reason the generic `limit exceeded` marker below is guarded. A 429 that
    // really is a spent allowance is decided by the Gemini wrapper, which reads
    // the window the `QuotaFailure` names, before it reaches here.
    (lower.includes('resource_exhausted') && status !== 429) ||
    lower.includes('key limit exceeded') ||
    // "Rate limit exceeded" on a 429 is a rate limit, not quota — the generic
    // marker only applies off the 429 path (the key-limit marker always wins).
    (lower.includes('limit exceeded') && status !== 429) ||
    // A daily cap is a spent allowance, read by the worker's rule: retrying
    // the job only spends attempts until the period turns over.
    (status === 429 && namesPeriodRateLimit(lower)) ||
    lower.includes('negative credit') ||
    status === 402
  ) {
    return new ServerClassifiedProviderError(
      `${providerLabel} quota exhausted${status !== undefined ? ` (status ${status})` : ''}`,
      { kind: 'quota_exhausted', cause },
    );
  }

  if (status === 429) {
    return new ServerClassifiedProviderError(`${providerLabel} rate limit (429)`, {
      kind: 'rate_limit',
      cause,
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    });
  }

  if (status === 401 || status === 403) {
    return new ServerClassifiedProviderError(`${providerLabel} auth error (status ${status})`, {
      kind: 'auth_invalid',
      cause,
    });
  }

  if (status === 400 || status === 404) {
    return new ServerClassifiedProviderError(`${providerLabel} bad request (status ${status})`, {
      kind: 'unrecoverable',
      cause,
    });
  }

  if (status !== undefined && status >= 500 && status < 600) {
    return new ServerClassifiedProviderError(`${providerLabel} upstream error (status ${status})`, {
      kind: 'transient',
      cause,
    });
  }

  if (status === undefined) {
    const message = input.cause instanceof Error ? input.cause.message : String(input.cause);
    return new ServerClassifiedProviderError(`${providerLabel} network error: ${message}`, {
      kind: 'transient',
      cause: input.cause,
    });
  }

  // litellm (behind OpenRouter) can fail to parse the downstream model's
  // response and surface it as a body-level error inside a 200 envelope, e.g.
  // `{ error: { code: 200, message: "Unable to get json response - Expecting
  // value: line 45 column 1" } }`. The model ran and the call was billed; only
  // its output was lost, so a retry pays for the same work again. An output
  // failure, never retried ("never pay twice"). Kept marker-scoped so it keeps
  // its own words: this classifier is shared with Gemini, whose other 200
  // envelopes (FAILED_PRECONDITION, etc.) fall through to unrecoverable below.
  if (lower.includes('unable to get json') || lower.includes('expecting value')) {
    return new ServerClassifiedProviderError(
      `${providerLabel} upstream output failure (status ${status})`,
      { kind: 'unrecoverable', paidSendOutcome: 'output_failure', cause },
    );
  }

  return new ServerClassifiedProviderError(
    `${providerLabel} API error (status ${status})`,
    { kind: 'unrecoverable', cause },
  );
}
