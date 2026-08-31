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
import {
  isCmemGatewayRequest,
  isProFallbackProbeDue,
  writeProFallbackAt,
} from '../../shared/cmem-gateway.js';
import { isGeminiAvailable, isGeminiSelected } from './GeminiProvider.js';
import { isOpenRouterAvailable, isOpenRouterSelected } from './OpenRouterProvider.js';
import type { ClassifiedProviderError } from './provider-errors.js';

export interface ProviderSelectionOptions {
  /** Only generator dispatch may claim a recovery probe; status reads may not. */
  claimFallbackProbe?: boolean;
  /** Test seam. */
  nowMs?: number;
  /** Test seam; production uses the shared settings path. */
  settingsPath?: string;
}

function isConfiguredCmemGateway(settings: ReturnType<typeof SettingsDefaultsManager.loadFromFile>): boolean {
  return isCmemGatewayRequest(settings.CLAUDE_MEM_OPENROUTER_BASE_URL, {
    apiKey: settings.CLAUDE_MEM_OPENROUTER_API_KEY,
    deliveredBaseUrl: settings.CLAUDE_MEM_PRO_GATEWAY_BASE_URL,
    deliveredKeyHash: settings.CLAUDE_MEM_PRO_GATEWAY_KEY_HASH,
  });
}

export function getSelectedProvider(
  options: ProviderSelectionOptions = {},
): 'claude' | 'gemini' | 'openrouter' {
  if (isOpenRouterSelected() && isOpenRouterAvailable()) {
    const settingsPath = options.settingsPath ?? paths.settings();
    const settings = SettingsDefaultsManager.loadFromFile(settingsPath);
    if (settings.CLAUDE_MEM_PRO_FALLBACK_AT && isConfiguredCmemGateway(settings)) {
      const nowMs = options.nowMs ?? Date.now();
      if (!options.claimFallbackProbe || !isProFallbackProbeDue(settings.CLAUDE_MEM_PRO_FALLBACK_AT, nowMs)) {
        return 'claude';
      }
      // Claim before starting the generator. A success clears the marker; a
      // terminal failure refreshes it; a transient failure waits one interval
      // before another attempt instead of creating a retry storm.
      writeProFallbackAt(new Date(nowMs).toISOString(), settingsPath);
      logger.info('SESSION', 'Probing cmem gateway after fallback interval');
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
  if (!isConfiguredCmemGateway(settings)) {
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
