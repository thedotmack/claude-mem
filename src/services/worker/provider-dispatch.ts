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
 * returns 'claude' instead of attempting the dead key — memory runs on the
 * user's Anthropic plan, as the installer promised. User-owned openrouter.ai
 * (or any non-gateway) base URLs ignore the fallback marker entirely.
 */

import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { paths } from '../../shared/paths.js';
import { logger } from '../../utils/logger.js';
import { isCmemGatewayUrl, writeProFallbackAt } from '../../shared/cmem-gateway.js';
import { isGeminiAvailable, isGeminiSelected } from './GeminiProvider.js';
import { isOpenRouterAvailable, isOpenRouterSelected } from './OpenRouterProvider.js';
import type { ClassifiedProviderError } from './provider-errors.js';

export function getSelectedProvider(): 'claude' | 'gemini' | 'openrouter' {
  if (isOpenRouterSelected() && isOpenRouterAvailable()) {
    const settings = SettingsDefaultsManager.loadFromFile(paths.settings());
    if (settings.CLAUDE_MEM_PRO_FALLBACK_AT && isCmemGatewayUrl(settings.CLAUDE_MEM_OPENROUTER_BASE_URL)) {
      return 'claude';
    }
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
  writeProFallbackAt(fallbackAt, settingsPath);
  logger.info('SESSION', 'Recorded cmem trial-expiry fallback; dispatch switches to the Claude provider', {
    kind: error.kind,
    ...(error.code ? { code: error.code } : {}),
    fallbackAt,
  });
  return true;
}
