/**
 * The one provider-dispatch rule, shared by SessionRoutes (generator start)
 * and worker-service (getAiStatus) — previously duplicated in both.
 *
 * Semantics: openrouter wins when selected AND a key exists; else gemini when
 * selected AND a key exists; else claude (silent fall-through, unchanged).
 *
 * Trial-expiry fallback (plan 2026-08-26 Phase 6): when the selected
 * openrouter config points at the cmem.ai gateway AND a terminal quota/key
 * failure has been recorded (CLAUDE_MEM_PRO_FALLBACK_AT non-empty), dispatch
 * returns the installer-chosen fallback provider during a cooldown
 * (CLAUDE_MEM_FALLBACK_PROVIDER: 'claude' by default, 'gemini' with a key, or
 * 'none' to hold work on the armed quota breaker instead) — memory runs
 * off-gateway, as the installer promised. It then permits a periodic gateway probe
 * so subscribing can recover automatically. User-owned openrouter.ai (or any
 * non-gateway) base URLs ignore the fallback marker entirely.
 */

import { SettingsDefaultsManager, type SettingsDefaults } from '../../shared/SettingsDefaultsManager.js';
import { paths } from '../../shared/paths.js';
import { logger } from '../../utils/logger.js';
import { isCmemGatewayUrl, writeProFallbackAt } from '../../shared/cmem-gateway.js';
import { isGeminiAvailable, isGeminiSelected } from './GeminiProvider.js';
import { isOpenRouterAvailable, isOpenRouterSelected } from './OpenRouterProvider.js';
import type { ClassifiedProviderError } from './provider-errors.js';
import { recordQuotaExhausted, releaseQuotaProbe, tryAdmitQuotaProbe } from '../../shared/quota-cooldown.js';

/** Retry a fallen-back gateway occasionally so a later subscription recovers. */
export const CMEM_FALLBACK_RETRY_MS = 15 * 60_000;

export function shouldUseCmemFallback(
  fallbackAt: string | undefined | null,
  nowMs: number = Date.now(),
): boolean {
  const timestamp = Date.parse((fallbackAt ?? '').trim());
  if (Number.isNaN(timestamp)) return Boolean((fallbackAt ?? '').trim());
  const age = nowMs - timestamp;
  return age >= 0 && age < CMEM_FALLBACK_RETRY_MS;
}

/**
 * A dispatch decision, plus any gateway re-probe claim it took.
 *
 * `gatewayProbeClaimId` is non-null only for the single caller admitted to
 * re-probe the cmem gateway after its fallback window elapsed. It must be
 * handed back to `releaseCmemGatewayProbe` when that run ends.
 */
export interface ProviderSelection {
  provider: 'claude' | 'gemini' | 'openrouter';
  gatewayProbeClaimId: number | null;
}

/**
 * The provider the installer's prompt chose for the trial-expiry fallback
 * (CLAUDE_MEM_FALLBACK_PROVIDER): where memory runs while the fallback marker
 * is active. 'claude' — the Anthropic plan (the default, and the behavior
 * before the choice existed); 'gemini' — honored only when a Gemini key is
 * actually available; 'none' (or 'gemini' without a key) — null: no diversion.
 * A null keeps dispatch on 'openrouter', where the provider quota breaker
 * armed by the same terminal stop is what holds sends — deliberately no
 * second hold here.
 */
function resolveCmemFallbackProvider(settings: SettingsDefaults): 'claude' | 'gemini' | null {
  const choice = (settings.CLAUDE_MEM_FALLBACK_PROVIDER ?? '').trim();
  if (choice === 'gemini') return isGeminiAvailable() ? 'gemini' : null;
  if (choice === 'none') return null;
  return 'claude';
}

/**
 * Read-only dispatch, for diagnostics and status. Never claims a probe, so it
 * is safe to call from anywhere — but a caller about to actually SEND must use
 * `selectProviderForGenerator` instead, or it becomes part of the herd.
 */
export function getSelectedProvider(): 'claude' | 'gemini' | 'openrouter' {
  if (isOpenRouterSelected() && isOpenRouterAvailable()) {
    const settings = SettingsDefaultsManager.loadFromFile(paths.settings());
    if (
      settings.CLAUDE_MEM_PRO_FALLBACK_AT
      && isCmemGatewayUrl(settings.CLAUDE_MEM_OPENROUTER_BASE_URL)
      && shouldUseCmemFallback(settings.CLAUDE_MEM_PRO_FALLBACK_AT)
    ) {
      const fallback = resolveCmemFallbackProvider(settings);
      if (fallback) return fallback;
    }
    return 'openrouter';
  }
  return (isGeminiSelected() && isGeminiAvailable()) ? 'gemini' : 'claude';
}

/**
 * Dispatch for a caller that is about to start a generator, claiming the single
 * post-cooldown gateway re-probe.
 *
 * The expiry check alone is a bare clock read, and the marker it reads is on
 * DISK — so every process parses the same ISO string and computes the same
 * expiry instant. On a busy machine (#3800 saw 28-69 live sessions) they all
 * observe the window elapse together and hit the gateway at once, which is the
 * same burst the quota breaker exists to prevent, relocated. Worse, each of
 * those failures does a read-modify-write of the user's whole settings.json to
 * re-arm the marker, so a concurrent settings edit can be clobbered.
 *
 * Claiming makes it what the comment always said it was: exactly one probe.
 * It reuses the quota breaker's claim machinery under a DISTINCT key, because
 * `tryAdmitQuotaProbe` takes the cooldown per call and this path's period
 * (15 min) differs from the provider breaker's (30 min) — pointing both at one
 * key would let two callers reach contradictory answers about whether the same
 * breaker is armed.
 */
