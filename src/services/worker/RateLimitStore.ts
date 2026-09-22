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
 *     resetsAt?: number,                              // epoch ms
 *     rateLimitType?: "five_hour" | "seven_day"
 *                   | "seven_day_opus" | "seven_day_sonnet"
 *                   | "seven_day_overage_included" | "overage",
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
  /** Weekly window for the premium model bucket, counted with overage included. */
  | 'seven_day_overage_included'
  | 'overage';

/**
 * One window's slice of `unifiedWindows`. `utilization` is 0..1 and
 * `resetsAt` carries the same epoch-seconds-or-ms ambiguity as the
 * top-level field.
 */
export interface UnifiedWindowSnapshot {
  utilization?: number;
  resetsAt?: number;
}

export interface RateLimitInfo {
  status?: 'allowed' | 'allowed_warning' | 'rejected';
  resetsAt?: number;
  rateLimitType?: RateLimitWindow;
  utilization?: number;
  overageStatus?: 'allowed' | 'allowed_warning' | 'rejected';
  overageResetsAt?: number;
  isUsingOverage?: boolean;
  surpassedThreshold?: number;
  /**
   * Every event describes every window here, not just the one it is typed
   * as. Absent from `SDKRateLimitInfo` in the agent SDK's current typings
   * but present on the wire (Claude Code v2.1.267), so it is validated at
   * runtime and ignored when missing.
   *
   * Claude Code fans out only `five_hour`, `seven_day`, and
   * `seven_day_overage_included` here — the model-typed weeklies and the
   * overage bucket never arrive this way. Other keys are accepted because
   * the field is undocumented and free to grow.
   */
  unifiedWindows?: Partial<Record<RateLimitWindow, UnifiedWindowSnapshot>>;
}

export interface RateLimitEntry extends RateLimitInfo {
  observedAt: number;
}

export type RateLimitBucketKey = RateLimitWindow | 'default';

/** Windows the guard evaluates, in the order it evaluates them. */
const RATE_LIMIT_WINDOWS: RateLimitWindow[] = [
  'five_hour',
  'seven_day_opus',
  'seven_day_sonnet',
  'seven_day',
  'seven_day_overage_included',
  'overage',
];

function isRateLimitWindow(value: string): value is RateLimitWindow {
  return (RATE_LIMIT_WINDOWS as string[]).includes(value);
}

export class RateLimitStore {
  private entries = new Map<RateLimitBucketKey, RateLimitEntry>();

  /**
   * Record a rate-limit info snapshot. Last-write-wins per bucket key.
   * Accepts both the literal `rate_limit_info` payload and a wrapping object;
   * callers should pass the inner info.
   */
  set(info: RateLimitInfo | undefined | null): boolean {
    if (!info || typeof info !== 'object') return false;
    const key: RateLimitBucketKey = info.rateLimitType ?? 'default';
    const previous = this.entries.get(key);
    const observedAt = Date.now();
    this.entries.set(key, { ...info, observedAt });
    this.hydrateUnifiedWindows(info, key, observedAt);
    return isNewRejection(previous, info);
  }

