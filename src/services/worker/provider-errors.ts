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
