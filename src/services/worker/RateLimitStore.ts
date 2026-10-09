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
 *     unifiedWindows?: {                              // not in sdk.d.ts
 *       [window]: { utilization?: number, resetsAt?: number },
 *     },
 *   }
 *
 * `rateLimitType` names only the binding window. The CLI also reports the
 * account-wide windows' live figures in `unifiedWindows`, so set() refreshes
 * those buckets too; otherwise a window that stops being the binding one keeps
 * its last snapshot until the worker restarts (#4076).
 *
 * Pattern adapted from meridian's proxy/rateLimitStore.ts (last-write-wins
 * per `rateLimitType` bucket, in-memory only). State resets on worker
 * restart — that's fine, the SDK pushes a fresh event on the next request.
 *
 * Quota-aware abort logic gates the worker from continuing to consume a
 * subscription bucket once it crosses a per-window threshold. API-key
 * users are exempt because they authorized per-call spend.
 */

import { SettingsDefaultsManager, type SettingsDefaults } from '../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../shared/paths.js';
import { logger } from '../../utils/logger.js';

export type RateLimitWindow =
  | 'five_hour'
  | 'seven_day'
  | 'seven_day_opus'
  | 'seven_day_sonnet'
  /**
   * A per-model weekly bucket: Claude Code 2.1.286 labels it the "Fable
   * limit" and applies it only to requests on the models of its
   * overage-included allowlist. The CLI reads its figure from response
   * headers that every response of an account with the bucket carries,
   * whatever model the request used, so the figure (and any warning the CLI
   * derives from it) is not evidence that the observer draws on it. Above 1
   * it is usage that legitimately ran past the cap, not a refusal. Only the
   * provider refusing the observer's own request (`rejected`) stops the
   * observer on it.
   */
  | 'seven_day_overage_included'
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
  unifiedWindows?: Partial<Record<RateLimitWindow, UnifiedWindowSnapshot>>;
}

export interface UnifiedWindowSnapshot {
  utilization?: number;
  resetsAt?: number;
}

// The account-wide windows: every request draws on them, whatever its model.
// Per-model buckets are left out: their figures describe one model's usage,
// which the observer draws on only when it runs that model, so they are
// recorded only when an event names one as its `rateLimitType`. A user deep
// into their weekly Fable limit must not pause a Haiku observer (#4132).
// `overage` is left out too: its guard also depends on isUsingOverage and
// overageStatus, which a unified snapshot does not carry.
const UNIFIED_WINDOWS: readonly RateLimitWindow[] = ['five_hour', 'seven_day'];

export interface RateLimitEntry extends RateLimitInfo {
  observedAt: number;
  /**
   * Not part of the SDK payload: the Claude config-dir profile whose
   * credentials produced the snapshot (resolveConfigDirProfileKey). Quota is
   * per account, so a snapshot from one profile must not gate spawns billed to
   * another after CLAUDE_MEM_CLAUDE_CONFIG_DIR changes. Absent = unscoped.
   */
  profile?: string;
}

/** A stored entry as the health surface shows it. */
export interface RateLimitHealthEntry extends RateLimitEntry {
  /** Set when the window's reset has passed: the reading no longer applies. */
  expired?: true;
}

export type RateLimitBucketKey = RateLimitWindow | 'default';

export class RateLimitStore {
  private entries = new Map<RateLimitBucketKey, RateLimitEntry>();
  // Telemetry deduplication survives display-only unified-window refreshes.
  private rejections = new Map<RateLimitBucketKey, RateLimitInfo>();

