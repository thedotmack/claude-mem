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
import { QUOTA_PROBE_STALE_MS } from '../../shared/quota-cooldown.js';

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
      return 'claude';
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
 * The claim is kept here, not in the quota breaker's map. That map admits
 * every caller claim-free when no breaker is armed, and nothing arms one for
 * the gateway — the marker IS its window — so routing the claim through it
 * admitted the whole herd. Arming a breaker instead would persist it and
 * mirror it into observer-health as "claude-mem is paused", which is false
 * while the fallback keeps memory running on the Anthropic plan.
 */
export function selectProviderForGenerator(): ProviderSelection {
  if (isOpenRouterSelected() && isOpenRouterAvailable()) {
    const settings = SettingsDefaultsManager.loadFromFile(paths.settings());
    if (settings.CLAUDE_MEM_PRO_FALLBACK_AT && isCmemGatewayUrl(settings.CLAUDE_MEM_OPENROUTER_BASE_URL)) {
      if (shouldUseCmemFallback(settings.CLAUDE_MEM_PRO_FALLBACK_AT)) {
        return { provider: 'claude', gatewayProbeClaimId: null };
      }
      // Window elapsed: exactly one caller re-probes the gateway, the rest stay
      // on the Anthropic plan until that probe resolves — a failure re-arms
      // the marker, a success clears it, and every exit releases the claim.
      const claimId = claimCmemGatewayProbe(Date.now());
      if (claimId === null) {
        return { provider: 'claude', gatewayProbeClaimId: null };
      }
      return { provider: 'openrouter', gatewayProbeClaimId: claimId };
    }
    return { provider: 'openrouter', gatewayProbeClaimId: null };
  }
  return {
    provider: (isGeminiSelected() && isGeminiAvailable()) ? 'gemini' : 'claude',
    gatewayProbeClaimId: null,
  };
}

/**
 * The gateway re-probe in flight, or null. In-memory only, like the quota
 * breaker's own claim: a restart kills the generator that held it, and the
 * window it guards is the marker on disk, which survives.
 */
let gatewayProbe: { claimId: number; claimedAtMs: number } | null = null;
let nextGatewayProbeClaimId = 1;

/** Claim the single gateway re-probe; null while another is in flight. */
function claimCmemGatewayProbe(nowMs: number): number | null {
  // A holder that never released within the stale window is presumed dead, so
  // a lost claim cannot wedge the gateway shut. The takeover mints a fresh id:
  // the abandoned owner's late release then finds a claim it does not own.
  if (gatewayProbe !== null && nowMs - gatewayProbe.claimedAtMs < QUOTA_PROBE_STALE_MS) {
    return null;
  }
  gatewayProbe = { claimId: nextGatewayProbeClaimId++, claimedAtMs: nowMs };
  return gatewayProbe.claimId;
}

/**
 * Release a gateway re-probe claim taken by `selectProviderForGenerator`.
 * Scoped to the caller's own claim: null (a claim-free run) or an id that was
 * since taken over releases nothing.
 */
export function releaseCmemGatewayProbe(claimId: number | null): void {
  if (claimId !== null && gatewayProbe?.claimId === claimId) {
    gatewayProbe = null;
  }
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
