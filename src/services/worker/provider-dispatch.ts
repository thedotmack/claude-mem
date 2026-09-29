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
 *
 * Quota fallback (CLAUDE_MEM_QUOTA_FALLBACK_PROVIDER): while the selected
 * provider's quota breaker is holding, every plain return is routed to the
 * configured fallback, provided it has credentials and is not itself holding.
 * Empty — the default — leaves dispatch exactly as it was. The cmem-gateway
 * branch keeps its own marker and runs first, untouched.
 */

import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { paths } from '../../shared/paths.js';
import { logger } from '../../utils/logger.js';
import { isCmemGatewayUrl, writeProFallbackAt } from '../../shared/cmem-gateway.js';
import { isGeminiAvailable, isGeminiSelected } from './GeminiProvider.js';
import { isOpenRouterAvailable, isOpenRouterSelected } from './OpenRouterProvider.js';
import type { ClassifiedProviderError } from './provider-errors.js';
import {
  getQuotaCooldown,
  isQuotaCooldownHolding,
  releaseQuotaProbe,
  setQuotaFallbackResolver,
  tryAdmitQuotaProbe,
  type QuotaProvider,
} from '../../shared/quota-cooldown.js';

/** Retry a fallen-back gateway occasionally so a later subscription recovers. */
export const CMEM_FALLBACK_RETRY_MS = 15 * 60_000;

export type DispatchProvider = 'claude' | 'gemini' | 'openrouter';

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
  provider: DispatchProvider;
  gatewayProbeClaimId: number | null;
  /**
   * The provider this selection stands in for when the quota fallback routed
   * around it, else null. Optional so callers and test doubles that build a
   * selection by hand stay valid — read it loosely (`!= null`).
   */
  fallbackFrom?: DispatchProvider | null;
}

const QUOTA_FALLBACK_PROVIDERS: readonly string[] = ['claude', 'gemini', 'openrouter'];

/** The configured quota fallback, or null when the setting is empty or unrecognised. */
export function readQuotaFallbackProvider(): DispatchProvider | null {
  const settings = SettingsDefaultsManager.loadFromFile(paths.settings());
  const raw = (settings.CLAUDE_MEM_QUOTA_FALLBACK_PROVIDER ?? '').trim();
  return QUOTA_FALLBACK_PROVIDERS.includes(raw) ? raw as DispatchProvider : null;
}

/**
 * Whether a fallback has what it needs to run. Claude counts as available
 * here: when dispatch returns it, the Claude setup check in SessionRoutes runs
 * exactly as it does for a Claude primary.
 */
function isFallbackAvailable(provider: DispatchProvider): boolean {
  if (provider === 'gemini') return isGeminiAvailable();
  if (provider === 'openrouter') return isOpenRouterAvailable();
  return true;
}

/**
 * Where work for `primary` may go while `primary` is held: the configured
 * fallback, when it is a different provider, has credentials, and is not
 * itself holding. Null otherwise — including when nothing is configured.
 *
 * Read-only: it never claims a probe. Keyed on the provider being routed
 * around, so a provider can never be offered as its own fallback; the resume
 * after a quota exit relies on that to stop after one hop.
 */
export function quotaFallbackTarget(
  primary: QuotaProvider,
  nowMs: number = Date.now(),
): DispatchProvider | null {
  const fallback = readQuotaFallbackProvider();
  if (fallback === null || fallback === primary) return null;
  if (!isFallbackAvailable(fallback)) return null;
  if (isQuotaCooldownHolding(fallback, nowMs)) return null;
  return fallback;
}

interface RoutedProvider {
  provider: DispatchProvider;
  fallbackFrom: DispatchProvider | null;
}

/**
 * The shared rule for every plain dispatch return: keep `primary` unless its
 * breaker is holding AND the fallback can serve. When both are exhausted this
 * returns `primary`, and admission refuses it exactly as it does today.
 */
function applyQuotaFallback(primary: DispatchProvider, nowMs: number = Date.now()): RoutedProvider {
  if (!isQuotaCooldownHolding(primary, nowMs)) return { provider: primary, fallbackFrom: null };
  const fallback = quotaFallbackTarget(primary, nowMs);
  return fallback === null
    ? { provider: primary, fallbackFrom: null }
    : { provider: fallback, fallbackFrom: primary };
}

type QuotaFallbackState = 'primary' | 'fallback' | 'probing' | 'blocked';

/**
 * Last state logged by `selectProviderForGenerator`. Module-level because
 * dispatch runs on every generator start and on the Telegram wrap-up: the log
 * is one line per CHANGE, never one per call.
 */
let quotaFallbackState: QuotaFallbackState = 'primary';

