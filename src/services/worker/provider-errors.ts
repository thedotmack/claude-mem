// F4 foundation: classified provider errors with extensible kind field.
export type ProviderErrorClass =
  | 'transient'
  | 'unrecoverable'
  | 'rate_limit'
  | 'quota_exhausted'
  | 'auth_invalid'
  | 'setup_required'
  // The request did not fit the model's context window. Retiring the
  // conversation fixes it, so the observer recycles instead of finalizing.
  | 'context_overflow'
  | (string & {}); // open union: providers may emit custom kinds

/**
 * Code on the `transient` error withRetry throws when a request outlives its
 * per-attempt deadline (CLAUDE_MEM_LLM_TIMEOUT_MS). The request was abandoned by
 * us, not failed by the backend — which may still have completed and billed it —
 * so it is kept countable apart from network faults: as the
 * `transport:deadline_exceeded` abort reason, the `deadline_exceeded` telemetry
 * abort_reason, and the observer-health ledger's lastErrorCode (observer-health
 * compares the same string as a literal, to stay free of worker imports).
 */
export const DEADLINE_EXCEEDED_CODE = 'deadline_exceeded';

/**
 * `code` on a Codex request that was never sent because the Codex breaker or
 * the codex_cli setup gate is armed. It repeats a failure another request
 * already booked, so nothing books it again: not the breaker (re-arming would
 * end the probe that clears it), not the setup gate, not observer-health.
 */
export const CODEX_COOLDOWN_REFUSAL_CODE = 'codex_cooldown_active';

/**
 * What one paid send ended as, for the "never pay twice" rule (xAI SDK retry
 * rules; retry.ts decides from it):
 *  - `refused_before_work`: the backend said no before doing anything (a 429,
 *    a pre-send refusal). Nothing was billed; retrying in place is safe.
 *  - `ambiguous`: no answer arrived (network error before any response, our
 *    own deadline) or a 5xx on a non-streamed POST. The work may have run and
 *    been billed. Never retried in place; the session's transport pause
 *    decides, against the batch's PaidSendBudget.
 *  - `output_failure`: a response arrived and then its body could not be read
 *    or parsed, or a 200 carried an embedded error (litellm's "Unable to get
 *    json response"). The work ran and was billed. Never resent.
 *  - `rejected`: the backend answered with a definite refusal (auth, quota, bad
 *    request). Nothing to resend.
 * Unset on an error means it is derived from `kind` (paidSendOutcomeOf).
 */
export type PaidSendOutcome = 'refused_before_work' | 'ambiguous' | 'output_failure' | 'rejected';

/**
 * `kind` (and `code`) of the refusal withRetry throws instead of sending when
 * the claimed batch has spent its PaidSendBudget. Never sent, so never billed.
 */
export const PAID_SEND_BUDGET_EXHAUSTED_CODE = 'paid_send_budget_exhausted';

export { MAX_ERROR_BODY_BYTES, readCappedErrorBody } from '../../shared/capped-error-body.js';

/**
 * Optional structured detail carried alongside a classified error. Populated
 * when the upstream (e.g. the cmem.ai gateway) returns a taxonomy envelope
 * `{ code, message, action, url, request_id }`; the worker carries these
 * verbatim so the log line and the session-start warning show the same words.
 */
export interface ProviderErrorDetail {
  code?: string;
  action?: string;
  url?: string;
  requestId?: string;
  /**
   * The resolved executable path a spawn failure could not launch. Carried so
   * the setup-recheck gate can tell "the same unspawnable binary" apart from
   * "configuration repaired" without re-running a doomed query.
   */
  executablePath?: string;
  /**
   * The per-batch id sent as `x-client-request-id` (tracing only, never
   * server-side idempotency), so a log line or a provider support ticket can
   * name every send of one batch.
   */
  clientAttemptId?: string;
  /** Overrides the outcome derived from `kind`; see PaidSendOutcome. */
  paidSendOutcome?: PaidSendOutcome;
  /**
   * A streamed request failed in transport (network error, idle timeout, a
   * stream that ended early) before the model produced any output. withRetry's
   * `retryBeforeOutput` may resend such a failure once, against the batch's
   * PaidSendBudget (xAI SDK retryBeforeOutput).
   */
  failedBeforeOutput?: boolean;
}

