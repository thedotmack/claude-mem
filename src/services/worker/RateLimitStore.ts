/**
 * Rate limit store — captures `rate_limit` system events emitted by
 * `@anthropic-ai/claude-agent-sdk`'s `query()` stream.
 *
 * The SDK reports the live Claude subscription quota state as `system` events
 * with subtype `rate_limit`. The payload includes the (currently undocumented)
 * `rate_limit_info` shape:
 *
 *   {
 *     status: "allowed" | "allowed_warning" | "rejected",
 *     resetsAt?: number,                              // epoch ms
 *     rateLimitType?: "five_hour" | "seven_day"
 *                   | "seven_day_opus" | "seven_day_sonnet"
 *                   | "overage",
 *     utilization?: number,                           // 0..1
 *     overageStatus?: "allowed" | "allowed_warning" | "rejected",
 *     overageResetsAt?: number,
 *     isUsingOverage?: boolean,
 *     surpassedThreshold?: number,
 *   }
 *
 * Pattern adapted from meridian's proxy/rateLimitStore.ts (last-write-wins
 * per `rateLimitType` bucket, in-memory only). State resets on worker
 * restart — that's fine, the SDK pushes a fresh event on the next request.
 *
 * Quota-aware abort logic gates the worker from continuing to consume a
 * subscription bucket once it crosses a per-window threshold. API-key
 * users are exempt because they authorized per-call spend.
 */

export type RateLimitWindow =
  | 'five_hour'
  | 'seven_day'
  | 'seven_day_opus'
  | 'seven_day_sonnet'
  | 'overage';

export interface RateLimitInfo {
  status?: 'allowed' | 'allowed_warning' | 'rejected';
  resetsAt?: number;
  rateLimitType?: RateLimitWindow;
  utilization?: number;
  overageStatus?: 'allowed' | 'allowed_warning' | 'rejected';
  overageResetsAt?: number;
  isUsingOverage?: boolean;
  surpassedThreshold?: number;
}

export interface RateLimitEntry extends RateLimitInfo {
  observedAt: number;
}

export type RateLimitBucketKey = RateLimitWindow | 'default';

export class RateLimitStore {
  private entries = new Map<RateLimitBucketKey, RateLimitEntry>();

  /**
   * Record a rate-limit info snapshot. Last-write-wins per bucket key.
   * Accepts both the literal `rate_limit_info` payload and a wrapping object;
   * callers should pass the inner info.
   */
  set(info: RateLimitInfo | undefined | null): void {
    if (!info || typeof info !== 'object') return;
    const key: RateLimitBucketKey = info.rateLimitType ?? 'default';
    this.entries.set(key, { ...info, observedAt: Date.now() });
  }

  /** Snapshot a single bucket, or undefined if not yet seen. */
  get(type: RateLimitWindow | undefined): RateLimitEntry | undefined {
    if (!type) return this.entries.get('default');
    return this.entries.get(type);
  }

  /** All current entries, newest-first by observedAt. */
  getAll(): RateLimitEntry[] {
    return Array.from(this.entries.values()).sort(
      (a, b) => b.observedAt - a.observedAt,
    );
  }

  /** Latest snapshot per "interesting" window for health surface. */
  getMostRecentByWindow(): {
    five_hour?: RateLimitEntry;
    seven_day?: RateLimitEntry;
    seven_day_opus?: RateLimitEntry;
    seven_day_sonnet?: RateLimitEntry;
    overage?: RateLimitEntry;
  } {
    return {
      five_hour: this.entries.get('five_hour'),
      seven_day: this.entries.get('seven_day'),
      seven_day_opus: this.entries.get('seven_day_opus'),
      seven_day_sonnet: this.entries.get('seven_day_sonnet'),
      overage: this.entries.get('overage'),
    };
  }

  get size(): number {
    return this.entries.size;
  }

  /** Drop all entries — used by tests for isolation. */
  clear(): void {
    this.entries.clear();
  }
}

