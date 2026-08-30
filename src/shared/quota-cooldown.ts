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

export interface QuotaCooldownState {
  provider: QuotaProvider;
  /** Provider-reported reason, already free of any user prompt text. */
  message: string;
  /** Window the provider named, when it named one (e.g. 'weekly'). */
  window?: string;
  armedAtMs: number;
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
 * True while requests to `provider` should be withheld.
 *
 * Once the window elapses this returns false without clearing the state, so
 * exactly one probe request goes out; it re-arms on failure (restamping the
 * cooldown) or is cleared by the success path.
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

export function resetQuotaCooldownsForTesting(): void {
  cooldowns.clear();
}