export class ClassifiedProviderError extends Error {
  readonly kind: ProviderErrorClass;
  readonly retryAfterMs?: number;
  readonly cause: unknown;
  readonly code?: string;
  readonly action?: string;
  readonly url?: string;
  readonly requestId?: string;
  readonly executablePath?: string;
  /** Set by the provider, or by withRetry for the batch it sent; see ProviderErrorDetail. */
  clientAttemptId?: string;
  readonly paidSendOutcome?: PaidSendOutcome;
  /** Set by the streaming request path; see ProviderErrorDetail.failedBeforeOutput. */
  failedBeforeOutput?: boolean;

  constructor(message: string, opts: {
    kind: ProviderErrorClass;
    cause: unknown;
    retryAfterMs?: number;
  } & ProviderErrorDetail) {
    super(message);
    this.name = 'ClassifiedProviderError';
    this.kind = opts.kind;
    this.cause = opts.cause;
    if (opts.retryAfterMs !== undefined) {
      this.retryAfterMs = opts.retryAfterMs;
    }
    if (opts.code !== undefined) {
      this.code = opts.code;
    }
    if (opts.action !== undefined) {
      this.action = opts.action;
    }
    if (opts.url !== undefined) {
      this.url = opts.url;
    }
    if (opts.requestId !== undefined) {
      this.requestId = opts.requestId;
    }
    if (opts.executablePath !== undefined) {
      this.executablePath = opts.executablePath;
    }
    if (opts.clientAttemptId !== undefined) {
      this.clientAttemptId = opts.clientAttemptId;
    }
    if (opts.paidSendOutcome !== undefined) {
      this.paidSendOutcome = opts.paidSendOutcome;
    }
    if (opts.failedBeforeOutput !== undefined) {
      this.failedBeforeOutput = opts.failedBeforeOutput;
    }
  }
}

/**
 * What a key pool reports when its last key is spent or refused while another
 * key frees within a rate-limit window (api-key-pool's withKeyPool): a rate
 * limit lasting until that key is back. As the spent key's own error it would
 * hold the whole provider for that key's window (the quota breaker arms for 30
 * minutes) although the pool can serve again in seconds. Keeps the spent
 * key's words.
 */
export function rateLimitUntilNextKey(retryAfterMs: number, lastError: unknown): ClassifiedProviderError {
  const words = lastError instanceof Error ? lastError.message : String(lastError);
  return new ClassifiedProviderError(
    `${words}; another key in the pool frees in ${Math.ceil(retryAfterMs / 1000)}s`,
    { kind: 'rate_limit', retryAfterMs, cause: lastError },
  );
}

export function isClassified(err: unknown): err is ClassifiedProviderError {
  return err instanceof ClassifiedProviderError;
}

/**
 * What a failed send ended as (see PaidSendOutcome). An explicit outcome wins;
 * otherwise a rate limit was refused before work, a transient fault (network,
 * 5xx, deadline) is ambiguous, and every other classified kind is a definite
 * refusal. An unclassified error is ambiguous: nothing says the work did not run.
 */
export function paidSendOutcomeOf(err: unknown): PaidSendOutcome {
  if (!isClassified(err)) return 'ambiguous';
  if (err.paidSendOutcome) return err.paidSendOutcome;
  if (err.kind === 'rate_limit') return 'refused_before_work';
  if (err.kind === 'transient') return 'ambiguous';
  return 'rejected';
}

/**
 * The one rendering of a classified error for humans: message, then the
 * action, link, and request id when present. This is the single renderer for
 * the worker's `Observer failed` log line; the observer-health ledger stores
 * the fields structurally and renders them itself at session start.
 */
export function describeProviderError(err: ClassifiedProviderError): string {
  return `${err.message}${err.action ? ' — ' + err.action : ''}${err.url ? ' ' + err.url : ''}${err.requestId ? ` (req ${err.requestId})` : ''}${err.clientAttemptId ? ` (client attempt ${err.clientAttemptId})` : ''}`;
}