/** Process-wide singleton. */
export const globalRateLimitStore = new RateLimitStore();

/**
 * Per-window utilization thresholds for subscription users (cli/oauth).
 * Crossing one of these aborts the SDK loop so we don't burn through the
 * window on background memory work and starve interactive sessions.
 */
const UTILIZATION_THRESHOLDS: Record<RateLimitWindow, number> = {
  five_hour: 0.95,
  seven_day_opus: 0.93,
  seven_day_sonnet: 0.92,
  seven_day: 0.93,
  overage: 0.95,
};

/** Reset-window grace: bail early if a window resets within this many ms. */
const RESET_GRACE_MS = 15 * 60 * 1000; // 15 minutes
/** Utilization floor before the reset-grace check kicks in. */
const RESET_GRACE_UTILIZATION_FLOOR = 0.85;

/**
 * Decide whether to abort SDK consumption based on the latest rate-limit
 * snapshot and the active auth method.
 *
 * - `api_key` (or any string starting with "API key"): never abort —
 *   per-call billing means the user already authorized the spend.
 * - `cli` / OAuth / subscription: per-window utilization thresholds plus a
 *   reset-grace buffer so we avoid burning the last few percent right
 *   before a window resets.
 */
export function shouldAbortForQuota(
  authMethod: string,
  store: RateLimitStore,
  now: number = Date.now(),
): { abort: boolean; reason?: string; window?: RateLimitWindow } {
  // API-key users authorized per-call spend; the wall-clock guard is for
  // subscription quota only.
  if (isApiKeyAuth(authMethod)) {
    return { abort: false };
  }

  const windows: RateLimitWindow[] = [
    'five_hour',
    'seven_day_opus',
    'seven_day_sonnet',
    'seven_day',
    'overage',
  ];

  for (const window of windows) {
    const entry = store.get(window);
    if (!entry) continue;

    const util = entry.utilization;
    const threshold = UTILIZATION_THRESHOLDS[window];

    // Provider-side rejection trumps utilization heuristics. A snapshot with
    // status='rejected' (or overageStatus='rejected' on the overage window)
    // means the provider has already declared the bucket exhausted; we must
    // stop regardless of whether utilization is reported.
    const isRejected =
      entry.status === 'rejected' ||
      (window === 'overage' && entry.overageStatus === 'rejected');

    if (isRejected) {
      return {
        abort: true,
        window,
        reason: `quota:${window} rejected by provider`,
      };
    }

    if (typeof util === 'number' && util >= threshold) {
      return {
        abort: true,
        window,
        reason: `quota:${window} utilization ${(util * 100).toFixed(1)}% >= ${(threshold * 100).toFixed(0)}%`,
      };
    }

    // Reset-grace buffer: only meaningful for the rolling 5h window where
    // a fresh bucket is imminent. Skip when utilization is low — no point
    // bailing on a window that just reset to ~0%.
    if (
      window === 'five_hour' &&
      typeof entry.resetsAt === 'number' &&
      typeof util === 'number' &&
      util >= RESET_GRACE_UTILIZATION_FLOOR
    ) {
      const msUntilReset = entry.resetsAt - now;
      if (msUntilReset > 0 && msUntilReset <= RESET_GRACE_MS) {
        return {
          abort: true,
          window,
          reason: `quota:${window} resets in ${Math.round(msUntilReset / 60000)}m (grace buffer ${RESET_GRACE_MS / 60000}m, util ${(util * 100).toFixed(1)}%)`,
        };
      }
    }
  }

  return { abort: false };
}

/**
 * Detects API-key auth from a free-form auth-method label. Matches the
 * verbose strings produced by `getAuthMethodDescription()` (e.g.
 * "API key (from ~/.claude-mem/.env)") as well as concise tokens like
 * "api_key".
 */
export function isApiKeyAuth(authMethod: string): boolean {
  if (!authMethod) return false;
  const normalized = authMethod.toLowerCase();
  return normalized.startsWith('api key') || normalized === 'api_key';
}
