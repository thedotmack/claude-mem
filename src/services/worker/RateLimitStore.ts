/**
 * Rate limit store — captures `rate_limit` system events emitted by
 * `@anthropic-ai/claude-agent-sdk`'s `query()` stream.
 *
 * The SDK reports the live Claude subscription quota state as a top-level
 * `rate_limit_event` message (`SDKRateLimitEvent` in sdk.d.ts). Older builds
 * surfaced it as a `system` message with subtype `rate_limit`; both shapes
 * are accepted by extractRateLimitInfo. The `rate_limit_info` payload:
 *
 *   {
 *     status: "allowed" | "allowed_warning" | "rejected",
 *     resetsAt?: number,                              // epoch ms or seconds
 *     rateLimitType?: "five_hour" | "seven_day"
 *                   | "seven_day_opus" | "seven_day_sonnet"
 *                   | "overage",
 *     utilization?: number,                           // 0..1
 *     overageStatus?: "allowed" | "allowed_warning" | "rejected",
 *     overageResetsAt?: number,                       // epoch ms or seconds
 *     isUsingOverage?: boolean,
 *     surpassedThreshold?: number,
 *     unifiedWindows?: { [window]: RateLimitWindowSnapshot },
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

export interface RateLimitWindowSnapshot {
  status?: 'allowed' | 'allowed_warning' | 'rejected';
  resetsAt?: number;
  utilization?: number;
  overageStatus?: 'allowed' | 'allowed_warning' | 'rejected';
  overageResetsAt?: number;
  isUsingOverage?: boolean;
  surpassedThreshold?: number;
}

export interface RateLimitInfo extends RateLimitWindowSnapshot {
  rateLimitType?: RateLimitWindow;
  /**
   * Newer SDK events can carry a coherent snapshot for every quota window
   * alongside the event's primary bucket. These snapshots are authoritative
   * for their respective buckets and must replace, rather than merge with,
   * older entries so stale rejection state cannot survive a reset.
   */
  unifiedWindows?: Partial<Record<RateLimitWindow, RateLimitWindowSnapshot>>;
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
  set(info: RateLimitInfo | undefined | null): boolean {
    return this.setWithNewRejections(info).length > 0;
  }

  /**
   * Record a snapshot and return the exact buckets that became rejected.
   * Callers that emit per-window telemetry should use this instead of `set()`.
   */
  setWithNewRejections(info: RateLimitInfo | undefined | null): RateLimitEntry[] {
    if (!info || typeof info !== 'object') return [];
    const newRejections: RateLimitEntry[] = [];
    const key: RateLimitBucketKey = info.rateLimitType ?? 'default';

    // Build the final authoritative snapshot per bucket first. A unified
    // snapshot for the same window as the top-level bucket is a fresh view
    // that must override the primary entry (it can clear stale fields even
    // when it omits them, e.g. an old `status: rejected`). Writing each final
    // bucket exactly once means a rejection transition is evaluated once
    // against the pre-event cache, so a same-key primary+unified pair cannot
    // produce a transient or duplicate rejection signal.
    const buckets = new Map<RateLimitBucketKey, RateLimitInfo>([
      [key, info],
    ]);
    for (const [window, snapshot] of Object.entries(info.unifiedWindows ?? {})) {
      if (!isRateLimitWindow(window) || !snapshot || typeof snapshot !== 'object') continue;
      buckets.set(window, { ...snapshot, rateLimitType: window });
    }

    for (const [bucketKey, bucketInfo] of buckets) {
      const rejection = this.setBucket(bucketKey, bucketInfo);
      if (rejection) newRejections.push(rejection);
    }

    return newRejections;
  }

  private setBucket(key: RateLimitBucketKey, info: RateLimitInfo): RateLimitEntry | undefined {
    const previous = this.entries.get(key);
    const next = {
      ...info,
      ...(key === 'default' ? {} : { rateLimitType: key }),
      observedAt: Date.now(),
    };
    this.entries.set(key, next);
    return isNewRejection(previous, next) ? next : undefined;
  }

  /** Snapshot a single bucket, or undefined if not yet seen. */
  get(type: RateLimitWindow | undefined): RateLimitEntry | undefined {
    if (!type) return this.entries.get('default');
    return this.entries.get(type);
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
}

/** Process-wide singleton. */
export const globalRateLimitStore = new RateLimitStore();

