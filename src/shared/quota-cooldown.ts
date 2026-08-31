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
  /**
   * Identifies the claim currently in flight, so only the caller that took it
   * can release it. A generator admitted while no breaker existed holds no
   * claim at all; without this id its exit would clear whatever probe a later
   * session had since started, readmitting a third session while the real
   * probe is still running.
   */
  probeClaimId: number | null;
}

/**
 * The result of an admission attempt. `claimId` is null on an admission that
 * took no claim — there was no breaker to claim against — and releasing must be
 * keyed on it rather than on "I was admitted", because such a generator can
 * outlive a later session's real probe.
 */
export interface QuotaProbeAdmission {
  admitted: boolean;
  claimId: number | null;
}

const cooldowns = new Map<QuotaProvider, QuotaCooldownState>();

/**
 * Monotonic id for probe claims, only ever compared for equality. A claim's
 * timestamp cannot double as its identity: the testing seams admit repeat
 * claims inside a single millisecond, and two claims sharing an id would
 * reintroduce exactly the cross-session release this exists to prevent.
 */
let nextProbeClaimId = 1;

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
    probeClaimId: null,
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
 *
 * An admission with no breaker in place carries a null `claimId`: it owns no
 * probe, and passing that null back to `releaseQuotaProbe` is what stops such a
 * generator from clearing a probe some later session claimed while it ran.
 */
export function tryAdmitQuotaProbe(
  provider: QuotaProvider,
  nowMs: number = Date.now(),
  cooldownMs: number = QUOTA_EXHAUSTED_RECHECK_COOLDOWN_MS,
): QuotaProbeAdmission {
  const state = cooldowns.get(provider);
  if (!state) return { admitted: true, claimId: null };

  if (nowMs - state.armedAtMs < cooldownMs) {
    return { admitted: false, claimId: null };
  }

  const inFlight = state.probeInFlightSinceMs;
  if (inFlight !== null && nowMs - inFlight < QUOTA_PROBE_STALE_MS) {
    return { admitted: false, claimId: null };
  }

  // A stale takeover mints a fresh id, so the abandoned owner's late release
  // finds a claim it does not own and leaves this one alone.
  const claimId = nextProbeClaimId++;
  state.probeInFlightSinceMs = nowMs;
  state.probeClaimId = claimId;
  return { admitted: true, claimId };
}

/**
 * Release the probe this run claimed, without deciding the breaker's fate.
 *
 * Called on every generator exit: if the probe succeeded the breaker is already
 * gone, and if it earned another refusal `recordQuotaExhausted` already re-armed
 * and cleared the claim. This covers the remaining exits (abort, crash, an
 * unrelated error) so a claim can never outlive the request that took it.
 *
 * `claimId` scopes that to the caller's own claim. Generators overlap freely —
 * one admitted before any breaker existed can exit long after a later session
 * claimed the sole post-cooldown probe — so an unscoped release would clear a
 * probe still in flight and admit a third session behind it.
 */
export function releaseQuotaProbe(provider: QuotaProvider, claimId: number | null): void {
  // Admitted with no breaker armed: this run never owned a probe, and any probe
  // in flight now belongs to a different session.
  if (claimId === null) return;

  const state = cooldowns.get(provider);
  if (state && state.probeClaimId === claimId) {
    state.probeInFlightSinceMs = null;
    state.probeClaimId = null;
  }
}

export function resetQuotaCooldownsForTesting(): void {
  cooldowns.clear();
}