  /**
   * Record a rate-limit info snapshot. Last-write-wins per bucket key.
   * Accepts both the literal `rate_limit_info` payload and a wrapping object;
   * callers should pass the inner info, tagged with `profile` when known.
   */
  set(info: Omit<RateLimitEntry, 'observedAt'> | undefined | null): boolean {
    if (!info || typeof info !== 'object') return false;
    // The raw per-window map is consumed below. Storing it too would leave a
    // nested copy on the entry that goes stale on /api/health.
    const { unifiedWindows, ...reported } = info;
    const key: RateLimitBucketKey = info.rateLimitType ?? 'default';
    const previousRejection = this.rejections.get(key);
    const observedAt = Date.now();
    const unified = readUnifiedWindows(unifiedWindows);

    // Other windows: refresh fields the unified snapshot actually reports.
    // Utilization establishes a new display state and drops stale status;
    // reset-only snapshots preserve an unchanged active rejection.
    for (const [window, snapshot] of unified) {
      if (window === key) continue;
      // State carries forward only within one account: another account's
      // reset time or rejection says nothing about this account's window.
      const cachedWindow = this.entries.get(window);
      const previousWindow = cachedWindow && !isOtherProfile(cachedWindow, info.profile)
        ? cachedWindow
        : undefined;
      // Carry the cached reset only while it is still ahead: an expired one
      // would make the guard skip this fresh reading as stale.
      const carriedResetsAt = isResetPending(previousWindow?.resetsAt, observedAt)
        ? previousWindow?.resetsAt
        : undefined;
      const resetsAt = snapshot.resetsAt ?? carriedResetsAt;
      const repeatsRejectedReset =
        snapshot.utilization === undefined &&
        previousWindow?.status === 'rejected' &&
        sameResetTime(resetsAt, previousWindow.resetsAt) &&
        isResetPending(resetsAt, observedAt);
      this.entries.set(window, {
        rateLimitType: window,
        ...snapshot,
        resetsAt,
        ...(repeatsRejectedReset ? { status: 'rejected' as const } : {}),
        // Siblings describe the same account as the event that carried them.
        ...(info.profile !== undefined ? { profile: info.profile } : {}),
        observedAt,
      });
      const rejectedWindow = this.rejections.get(window);
      if (
        rejectedWindow &&
        snapshot.resetsAt !== undefined &&
        !sameResetTime(snapshot.resetsAt, rejectedWindow.resetsAt)
      ) {
        this.rejections.delete(window);
      }
    }

    const own = info.rateLimitType ? unified.get(info.rateLimitType) : undefined;
    const merged: RateLimitEntry = {
      ...reported,
      utilization: info.utilization ?? own?.utilization,
      // Stored in epoch ms whatever unit the event used, so the rejection
      // de-dupe below and /api/health compare like with like.
      resetsAt: normalizeResetTimeMs(info.resetsAt) ?? own?.resetsAt,
      overageResetsAt: normalizeResetTimeMs(info.overageResetsAt),
      observedAt,
    };
    this.entries.set(key, merged);
    // Compare the merged entry, so a resetsAt that only arrives via
    // unifiedWindows still dedupes repeated rejections.
    const newRejection = isNewRejection(previousRejection, merged);
    if (merged.status === 'rejected') {
      this.rejections.set(key, merged);
    } else if (
      info.status !== undefined ||
      (previousRejection &&
        merged.resetsAt !== undefined &&
        !sameResetTime(merged.resetsAt, previousRejection.resetsAt))
    ) {
      this.rejections.delete(key);
    }
    return newRejection;
  }

  /** Snapshot a single bucket, or undefined if not yet seen. */
  get(type: RateLimitWindow | undefined): RateLimitEntry | undefined {
    if (!type) return this.entries.get('default');
    return this.entries.get(type);
  }

  /**
   * Latest snapshot per "interesting" window for health surface. A window
   * whose reset has passed is flagged `expired: true`: the guard already
   * ignores it, and without the flag /api/health showed a dead 93% reading
   * as live (#4068, #4114). The stored entries stay raw for set()'s de-dupe.
   */
  getMostRecentByWindow(now: number = Date.now()): {
    five_hour?: RateLimitHealthEntry;
    seven_day?: RateLimitHealthEntry;
    seven_day_opus?: RateLimitHealthEntry;
    seven_day_sonnet?: RateLimitHealthEntry;
    seven_day_overage_included?: RateLimitHealthEntry;
    overage?: RateLimitHealthEntry;
  } {
    const view = (window: RateLimitWindow): RateLimitHealthEntry | undefined => {
      const entry = this.entries.get(window);
      if (!entry) return undefined;
      const resetsAtMs = normalizeResetTimeMs(entry.resetsAt);
      return resetsAtMs !== undefined && resetsAtMs <= now ? { ...entry, expired: true } : entry;
    };
    return {
      five_hour: view('five_hour'),
      seven_day: view('seven_day'),
      seven_day_opus: view('seven_day_opus'),
      seven_day_sonnet: view('seven_day_sonnet'),
      seven_day_overage_included: view('seven_day_overage_included'),
      overage: view('overage'),
    };
  }

  get size(): number {
    return this.entries.size;
  }
}

function sameResetTime(left: number | undefined, right: number | undefined): boolean {
  return normalizeResetTimeMs(left) === normalizeResetTimeMs(right);
}

function isResetPending(resetsAt: number | undefined, now: number): boolean {
  const resetsAtMs = normalizeResetTimeMs(resetsAt);
  return resetsAtMs !== undefined && resetsAtMs > now;
}

/** Windows in UNIFIED_WINDOWS with a well-formed snapshot; anything else is skipped. */
function readUnifiedWindows(raw: unknown): Map<RateLimitWindow, UnifiedWindowSnapshot> {
  const out = new Map<RateLimitWindow, UnifiedWindowSnapshot>();
  if (!raw || typeof raw !== 'object') return out;
  for (const window of UNIFIED_WINDOWS) {
    const entry = (raw as Record<string, unknown>)[window];
    if (!entry || typeof entry !== 'object') continue;
    const { utilization, resetsAt } = entry as Record<string, unknown>;
    // A field that is present but not a finite number voids the whole entry:
    // the CLI never writes one, so this is a corrupt snapshot, and refreshing
    // the window from its other half would replace a good reading with half
    // of a bad one.
    if (!isAbsentOrFiniteNumber(utilization) || !isAbsentOrFiniteNumber(resetsAt)) continue;
    const snapshot: UnifiedWindowSnapshot = {};
    if (typeof utilization === 'number') snapshot.utilization = utilization;
    if (typeof resetsAt === 'number') snapshot.resetsAt = normalizeResetTimeMs(resetsAt);
    if (snapshot.utilization !== undefined || snapshot.resetsAt !== undefined) out.set(window, snapshot);
  }
  return out;
}

