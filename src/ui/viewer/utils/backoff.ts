/**
 * Calculates exponential backoff delay capped at a maximum value.
 *
 * @param attempt  Zero-based retry attempt number
 * @param base     Base delay in ms (used on attempt 0)
 * @param max      Maximum delay cap in ms
 * @param factor   Multiplier applied per attempt (typically 2)
 * @param jitter   Fraction of delay to add as random jitter (0 = none, 0.25 = up to 25%)
 * @returns Delay in ms: min(base * factor^attempt, max) + random jitter
 */
export function calculateBackoffDelay(
  attempt: number,
  base: number,
  max: number,
  factor: number,
  jitter = 0,
): number {
  const delay = Math.min(base * Math.pow(factor, attempt), max);
  if (jitter <= 0) return delay;
  return delay + Math.random() * delay * jitter;
}
