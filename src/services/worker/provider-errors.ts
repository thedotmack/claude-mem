// F4 foundation: classified provider errors with extensible kind field.
export type ProviderErrorClass =
  | 'transient'
  | 'unrecoverable'
  | 'rate_limit'
  | 'quota_exhausted'
  | 'auth_invalid'
  | 'setup_required'
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
}

export class ClassifiedProviderError extends Error {
  readonly kind: ProviderErrorClass;
  readonly retryAfterMs?: number;
  readonly cause: unknown;
  readonly code?: string;
  readonly action?: string;
  readonly url?: string;
  readonly requestId?: string;

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
