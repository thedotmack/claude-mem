// SPDX-License-Identifier: Apache-2.0

/**
 * In-memory circuit breaker for provider inference-allowance exhaustion.
 *
 * When a provider reports its inference allowance is spent — a classified
 * `quota_exhausted` error, e.g. the cmem.ai Pro gateway returning
 * `allowance_exhausted` once the billing-cycle cap is reached — the worker stops
 * issuing inference requests to that provider for a cooldown window.
 *
 * Without the breaker the worker starts a fresh generator for every observation
 * (see SessionRoutes.ensureGeneratorRunning), and each generator issues one
 * request that earns the same cap. Every capped request makes the gateway emit
 * one cap event, so a single capped user produces a flood of identical cap
 * events for the whole billing cycle. The breaker collapses that to at most one
 * probe per cooldown window per provider.
 *
 * The gate lives in the worker and mirrors the Claude setup-required gate in
 * dependency-health.ts: skip while the cooldown is active, let one probe through
 * once it expires, and clear on a successful store. In-memory (not file-backed)
 * is enough — the state only needs to survive within one long-lived worker
 * process, and a restart re-probes at most once per provider.
 */

export interface QuotaCooldownState {
  /** Provider whose allowance is exhausted ('openrouter' | 'gemini' | 'claude'). */
  provider: string;
  /** Scrubbed provider message, for the skip log line. */
  message: string;
  /** Epoch ms the breaker was armed. */
  recordedAtMs: number;
}

/**
 * How long to wait before letting one request re-probe a provider that reported
 * its inference allowance exhausted. A cap typically holds until the next
 * billing cycle, so a long window keeps re-probes rare. The window is only an
 * upper bound on recovery latency: a probe that succeeds (the user topped up, or
 * the cycle rolled over) clears the breaker immediately.
 */
export const QUOTA_EXHAUSTED_RECHECK_COOLDOWN_MS = 30 * 60_000; // 30 minutes

const cooldowns = new Map<string, QuotaCooldownState>();

export function recordQuotaExhausted(provider: string, message: string): QuotaCooldownState {
  const state: QuotaCooldownState = { provider, message, recordedAtMs: Date.now() };
  cooldowns.set(provider, state);
  return state;
}

export function getQuotaCooldown(provider: string): QuotaCooldownState | null {
  return cooldowns.get(provider) ?? null;
}

export function isQuotaCooldownActive(
  state: QuotaCooldownState,
  cooldownMs: number,
  nowMs: number = Date.now(),
): boolean {
  return nowMs - state.recordedAtMs < cooldownMs;
}

export function clearQuotaCooldown(provider: string): void {
  cooldowns.delete(provider);
}

export function resetQuotaCooldownsForTesting(): void {
  cooldowns.clear();
}
