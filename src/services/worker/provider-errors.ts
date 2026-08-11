// F4 foundation: classified provider errors with extensible kind field.
export type ProviderErrorClass =
  | 'transient'
  | 'unrecoverable'
  | 'rate_limit'
  | 'quota_exhausted'
  | 'auth_invalid'
  | 'setup_required'
  | (string & {}); // open union: providers may emit custom kinds

export class ClassifiedProviderError extends Error {
  readonly kind: ProviderErrorClass;
  readonly retryAfterMs?: number;
  readonly cause: unknown;

  constructor(message: string, opts: {
    kind: ProviderErrorClass;
    cause: unknown;
    retryAfterMs?: number;
  }) {
    super(message);
    this.name = 'ClassifiedProviderError';
    this.kind = opts.kind;
    this.cause = opts.cause;
    if (opts.retryAfterMs !== undefined) {
      this.retryAfterMs = opts.retryAfterMs;
    }
  }
}

export function isClassified(err: unknown): err is ClassifiedProviderError {
  return err instanceof ClassifiedProviderError;
}

// Message shapes that mean "the provider budget is spent", not "the code is
// broken". Kept deliberately narrow: context-overflow errors read "prompt is
// too long" / "context window" and must NOT match here.
const BUDGET_MESSAGE_PATTERNS: RegExp[] = [
  /\brate[\s_-]?limit/i,
  /\bquota\b/i,
  /\btoo many requests\b/i,
  /\brequest limit\b/i,
  /\bdaily\b[^.\n]*\blimit\b/i,
  /\blimit reached\b/i,
  /\binsufficient credits\b/i,
  /\b429\b/,
];

/**
 * True when an error is an expected budget exhaustion — a spent rate limit or
 * daily/request quota — rather than a bug. Recognizes both the classified
 * `rate_limit` / `quota_exhausted` kinds and raw errors whose message reads
 * like a request or daily limit (which is how a wrapped/patched worker bundle
 * surfaces its own cap without going through a provider classifier). Callers
 * use this to log the condition at warn level so it stays out of the
 * error-tracking sink.
 */
export function isExpectedBudgetError(err: unknown): boolean {
  if (isClassified(err) && (err.kind === 'rate_limit' || err.kind === 'quota_exhausted')) {
    return true;
  }
  const message = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  return message !== '' && BUDGET_MESSAGE_PATTERNS.some((re) => re.test(message));
}