export function selectProviderForGenerator(): ProviderSelection {
  if (isOpenRouterSelected() && isOpenRouterAvailable()) {
    const settings = SettingsDefaultsManager.loadFromFile(paths.settings());
    if (settings.CLAUDE_MEM_PRO_FALLBACK_AT && isCmemGatewayUrl(settings.CLAUDE_MEM_OPENROUTER_BASE_URL)) {
      const fallback = resolveCmemFallbackProvider(settings);
      if (fallback === null) {
        // Fallback 'none' (or gemini without a key): no diversion and no
        // gateway re-probe claim — dispatch stays on openrouter, and the
        // provider quota breaker armed by the terminal stop holds sends.
        return { provider: 'openrouter', gatewayProbeClaimId: null };
      }
      if (shouldUseCmemFallback(settings.CLAUDE_MEM_PRO_FALLBACK_AT)) {
        return { provider: fallback, gatewayProbeClaimId: null };
      }
      // Window elapsed: exactly one caller re-probes the gateway, the rest stay
      // on the fallback provider until that probe resolves.
      const admission = tryAdmitQuotaProbe('cmem-gateway', Date.now(), CMEM_FALLBACK_RETRY_MS);
      if (!admission.admitted) {
        return { provider: fallback, gatewayProbeClaimId: null };
      }
      return { provider: 'openrouter', gatewayProbeClaimId: admission.claimId };
    }
    return { provider: 'openrouter', gatewayProbeClaimId: null };
  }
  return {
    provider: (isGeminiSelected() && isGeminiAvailable()) ? 'gemini' : 'claude',
    gatewayProbeClaimId: null,
  };
}

/** Release a gateway re-probe claim taken by `selectProviderForGenerator`. */
export function releaseCmemGatewayProbe(claimId: number | null): void {
  releaseQuotaProbe('cmem-gateway', claimId);
}

/**
 * Record the trial-expiry fallback when an OpenRouter generator failure is the
 * cmem gateway saying the delivered key is no longer funded/valid. Returns
 * true when the failure was consumed as a handled fallback — the caller must
 * then NOT feed the observer-health ledger (the provider switch is the remedy;
 * there is no outage to warn about).
 *
 * Eligible errors are the terminal gateway rejections only: kind
 * 'quota_exhausted' (gateway code allowance_exhausted, or a legacy 402) and
 * gateway codes 'key_invalid' and 'subscription_inactive' — the last is the
 * expired/cancelled trial, the very case the installer's fallback promise is
 * for. Rate limits, transient upstream errors, and every failure on a
 * non-gateway base URL (a personal openrouter.ai key running dry) stay on the
 * existing outage-warning path.
 */
export function recordCmemFallbackIfEligible(
  error: ClassifiedProviderError,
  settingsPath: string = paths.settings(),
): boolean {
  if (
    error.kind !== 'quota_exhausted'
    && error.code !== 'key_invalid'
    && error.code !== 'subscription_inactive'
  ) {
    return false;
  }
  const settings = SettingsDefaultsManager.loadFromFile(settingsPath);
  if (!isCmemGatewayUrl(settings.CLAUDE_MEM_OPENROUTER_BASE_URL)) {
    return false;
  }
  const fallbackAt = new Date().toISOString();
  try {
    writeProFallbackAt(fallbackAt, settingsPath);
  } catch (writeError: unknown) {
    // If the marker cannot be persisted, do not claim the provider failure was
    // handled. The caller keeps the original failure on the observer-health
    // path, while this diagnostic explains why automatic fallback did not arm.
    logger.warn(
      'SESSION',
      'Could not persist cmem trial-expiry fallback; retaining normal provider failure handling',
      { kind: error.kind, ...(error.code ? { code: error.code } : {}) },
      writeError instanceof Error ? writeError : new Error(String(writeError)),
    );
    // Even unhandled, a definitive terminal stop must not be re-bought by the
    // very next observation. With no marker on disk, dispatch would stay on
    // openrouter, and the caller's own breaker arming covers only the
    // quota_exhausted kind — so arm it here for every eligible terminal code
    // (re-arming from the caller merely restamps the same cooldown).
    recordQuotaExhausted('openrouter', describeCmemTerminalStop(error));
    return false;
  }
  // No usable fallback (choice 'none', or 'gemini' without a key): the marker
  // cannot hold dispatch — selectProviderForGenerator's null-fallback branch
  // stays on openrouter — so arm the provider quota breaker instead. One hold
  // mechanism per path: divertable fallback → the marker; null fallback → the
  // breaker (whose own cooldown then admits the single re-probe).
  if (resolveCmemFallbackProvider(settings) === null) {
    recordQuotaExhausted('openrouter', describeCmemTerminalStop(error));
  }
  logger.info('SESSION', 'Recorded cmem trial-expiry fallback; dispatch honors the configured fallback provider', {
    kind: error.kind,
    ...(error.code ? { code: error.code } : {}),
    fallbackAt,
  });
  return true;
}

/** Breaker message for a terminal cmem gateway stop with no usable fallback. */
function describeCmemTerminalStop(error: ClassifiedProviderError): string {
  return error.code
    ? `cmem gateway terminal stop (${error.code})`
    : `cmem gateway terminal stop: ${error.message}`;
}