function isAbsentOrFiniteNumber(value: unknown): boolean {
  return value == null || (typeof value === 'number' && Number.isFinite(value));
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
  const resetsAtMs = normalizeResetTimeMs(resetsAt);
  if (resetsAtMs === undefined) return undefined;
  return Math.max(0, Math.round((resetsAtMs - now) / 60_000));
}

function normalizeResetTimeMs(resetsAt: number | undefined): number | undefined {
  if (typeof resetsAt !== 'number' || !Number.isFinite(resetsAt)) return undefined;
  return resetsAt < 1e12 ? resetsAt * 1000 : resetsAt;
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
 * Settings that hold the per-window utilization thresholds for subscription
 * users (cli/oauth). Crossing one of these aborts the SDK loop so we don't
 * burn through the window on background memory work and starve interactive
 * sessions. `seven_day_overage_included` has none: its figure does not say
 * the observer draws on it (see RateLimitWindow), so only a refusal counts.
 */
const UTILIZATION_THRESHOLD_SETTINGS: Partial<Record<RateLimitWindow, keyof SettingsDefaults>> = {
  five_hour: 'CLAUDE_MEM_QUOTA_THRESHOLD_FIVE_HOUR',
  seven_day_opus: 'CLAUDE_MEM_QUOTA_THRESHOLD_SEVEN_DAY_OPUS',
  seven_day_sonnet: 'CLAUDE_MEM_QUOTA_THRESHOLD_SEVEN_DAY_SONNET',
  seven_day: 'CLAUDE_MEM_QUOTA_THRESHOLD_SEVEN_DAY',
  overage: 'CLAUDE_MEM_QUOTA_THRESHOLD_OVERAGE',
};

/** Threshold settings already warned about: once per key per process, not per rate_limit_event. */
const warnedInvalidThresholdKeys = new Set<keyof SettingsDefaults>();

/**
 * The window's threshold: a fraction from 0 to 1 (0.93 = 93%), where 0 stops
 * at any utilization and 1 only at full. A blank value gives the shipped
 * default. So does any other value, such as `93` meant as a percent, which
 * would otherwise turn the window's guard off silently; that is logged once
 * per key.
 */
function utilizationThreshold(window: RateLimitWindow, settings: SettingsDefaults): number | undefined {
  const key = UTILIZATION_THRESHOLD_SETTINGS[window];
  if (!key) return undefined;
  const fallback = Number(SettingsDefaultsManager.getAllDefaults()[key]);
  // settings.json is hand-editable, so the value can arrive as a JSON number.
  const configured: unknown = settings[key];
  const raw = configured == null ? '' : String(configured).trim();
  if (raw === '') return fallback;
  const threshold = Number(raw);
  // NaN fails both comparisons, so `0.9x` or `abc` falls through as well.
  if (threshold >= 0 && threshold <= 1) return threshold;
  if (!warnedInvalidThresholdKeys.has(key)) {
    warnedInvalidThresholdKeys.add(key);
    logger.warn('CONFIG', `${key} must be a fraction from 0 to 1 (0.93 = 93%); using the default instead`, {
      value: raw,
      default: fallback,
    });
  }
  return fallback;
}

/** Reset-window grace: bail early if a window resets within this many ms. */
const RESET_GRACE_MS = 15 * 60 * 1000; // 15 minutes
/** Utilization floor before the reset-grace check kicks in. */
const RESET_GRACE_UTILIZATION_FLOOR = 0.85;

/**
 * Decide whether to abort SDK consumption based on the latest rate-limit
 * snapshot and the active auth method.
 *
 * `profile` is the account the caller is billing. Snapshots tagged with a
 * different profile are ignored: they describe another account's quota. When
 * either side is untagged the snapshot applies, as before.
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
  profile?: string,
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
    'seven_day_overage_included',
    'overage',
  ];
  const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);

  for (const window of windows) {
    const entry = store.get(window);
    if (!entry) continue;
    if (isOtherProfile(entry, profile)) continue;

    // Ignore expired snapshots without removing them from the store so a
    // repeated stale rejection does not look new to set() telemetry.
    const resetsAtMs = normalizeResetTimeMs(entry.resetsAt);
    if (resetsAtMs !== undefined && resetsAtMs <= now) continue;

    const util = entry.utilization;
    const threshold = utilizationThreshold(window, settings);
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

    if (appliesUtilizationThreshold && threshold !== undefined && typeof util === 'number' && util >= threshold) {
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

function isOtherProfile(entry: RateLimitEntry, profile: string | undefined): boolean {
  return profile !== undefined && entry.profile !== undefined && entry.profile !== profile;
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
