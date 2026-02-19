/**
 * Calculates exponential backoff delay capped at a maximum value.
 *
 * @param attempt  Zero-based retry attempt number
 * @param base     Base delay in ms (used on attempt 0)
 * @param max      Maximum delay cap in ms
 * @param factor   Multiplier applied per attempt (typically 2)
 * @returns Delay in ms: min(base * factor^attempt, max)
 */
export function calculateBackoffDelay(
  attempt: number,
  base: number,
  max: number,
  factor: number,
): number {
  return Math.min(base * Math.pow(factor, attempt), max);
}