  /**
   * Fan `unifiedWindows` out into the per-window buckets.
   *
   * The provider types an event at a window only as that window nears its
   * limit, so without this the other buckets keep whatever reading they were
   * last typed at — a `seven_day` entry can sit at its pre-reset utilization
   * for days while every arriving event already carries the current number.
   */
  private hydrateUnifiedWindows(
    info: RateLimitInfo,
    primaryKey: RateLimitBucketKey,
    observedAt: number,
  ): void {
    const unified = info.unifiedWindows;
    if (!unified || typeof unified !== 'object') return;

    for (const [window, snapshot] of Object.entries(unified)) {
      // The primary bucket was just written in full; a partial snapshot would
      // only strip its status and overage fields.
      if (window === primaryKey) continue;
      if (!isRateLimitWindow(window)) continue;
      if (!snapshot || typeof snapshot !== 'object') continue;

      // Status and overage fields describe the window they were observed in.
      // Carry them forward only while the reset still points at that window.
      //
      // The overage bucket runs on a second clock that `unifiedWindows` never
      // carries, so its reset comes from the arriving event — and a carried
      // `overageStatus` survives only while that reset is unchanged too.
      const previous = this.entries.get(window);
      const isOverage = window === 'overage';
      const overageResetsAt = isOverage ? info.overageResetsAt ?? snapshot.resetsAt : undefined;
      const sameWindow =
        previous !== undefined &&
        resetsAtMs(previous.resetsAt) === resetsAtMs(snapshot.resetsAt) &&
        (!isOverage ||
          resetsAtMs(previous.overageResetsAt ?? previous.resetsAt) ===
            resetsAtMs(overageResetsAt));

      this.entries.set(window, {
        ...(sameWindow ? previous : {}),
        ...snapshot,
        ...(isOverage ? { overageResetsAt } : {}),
        rateLimitType: window,
        observedAt,
      });
    }
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
    seven_day_overage_included?: RateLimitEntry;
    overage?: RateLimitEntry;
  } {
    return {
      five_hour: this.entries.get('five_hour'),
      seven_day: this.entries.get('seven_day'),
      seven_day_opus: this.entries.get('seven_day_opus'),
      seven_day_sonnet: this.entries.get('seven_day_sonnet'),
      seven_day_overage_included: this.entries.get('seven_day_overage_included'),
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
  return previous.resetsAt !== next.resetsAt;
}

/**
 * Normalize a `resetsAt` to epoch ms, or undefined when it is not a number.
 * Claude Code has been seen writing it as epoch seconds in transcripts while
 * the SDK documents epoch ms, so anything too small to be ms is treated as
 * seconds.
 */
export function resetsAtMs(resetsAt: number | undefined): number | undefined {
  if (typeof resetsAt !== 'number' || !Number.isFinite(resetsAt)) return undefined;
  return resetsAt < 1e12 ? resetsAt * 1000 : resetsAt;
}

/** True when a normalized reset timestamp names a window that has already ended. */
function hasPassed(resetsAtInMs: number | undefined, now: number): boolean {
  return resetsAtInMs !== undefined && resetsAtInMs <= now;
}

/** Whole minutes until the window resets, floored at 0. */
export function minutesUntilReset(resetsAt: number | undefined, now: number = Date.now()): number | undefined {
  const resetsAtInMs = resetsAtMs(resetsAt);
  if (resetsAtInMs === undefined) return undefined;
  return Math.max(0, Math.round((resetsAtInMs - now) / 60_000));
}

/**
 * PostHog properties for one `usage_limit_hit` event. Closed enums, a
 * boolean, and one integer — never the provider's message text.
 */
export function buildUsageLimitHitProps(
  info: RateLimitInfo,
  now: number = Date.now(),
): Record<string, unknown> {
  return {
    limit_window: info.rateLimitType ?? 'unknown',
    overage_status: info.overageStatus ?? 'unknown',
    is_using_overage: info.isUsingOverage === true,
    resets_in_minutes: minutesUntilReset(info.resetsAt, now),
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
  seven_day_overage_included: 0.93,
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

  for (const window of RATE_LIMIT_WINDOWS) {
    const entry = store.get(window);
    if (!entry) continue;

    // A snapshot only describes the window it was taken in. Once that window
    // has reset, its utilization belongs to a bucket that no longer exists,
    // and acting on it latches the guard shut: the SDK only re-sends a
    // window's event as that window approaches its limit again, so a stale
    // near-100% seven_day reading would abort every request forever.
    //
    // The overage bucket runs on its own clock, so each piece of state is
    // judged against the reset that governs it: `overageStatus` by
    // `overageResetsAt`, utilization and `status` by `resetsAt`. A rejected
    // overage stays enforced past the primary window's reset, and vice versa.
    const isOverage = window === 'overage';
    const primaryResetsAt = resetsAtMs(entry.resetsAt);
    const primaryExpired = hasPassed(primaryResetsAt, now);
    const overageExpired = hasPassed(resetsAtMs(entry.overageResetsAt) ?? primaryResetsAt, now);

    const util = entry.utilization;
    const threshold = UTILIZATION_THRESHOLDS[window];
    // An explicit false means the provider is not charging the overage bucket,
    // so its utilization does not represent active quota consumption.
    const appliesUtilizationThreshold =
      !primaryExpired && (!isOverage || entry.isUsingOverage !== false);

    // Provider-side rejection trumps utilization heuristics. A snapshot with
    // status='rejected' (or overageStatus='rejected' on the overage window)
    // means the provider has already declared the bucket exhausted; we must
    // stop regardless of whether utilization is reported.
    const isRejected =
      (entry.status === 'rejected' && !primaryExpired) ||
      (isOverage && entry.overageStatus === 'rejected' && !overageExpired);

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
      primaryResetsAt !== undefined &&
      typeof util === 'number' &&
      util >= RESET_GRACE_UTILIZATION_FLOOR
    ) {
      const msUntilReset = primaryResetsAt - now;
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
