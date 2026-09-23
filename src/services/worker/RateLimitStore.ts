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
 *                   | "overage",
 *     utilization?: number,                           // 0..1
 *     overageStatus?: "allowed" | "allowed_warning" | "rejected",
 *     overageResetsAt?: number,
 *     isUsingOverage?: boolean,
 *     surpassedThreshold?: number,
 *   }
 *
 * Claude Code additionally attaches an undocumented `unifiedWindows` map
 * (`{ five_hour: { utilization, resetsAt }, seven_day: {...} }`) carrying the
 * live state of EVERY window, not just the one named by `rateLimitType`. The
 * SDK passes it through untouched; it is optional here and only used when
 * present.
 *
 * Pattern adapted from meridian's proxy/rateLimitStore.ts (last-write-wins
 * per `rateLimitType` bucket, in-memory only). State resets on worker
 * restart — that's fine, the SDK pushes a fresh event on the next request.
 *
 * Two rules keep a bucket from going stale (#4068): every snapshot also
 * refreshes the other windows from `unifiedWindows`, and the guard ignores
 * any bucket whose `resetsAt` is already in the past. Without them a
 * `seven_day` snapshot taken while that window was the binding one is never
 * overwritten (later events are `five_hour`-typed) and keeps aborting the
 * observer for days after the window has actually reset.
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

/** Per-window slice of the undocumented `unifiedWindows` map. */
export interface RateLimitWindowSnapshot {
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
  /** Live state of every window, when the CLI attaches it. Not in the SDK type. */
  unifiedWindows?: Partial<Record<string, RateLimitWindowSnapshot | null | undefined>>;
}

const KNOWN_WINDOWS: readonly RateLimitWindow[] = [
  'five_hour',
  'seven_day',
  'seven_day_opus',
  'seven_day_sonnet',
  'overage',
];

function isKnownWindow(key: string): key is RateLimitWindow {
  return (KNOWN_WINDOWS as readonly string[]).includes(key);
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
    if (!info || typeof info !== 'object') return false;
    const { unifiedWindows, ...top } = info;
    const key: RateLimitBucketKey = top.rateLimitType ?? 'default';
    const previous = this.entries.get(key);
    const observedAt = Date.now();

    // Every event carries the live state of all windows in `unifiedWindows`.
    // Refresh the other buckets from it so a window that stopped being the
    // binding one still gets its utilization/resetsAt updated (#4068). The
    // primary bucket is written last so its explicit top-level fields win.
    const unified = unifiedWindows && typeof unifiedWindows === 'object' ? unifiedWindows : undefined;
    if (unified) {
      for (const [window, snapshot] of Object.entries(unified)) {
        if (!isKnownWindow(window) || window === key) continue;
        if (!snapshot || typeof snapshot !== 'object') continue;
        this.entries.set(window, {
          rateLimitType: window,
          ...pickSnapshot(snapshot),
          observedAt,
        });
      }
    }

    const primarySnapshot = unified && key !== 'default' ? unified[key] : undefined;
    this.entries.set(key, {
      ...(primarySnapshot && typeof primarySnapshot === 'object' ? pickSnapshot(primarySnapshot) : {}),
      ...top,
      observedAt,
    });
    return isNewRejection(previous, top);
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
  return previous.resetsAt !== next.resetsAt;
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

/** Normalize a `resetsAt` that may be epoch seconds or epoch ms to epoch ms. */
export function toEpochMs(resetsAt: number | undefined): number | undefined {
  if (typeof resetsAt !== 'number' || !Number.isFinite(resetsAt)) return undefined;
  return resetsAt < 1e12 ? resetsAt * 1000 : resetsAt;
}

/**
 * A bucket whose window has already reset says nothing about the current
 * window. The guard must skip it rather than abort on a number that was
 * true days ago (#4068).
 */
export function isStaleEntry(entry: RateLimitInfo, now: number = Date.now()): boolean {
  const resetsAtMs = toEpochMs(entry.resetsAt);
  return resetsAtMs !== undefined && resetsAtMs <= now;
}

/** Copy only the numeric fields of a `unifiedWindows` slice. */
function pickSnapshot(snapshot: RateLimitWindowSnapshot): RateLimitWindowSnapshot {
  const out: RateLimitWindowSnapshot = {};
  if (typeof snapshot.utilization === 'number') out.utilization = snapshot.utilization;
  if (typeof snapshot.resetsAt === 'number') out.resetsAt = snapshot.resetsAt;
  return out;
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
    // The snapshot describes a window that has since reset; it no longer
    // says anything about current usage. Wait for a fresh event instead.
    if (isStaleEntry(entry, now)) continue;

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
      typeof entry.resetsAt === 'number' &&
      typeof util === 'number' &&
      util >= RESET_GRACE_UTILIZATION_FLOOR
    ) {
      // resetsAt arrives as epoch seconds from Claude Code; normalize.
      const msUntilReset = (toEpochMs(entry.resetsAt) as number) - now;
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
