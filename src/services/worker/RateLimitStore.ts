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

/** Delay between quota-limited Claude observer recovery probes. */
export const CLAUDE_QUOTA_RETRY_MS = 15 * 60 * 1000;

/**
 * Maximum time an admitted recovery probe owns the global permit before a
 * replacement probe may be tried. A token prevents a late probe from clearing
 * a newer block.
 */
export const CLAUDE_QUOTA_PROBE_LEASE_MS = 5 * 60 * 1000;

export type ClaudeSpawnBlock =
  | { blocked: false }
  | { blocked: true; retryAt: number; reason: string };

export type ClaudeSpawnPermit =
  | { allowed: false; retryAt: number; reason: string }
  | { allowed: true; probeToken?: number };

interface ClaudeSpawnGate {
  blockedUntil: number;
  reason: string;
  activeProbeToken?: number;
  probeLeaseUntil?: number;
}

export class RateLimitStore {
  private entries = new Map<RateLimitBucketKey, RateLimitEntry>();
  private claudeSpawnGate: ClaudeSpawnGate | null = null;
  private nextClaudeProbeToken = 1;

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

  /**
   * Pause new Claude observer processes without discarding queued work.
   * Repeated quota signals may extend, but never shorten, the cooldown.
   */
  blockClaudeSpawns(
    reason: string,
    retryAt: number = Date.now() + CLAUDE_QUOTA_RETRY_MS,
  ): void {
    const safeRetryAt = Number.isFinite(retryAt)
      ? retryAt
      : Date.now() + CLAUDE_QUOTA_RETRY_MS;
    const blockedUntil = Math.max(
      safeRetryAt,
      this.claudeSpawnGate?.blockedUntil ?? Number.NEGATIVE_INFINITY,
    );

    this.claudeSpawnGate = {
      blockedUntil,
      reason,
    };
  }

  /** Read-only snapshot used by diagnostics and tests. */
  getClaudeSpawnBlock(now: number = Date.now()): ClaudeSpawnBlock {
    const gate = this.claudeSpawnGate;
    if (!gate) {
      return { blocked: false };
    }

    if (now < gate.blockedUntil) {
      return {
        blocked: true,
        retryAt: gate.blockedUntil,
        reason: gate.reason,
      };
    }

    if (
      gate.activeProbeToken !== undefined &&
      gate.probeLeaseUntil !== undefined &&
      now < gate.probeLeaseUntil
    ) {
      return {
        blocked: true,
        retryAt: gate.probeLeaseUntil,
        reason: gate.reason,
      };
    }

    return { blocked: false };
  }

  /**
   * Atomically admits at most one Claude recovery probe after cooldown.
   * Ordinary operation has no token and remains unconstrained.
   */
  acquireClaudeSpawnPermit(now: number = Date.now()): ClaudeSpawnPermit {
    const gate = this.claudeSpawnGate;
    if (!gate) {
      return { allowed: true };
    }

    const block = this.getClaudeSpawnBlock(now);
    if (block.blocked) {
      return {
        allowed: false,
        retryAt: block.retryAt,
        reason: block.reason,
      };
    }

    const probeToken = this.nextClaudeProbeToken++;
    gate.activeProbeToken = probeToken;
    gate.probeLeaseUntil = now + CLAUDE_QUOTA_PROBE_LEASE_MS;
    return { allowed: true, probeToken };
  }

  /**
   * Final pre-spawn check for starts that may have waited in the process-slot
   * queue while a different session discovered quota exhaustion.
   */
  canStartClaudeSession(
    probeToken: number | undefined,
    now: number = Date.now(),
  ): boolean {
    const gate = this.claudeSpawnGate;
    if (!gate) {
      return true;
    }
    return (
      probeToken !== undefined &&
      probeToken === gate.activeProbeToken &&
      gate.probeLeaseUntil !== undefined &&
      now < gate.probeLeaseUntil
    );
  }

  /**
   * Reopen normal starts only when the currently admitted probe proves that
   * Claude is responding without a quota signal.
   */
  completeClaudeSpawnProbe(probeToken: number): boolean {
    if (this.claudeSpawnGate?.activeProbeToken !== probeToken) {
      return false;
    }
    this.claudeSpawnGate = null;
    return true;
  }

  clearClaudeSpawnBlock(): void {
    this.claudeSpawnGate = null;
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