function noteQuotaFallbackTransition(primary: DispatchProvider, routed: RoutedProvider): void {
  let next: QuotaFallbackState;
  if (routed.fallbackFrom != null) next = 'fallback';
  else if (isQuotaCooldownHolding(primary)) next = 'blocked';
  else if (getQuotaCooldown(primary) !== null) next = 'probing';
  else next = 'primary';
  if (next === quotaFallbackState) return;
  quotaFallbackState = next;

  switch (next) {
    case 'fallback':
      logger.warn('SESSION', 'Primary in quota cooldown; dispatching to fallback', {
        primary,
        fallback: routed.provider,
      });
      return;
    case 'probing':
      logger.info('SESSION', 'Primary quota cooldown elapsed; probing primary', { primary });
      return;
    case 'blocked': {
      // Distinct from probing: nothing is being probed and nothing can take
      // the work. Name the real cause — the fallback may be holding too, or it
      // may simply be unable to serve (no credentials, or equal to the primary).
      const fallback = readQuotaFallbackProvider();
      if (fallback !== null && fallback !== primary && isQuotaCooldownHolding(fallback)) {
        logger.warn('SESSION', 'Primary and fallback both in quota cooldown; capture waits until one clears', { primary, fallback });
      } else {
        logger.warn('SESSION', 'Primary in quota cooldown and the quota fallback cannot serve; capture waits until it clears', { primary, fallback });
      }
      return;
    }
    case 'primary':
      logger.info('SESSION', 'Primary recovered from quota cooldown', { primary });
      return;
  }
}

/**
 * A plain (non-gateway-fallback) selection for a caller about to send. The
 * transition log is only kept when a fallback is configured, so an install
 * that configures nothing logs nothing new.
 */
function selectWithQuotaFallback(primary: DispatchProvider): ProviderSelection {
  const routed = applyQuotaFallback(primary);
  if (readQuotaFallbackProvider() !== null) {
    noteQuotaFallbackTransition(primary, routed);
  }
  return { provider: routed.provider, gatewayProbeClaimId: null, fallbackFrom: routed.fallbackFrom };
}

/** Test seam: forget the last logged quota-fallback state. */
export function resetQuotaFallbackStateForTesting(): void {
  quotaFallbackState = 'primary';
}

/**
 * Read-only dispatch, for diagnostics and status. Never claims a probe, so it
 * is safe to call from anywhere — but a caller about to actually SEND must use
 * `selectProviderForGenerator` instead, or it becomes part of the herd.
 */
export function getSelectedProvider(): DispatchProvider {
  if (isOpenRouterSelected() && isOpenRouterAvailable()) {
    const settings = SettingsDefaultsManager.loadFromFile(paths.settings());
    if (
      settings.CLAUDE_MEM_PRO_FALLBACK_AT
      && isCmemGatewayUrl(settings.CLAUDE_MEM_OPENROUTER_BASE_URL)
      && shouldUseCmemFallback(settings.CLAUDE_MEM_PRO_FALLBACK_AT)
    ) {
      return 'claude';
    }
    return applyQuotaFallback('openrouter').provider;
  }
  return applyQuotaFallback((isGeminiSelected() && isGeminiAvailable()) ? 'gemini' : 'claude').provider;
}

/**
 * Where memory capture runs while `held` is in a quota cooldown: the provider
 * dispatch is using, when that is a different one and not itself holding.
 * Null otherwise, and always null with no quota fallback configured, so a
 * default install's notice is unchanged.
 *
 * Asks dispatch rather than `quotaFallbackTarget(held)` because the mirrored
 * breaker is simply the latest one armed: after the fallback arms its own and
 * the primary then recovers, the held provider IS the fallback and capture is
 * back on the primary.
 */
function quotaServingProvider(held: QuotaProvider, nowMs: number): DispatchProvider | null {
  if (readQuotaFallbackProvider() === null) return null;
  const serving = getSelectedProvider();
  if (serving === held || isQuotaCooldownHolding(serving, nowMs)) return null;
  return serving;
}

// The session-start notice reads the serving provider from the mirrored
// cooldown in observer-health.json. See setQuotaFallbackResolver for why the
// answer is injected from here rather than imported there.
setQuotaFallbackResolver(quotaServingProvider);

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
      if (shouldUseCmemFallback(settings.CLAUDE_MEM_PRO_FALLBACK_AT)) {
        return { provider: 'claude', gatewayProbeClaimId: null };
      }
      // Window elapsed: exactly one caller re-probes the gateway, the rest stay
      // on the Anthropic plan until that probe resolves.
      const admission = tryAdmitQuotaProbe('cmem-gateway', Date.now(), CMEM_FALLBACK_RETRY_MS);
      if (!admission.admitted) {
        return { provider: 'claude', gatewayProbeClaimId: null };
      }
      return { provider: 'openrouter', gatewayProbeClaimId: admission.claimId };
    }
    return selectWithQuotaFallback('openrouter');
  }
  return selectWithQuotaFallback((isGeminiSelected() && isGeminiAvailable()) ? 'gemini' : 'claude');
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
