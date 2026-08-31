/**
 * Per-provider quota circuit breaker (#3634).
 *
 * When a provider reports the user's inference allowance exhausted, nothing
 * stopped the worker from trying again: the generator exits, and the very next
 * captured tool call runs `ensureGeneratorRunning`, which starts a fresh
 * generator, sends one more request, and earns the same refusal. There is one
 * doomed request per observation, for the rest of the billing cycle — 11 capped
 * users produced tens of thousands of cap events in a single day, roughly a
 * hundred per successful observation.
 *
 * `ensureGeneratorRunning` already has exactly this gate for a missing Claude
 * CLI (`setup_required` + `CLAUDE_CLI_SETUP_RECHECK_COOLDOWN_MS`). This is the
 * same shape for quota, kept separate because quota is per-provider user state
 * rather than a machine-wide dependency.
 *
 * The breaker arms on a quota-exhausted generator exit, expires after a
 * cooldown so a single request can re-probe, and clears immediately on success
 * — so recovery costs at most one cooldown window, not a manual restart.
 */

export type QuotaProvider = 'claude' | 'gemini' | 'openrouter';

/**
 * How long to withhold requests after a provider reports the allowance spent.
 * Long enough that a capped user stops generating traffic, short enough that a
 * reset window (or a plan upgrade) is picked up without restarting the worker.
 */
export const QUOTA_EXHAUSTED_RECHECK_COOLDOWN_MS = 30 * 60_000;

/**
 * How long a claimed probe may stay unresolved before another caller may take
 * it. A generator that dies without reaching any completion path would
 * otherwise hold the claim forever and wedge the provider permanently — the
 * opposite failure to the one this breaker exists to prevent.
 */
export const QUOTA_PROBE_STALE_MS = 5 * 60_000;

export interface QuotaCooldownState {
  provider: QuotaProvider;
  /** Provider-reported reason, already free of any user prompt text. */
  message: string;
  /** Window the provider named, when it named one (e.g. 'weekly'). */
  window?: string;
  armedAtMs: number;
  /**
   * When the single post-expiry probe was claimed, or null when none is in
   * flight. Without this the expiry check is a bare read: every concurrent
   * session passes it at once and they all hit the provider together, which on
   * a busy machine (#3800 saw 28-69 live sessions) turns "one probe per window"
   * back into a burst.
   */
  probeInFlightSinceMs: number | null;
}

const cooldowns = new Map<QuotaProvider, QuotaCooldownState>();

/** Arm the breaker for `provider`. Re-arming restamps the cooldown. */
export function recordQuotaExhausted(
  provider: QuotaProvider,
  message: string,
  window?: string,
): QuotaCooldownState {
  const state: QuotaCooldownState = {
    provider,
    message,
    ...(window ? { window } : {}),
    armedAtMs: Date.now(),
    // Re-arming ends whatever probe was in flight: this IS that probe failing.
    probeInFlightSinceMs: null,
  };
  cooldowns.set(provider, state);
  return state;
}

/** Clear the breaker — call on any successful generation for that provider. */
export function clearQuotaCooldown(provider: QuotaProvider): void {
  cooldowns.delete(provider);
}

export function getQuotaCooldown(provider: QuotaProvider): QuotaCooldownState | null {
  return cooldowns.get(provider) ?? null;
}

/**
 * True while requests to `provider` should be withheld. Read-only — it never
 * claims the probe, so it is safe for logging and diagnostics.
 *
 * Callers deciding whether to actually send must use `tryAdmitQuotaProbe`
 * instead: this returning false only means the window elapsed, and on a machine
 * with many live sessions every one of them observes that at the same instant.
 */
export function isQuotaCooldownActive(
  provider: QuotaProvider,
  nowMs: number = Date.now(),
  cooldownMs: number = QUOTA_EXHAUSTED_RECHECK_COOLDOWN_MS,
): boolean {
  const state = cooldowns.get(provider);
  if (!state) return false;
  return nowMs - state.armedAtMs < cooldownMs;
}

/**
 * Decide whether this caller may send to `provider`, claiming the single
 * post-expiry probe if so.
 *
 * Admits when there is no breaker at all, or when the window has elapsed and no
 * probe is currently in flight. The claim is taken synchronously, so among
 * concurrent callers on this single-threaded worker exactly one wins and the
 * rest are withheld until that probe resolves — success clears the breaker,
 * failure re-arms it, and `releaseQuotaProbe` covers every other exit.
 */
export function tryAdmitQuotaProbe(
  provider: QuotaProvider,
  nowMs: number = Date.now(),
  cooldownMs: number = QUOTA_EXHAUSTED_RECHECK_COOLDOWN_MS,
): boolean {
  const state = cooldowns.get(provider);
  if (!state) return true;

  if (nowMs - state.armedAtMs < cooldownMs) {
    return false;
  }

  const inFlight = state.probeInFlightSinceMs;
  if (inFlight !== null && nowMs - inFlight < QUOTA_PROBE_STALE_MS) {
    return false;
  }

  state.probeInFlightSinceMs = nowMs;
  return true;
}

/**
 * Release a claimed probe without deciding the breaker's fate.
 *
 * Called on every generator exit: if the probe succeeded the breaker is already
 * gone, and if it earned another refusal `recordQuotaExhausted` already re-armed
 * and cleared the claim. This covers the remaining exits (abort, crash, an
 * unrelated error) so a claim can never outlive the request that took it.
 */
export function releaseQuotaProbe(provider: QuotaProvider): void {
  const state = cooldowns.get(provider);
  if (state) {
    state.probeInFlightSinceMs = null;
  }
}

export function resetQuotaCooldownsForTesting(): void {
  cooldowns.clear();
}
