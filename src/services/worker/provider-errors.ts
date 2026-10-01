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
  }
}

export function isClassified(err: unknown): err is ClassifiedProviderError {
  return err instanceof ClassifiedProviderError;
}

/**
 * The one rendering of a classified error for humans: message, then the
 * action, link, and request id when present. This is the single renderer for
 * the worker's `Observer failed` log line; the observer-health ledger stores
 * the fields structurally and renders them itself at session start.
 */
export function describeProviderError(err: ClassifiedProviderError): string {
  return `${err.message}${err.action ? ' — ' + err.action : ''}${err.url ? ' ' + err.url : ''}${err.requestId ? ` (req ${err.requestId})` : ''}`;
}
