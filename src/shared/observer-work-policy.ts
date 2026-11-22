/** Live observer inputs are disposable, not a durable job queue. */
export const LIVE_OBSERVER_MAX_AGE_MS = 5 * 60_000;
export const LIVE_OBSERVER_MAX_SESSION_MESSAGES = 128;
export const LIVE_OBSERVER_MAX_TOTAL_MESSAGES = 1_024;

/**
 * Settings key that overrides how long an unclaimed live input may wait.
 *
 * The buffer's message caps still bound it, so a longer TTL cannot make it
 * grow; the TTL only decides how long a real backlog gets to drain before its
 * oldest inputs are discarded (#6391).
 */
export const LIVE_OBSERVER_MAX_AGE_SETTING = 'CLAUDE_MEM_LIVE_OBSERVER_MAX_AGE_MS';
export const LIVE_OBSERVER_MAX_AGE_MIN_MS = 60_000;
export const LIVE_OBSERVER_MAX_AGE_MAX_MS = 60 * 60_000;

/**
 * Coerce a configured TTL to a usable value. Anything unparsable keeps the
 * shipped default, and a value outside the bounds is clamped rather than
 * rejected: a typo must not turn expiry off or make every input expire at once.
 */
export function resolveLiveObserverMaxAgeMs(raw: string | number | null | undefined): number {
  const parsed = typeof raw === 'number' ? raw : Number.parseInt(String(raw ?? '').trim(), 10);
  if (!Number.isFinite(parsed)) {
    return LIVE_OBSERVER_MAX_AGE_MS;
  }
  return Math.min(Math.max(Math.trunc(parsed), LIVE_OBSERVER_MAX_AGE_MIN_MS), LIVE_OBSERVER_MAX_AGE_MAX_MS);
}

export function isLiveObserverEvent(kind: string): kind is 'observation' | 'file_edit' | 'summarize' {
  return kind === 'observation' || kind === 'file_edit' || kind === 'summarize';
}

export function isExpiredObserverEvent(capturedAt: number, now = Date.now()): boolean {
  return !Number.isFinite(capturedAt) || now - capturedAt >= LIVE_OBSERVER_MAX_AGE_MS;
}
