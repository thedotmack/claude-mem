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
 * returns 'claude' during a cooldown — memory runs on the user's Anthropic
 * plan, as the installer promised. It then permits a periodic gateway probe
 * so subscribing can recover automatically. User-owned openrouter.ai (or any
 * non-gateway) base URLs ignore the fallback marker entirely.
 */

import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { paths } from '../../shared/paths.js';
import { logger } from '../../utils/logger.js';
import { isCmemGatewayUrl, writeProFallbackAt } from '../../shared/cmem-gateway.js';
import { isGeminiAvailable, isGeminiSelected } from './GeminiProvider.js';
import { isOpenRouterAvailable, isOpenRouterSelected } from './OpenRouterProvider.js';
import type { ClassifiedProviderError } from './provider-errors.js';

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

export function getSelectedProvider(): 'claude' | 'gemini' | 'openrouter' {
  if (isOpenRouterSelected() && isOpenRouterAvailable()) {
    const settings = SettingsDefaultsManager.loadFromFile(paths.settings());
    if (
      settings.CLAUDE_MEM_PRO_FALLBACK_AT
      && isCmemGatewayUrl(settings.CLAUDE_MEM_OPENROUTER_BASE_URL)
      && shouldUseCmemFallback(settings.CLAUDE_MEM_PRO_FALLBACK_AT)
    ) {
      return 'claude';
    }
    // Once the cooldown elapses, allow one normal gateway request as a probe.
    // Success clears the marker in OpenRouterProvider; another terminal
    // rejection refreshes the timestamp below and resumes Claude fallback.
    return 'openrouter';
  }
  return (isGeminiSelected() && isGeminiAvailable()) ? 'gemini' : 'claude';
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
 * gateway code 'key_invalid'. Rate limits, transient upstream errors, and
 * every failure on a non-gateway base URL (a personal openrouter.ai key
 * running dry) stay on the existing outage-warning path.
 */
export function recordCmemFallbackIfEligible(
  error: ClassifiedProviderError,
  settingsPath: string = paths.settings(),
): boolean {
  if (error.kind !== 'quota_exhausted' && error.code !== 'key_invalid') {
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
    return false;
  }
  logger.info('SESSION', 'Recorded cmem trial-expiry fallback; dispatch switches to the Claude provider', {
    kind: error.kind,
    ...(error.code ? { code: error.code } : {}),
    fallbackAt,
  });
  return true;
}