/**
 * Pull the `rate_limit_info` payload out of an SDK stream message, or
 * undefined when the message is not a quota snapshot.
 *
 * The SDK emits `{ type: 'rate_limit_event', rate_limit_info }` — a top-level
 * message type in the SDKMessage union, NOT a `system` subtype. The original
 * guard (#2234) matched `type === 'system' && subtype === 'rate_limit'`, which
 * the SDK never sends, so the quota guard and every consumer of the store were
 * dead until this extractor replaced it. The legacy shape is still accepted in
 * case an older SDK build is on the path.
 */
export function extractRateLimitInfo(message: unknown): RateLimitInfo | undefined {
  if (!message || typeof message !== 'object') return undefined;
  const m = message as { type?: unknown; subtype?: unknown; rate_limit_info?: unknown };
  const isRateLimitMessage =
    m.type === 'rate_limit_event' || (m.type === 'system' && m.subtype === 'rate_limit');
  if (!isRateLimitMessage) return undefined;
  const info = m.rate_limit_info;
  if (!info || typeof info !== 'object') return undefined;
  return info as RateLimitInfo;
}

/**
 * A snapshot is a NEW rejection when it says `rejected` and the previous
 * snapshot for the same window did not — or pointed at a different reset
 * time, which means the window was exhausted again after a reset without an
 * `allowed` snapshot in between. The SDK re-sends `rejected` on every request
 * while the wall is up, so this is what keeps `usage_limit_hit` at one event
 * per exhaustion instead of one per observer request.
 */
export function isNewRejection(
  previous: RateLimitInfo | undefined,
  next: RateLimitInfo,
): boolean {
  if (next.status !== 'rejected') return false;
  if (!previous || previous.status !== 'rejected') return true;
  return toEpochMs(previous.resetsAt) !== toEpochMs(next.resetsAt);
}

/**
 * Whole minutes until the window resets, floored at 0. Claude Code has been
 * seen writing `resetsAt` as epoch seconds in transcripts while the SDK
 * documents epoch ms, so anything too small to be ms is treated as seconds.
 */
export function minutesUntilReset(resetsAt: number | undefined, now: number = Date.now()): number | undefined {
  const resetsAtMs = toEpochMs(resetsAt);
  if (resetsAtMs === undefined) return undefined;
  return Math.max(0, Math.round((resetsAtMs - now) / 60_000));
}

/**
 * PostHog properties for one `usage_limit_hit` event. Closed enums, a
 * boolean, and one integer — never the provider's message text.
 */
export function buildUsageLimitHitProps(
  info: RateLimitInfo,
  now: number = Date.now(),
): Record<string, unknown> {
  const resetsAt = info.rateLimitType === 'overage' ? info.overageResetsAt : info.resetsAt;
  return {
    limit_window: info.rateLimitType ?? 'unknown',
    overage_status: info.overageStatus ?? 'unknown',
    is_using_overage: info.isUsingOverage === true,
    resets_in_minutes: minutesUntilReset(resetsAt, now),
  };
}

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

    // Ignore expired snapshots without removing them from the store so a
    // repeated stale rejection does not look new to set() telemetry. Overage
    // has its own reset: a primary-window reset cannot clear its rejection.
    const resetsAtMs = getResetAtMs(entry, window);
    if (resetsAtMs !== undefined && resetsAtMs <= now) continue;

    const util = entry.utilization;
    const threshold = UTILIZATION_THRESHOLDS[window];
    // An explicit false means the provider is not charging the overage bucket,
    // so its utilization does not represent active quota consumption.
    const appliesUtilizationThreshold =
      window !== 'overage' || entry.isUsingOverage !== false;

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

    if (appliesUtilizationThreshold && typeof util === 'number' && util >= threshold) {
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
      resetsAtMs !== undefined &&
      typeof util === 'number' &&
      util >= RESET_GRACE_UTILIZATION_FLOOR
    ) {
      const msUntilReset = resetsAtMs - now;
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

function isRateLimitWindow(value: string): value is RateLimitWindow {
  return (
    value === 'five_hour' ||
    value === 'seven_day' ||
    value === 'seven_day_opus' ||
    value === 'seven_day_sonnet' ||
    value === 'overage'
  );
}

function toEpochMs(value: number | undefined): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return value < 1e12 ? value * 1000 : value;
}

function getResetAtMs(entry: RateLimitInfo, window: RateLimitWindow): number | undefined {
  if (window === 'overage') {
    // The primary window's reset does not clear an overage rejection. Without
    // an explicit overage reset, keep the rejection active until a fresh
    // provider snapshot replaces it.
    return toEpochMs(entry.overageResetsAt);
  }
  return toEpochMs(entry.resetsAt);
}
