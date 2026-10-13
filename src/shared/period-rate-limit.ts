/**
 * A 429 that names a limit of a day or longer ("Rate limit exceeded:
 * free-models-per-day"). That is a spent allowance until the period turns
 * over, not a throttle. Read as a rate limit it is retried in place, held for
 * only the short throttle window (quota-cooldown's
 * RATE_LIMIT_RECHECK_COOLDOWN_MS), and re-sent every ninety seconds until the
 * reset, every request doomed. Per-minute limits ("free-models-per-min") stay
 * rate limits.
 *
 * Shared by the worker's and the server runtime's classifiers, which may not
 * import from each other, so the two never disagree about a daily cap.
 * Callers pass the lower-cased body and apply it on the 429 path only.
 */
const PERIOD_RATE_LIMIT = /limit exceeded:\s*[\w-]*per-(day|week|month)\b/;

export function namesPeriodRateLimit(lowerBody: string): boolean {
  return PERIOD_RATE_LIMIT.test(lowerBody);
}
