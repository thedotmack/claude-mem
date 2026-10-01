/**
 * The one provider-dispatch rule, shared by SessionRoutes (generator start)
 * and worker-service (getAiStatus) — previously duplicated in both.
 *
 * Semantics: openrouter wins when selected AND a key exists; else gemini when
 * selected AND a key exists; else openai-compatible when selected AND fully
 * configured; else claude (silent fall-through, unchanged).
 *
 * Trial-expiry fallback (plan 2026-08-26 Phase 6): when the selected
 * openrouter config points at the cmem.ai gateway AND a terminal gateway
 * rejection has been recorded (CLAUDE_MEM_PRO_FALLBACK_AT non-empty), dispatch
 * returns 'claude' during a cooldown — memory runs on the user's Anthropic
 * plan, as the installer promised. It then permits a periodic gateway probe
 * so subscribing can recover automatically. User-owned openrouter.ai (or any
 * non-gateway) base URLs ignore the fallback marker entirely.
 *
 * Quota fallback (CLAUDE_MEM_QUOTA_FALLBACK_PROVIDER, opt-in): while the
 * selected provider's breaker holds for its quota (a spent allowance, or a
 * rate limit that outlasted its retries), every plain return is routed to the
 * configured fallback, provided it can serve and is not itself held. Empty —
 * the default — leaves dispatch exactly as it was. The cmem-gateway branch
 * keeps its own marker and runs first, untouched.
 */

import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { paths } from '../../shared/paths.js';
import { logger } from '../../utils/logger.js';
import { isCmemGatewayUrl, writeProFallbackAt, type ProFallbackNotice } from '../../shared/cmem-gateway.js';
import { scrubErrorMessage } from '../../shared/observer-health.js';
import { isGeminiAvailable, isGeminiSelected } from './GeminiProvider.js';
import { isOpenRouterAvailable, isOpenRouterSelected } from './OpenRouterProvider.js';
import { isOpenAICompatAvailable, isOpenAICompatSelected } from './OpenAICompatProvider.js';
import { isCodexSelected } from './CodexProvider.js';
import { isClassified, type ClassifiedProviderError } from './provider-errors.js';
import {
  cooldownAppliesToCurrentAccount,
  getQuotaCooldown,
  isQuotaCooldownActive,
  isQuotaCooldownHolding,
  releaseQuotaProbe,
  setQuotaFallbackResolver,
  tryAdmitCmemGatewayProbe,
  type QuotaCooldownState,
  type QuotaProvider,
} from '../../shared/quota-cooldown.js';

/**
 * Every provider dispatch can name. `openai-compatible` is the generic
 * OpenAI-shaped endpoint provider (NVIDIA NIM and friends) — see
 * src/shared/openai-compat-presets.ts for why it is not folded into
 * openrouter.
 */
export type SelectableProvider = 'claude' | 'gemini' | 'openrouter' | 'codex' | 'openai-compatible';

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
 * While a fallback is recorded, whether memory stays on the Anthropic plan
 * with no gateway re-probe: during the fallback window, and for as long as an
 * openrouter breaker still withholds requests after it. That breaker's start
 * gate refuses every gateway run, so a probe admitted into it would run
 * nothing at all, neither on the gateway nor on Claude.
 */
function staysOnClaudeInFallback(fallbackAt: string): boolean {
  return shouldUseCmemFallback(fallbackAt) || isQuotaCooldownActive('openrouter');
}

/**
 * A dispatch decision, plus any gateway re-probe claim it took.
 *
 * `gatewayProbeClaimId` is non-null only for the single caller admitted to
 * re-probe the cmem gateway after its fallback window elapsed. It must be
 * handed back to `releaseCmemGatewayProbe` when that run ends.
 */
export interface ProviderSelection {
  provider: SelectableProvider;
  gatewayProbeClaimId: number | null;
  /**
   * The provider this selection stands in for when the quota fallback routed
   * around it, else null. Optional so callers and test doubles that build a
   * selection by hand stay valid — read it loosely (`?? null`).
   */
  fallbackFrom?: SelectableProvider | null;
}

/** What CLAUDE_MEM_QUOTA_FALLBACK_PROVIDER may name. */
export const QUOTA_FALLBACK_PROVIDERS = ['claude', 'gemini', 'openrouter', 'openai-compatible'] as const;
export type QuotaFallbackProvider = typeof QUOTA_FALLBACK_PROVIDERS[number];

/** The configured quota fallback, or null when the setting is empty or unrecognised. */
export function readQuotaFallbackProvider(): QuotaFallbackProvider | null {
  const settings = SettingsDefaultsManager.loadFromFile(paths.settings());
  const raw = String(settings.CLAUDE_MEM_QUOTA_FALLBACK_PROVIDER ?? '').trim();
  return (QUOTA_FALLBACK_PROVIDERS as readonly string[]).includes(raw) ? raw as QuotaFallbackProvider : null;
}

/**
 * Whether a fallback has what it needs to run. Claude counts as available:
 * when dispatch returns it, the Claude setup check in SessionRoutes runs
 * exactly as it does for a Claude primary. The cmem gateway is not a fallback
 * while it is turning this account away (its trial-expiry marker is set):
 * its own dispatch branch owns that window and its single re-probe, and a
 * fallback must not send it traffic around them.
 */
function isFallbackAvailable(provider: QuotaFallbackProvider): boolean {
  switch (provider) {
    case 'gemini': return isGeminiAvailable();
    case 'openai-compatible': return isOpenAICompatAvailable();
    case 'claude': return true;
    case 'openrouter': {
      if (!isOpenRouterAvailable()) return false;
      const settings = SettingsDefaultsManager.loadFromFile(paths.settings());
      return !(settings.CLAUDE_MEM_PRO_FALLBACK_AT && isCmemGatewayUrl(settings.CLAUDE_MEM_OPENROUTER_BASE_URL));
    }
  }
}

/**
 * `provider`'s breaker when it is a quota hold on the account selected now: a
 * spent allowance or a rate limit that outlasted its retries. A refused
 * credential (an auth cooldown) is not one. Another provider cannot fix the
 * key, and its successes would clear the warning that says it is broken.
 */
function quotaBreakerOf(provider: SelectableProvider): QuotaCooldownState | null {
  const state = getQuotaCooldown(provider);
  return state && state.cause !== 'auth' && cooldownAppliesToCurrentAccount(state) ? state : null;
}

function isHeldForQuota(provider: SelectableProvider, nowMs: number): boolean {
  return quotaBreakerOf(provider) !== null && isQuotaCooldownHolding(provider, nowMs);
}

/**
 * Where work for `primary` may go while `primary` is held: the configured
 * fallback, when it is a different provider, can serve, and is not itself
 * withholding requests (for any reason). Null otherwise — including when
 * nothing is configured.
 *
 * Read-only: it never claims a probe. Keyed on the provider being routed
 * around, so a provider can never be offered as its own fallback.
 */
export function quotaFallbackTarget(
  primary: QuotaProvider,
  nowMs: number = Date.now(),
): QuotaFallbackProvider | null {
  const fallback = readQuotaFallbackProvider();
  if (fallback === null || fallback === primary) return null;
  if (!isFallbackAvailable(fallback)) return null;
  if (isQuotaCooldownHolding(fallback, nowMs)) return null;
  return fallback;
}

interface RoutedProvider {
  provider: SelectableProvider;
  fallbackFrom: SelectableProvider | null;
}

/**
 * The shared rule for every plain dispatch return: keep `primary` unless its
 * breaker holds for its quota AND the fallback can serve. When neither can,
 * this returns `primary`, and admission withholds it exactly as it does today.
 */
function applyQuotaFallback(primary: SelectableProvider, nowMs: number = Date.now()): RoutedProvider {
  if (!isHeldForQuota(primary, nowMs)) return { provider: primary, fallbackFrom: null };
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

function noteQuotaFallbackTransition(primary: SelectableProvider, routed: RoutedProvider, nowMs: number): void {
  let next: QuotaFallbackState;
  if (routed.fallbackFrom != null) next = 'fallback';
  else if (isHeldForQuota(primary, nowMs)) next = 'blocked';
  else if (quotaBreakerOf(primary) !== null) next = 'probing';
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
      // the work. Name the real cause — the fallback may be held too, or it may
      // simply be unable to serve (no credentials, or equal to the primary).
      const fallback = readQuotaFallbackProvider();
      if (fallback !== null && fallback !== primary && isQuotaCooldownHolding(fallback, nowMs)) {
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
function selectWithQuotaFallback(primary: SelectableProvider): ProviderSelection {
  const nowMs = Date.now();
  const routed = applyQuotaFallback(primary, nowMs);
  if (readQuotaFallbackProvider() !== null) {
    noteQuotaFallbackTransition(primary, routed, nowMs);
  }
  return routed.fallbackFrom === null
    ? { provider: routed.provider, gatewayProbeClaimId: null }
    : { provider: routed.provider, gatewayProbeClaimId: null, fallbackFrom: routed.fallbackFrom };
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
export function getSelectedProvider(): SelectableProvider {
  if (isCodexSelected()) return applyQuotaFallback('codex').provider;
  if (isOpenRouterSelected() && isOpenRouterAvailable()) {
    const settings = SettingsDefaultsManager.loadFromFile(paths.settings());
    if (
      settings.CLAUDE_MEM_PRO_FALLBACK_AT
      && isCmemGatewayUrl(settings.CLAUDE_MEM_OPENROUTER_BASE_URL)
      && staysOnClaudeInFallback(settings.CLAUDE_MEM_PRO_FALLBACK_AT)
    ) {
      return 'claude';
    }
    return applyQuotaFallback('openrouter').provider;
  }
  if (isGeminiSelected() && isGeminiAvailable()) return applyQuotaFallback('gemini').provider;
  if (isOpenAICompatSelected() && isOpenAICompatAvailable()) return applyQuotaFallback('openai-compatible').provider;
  return applyQuotaFallback('claude').provider;
}

/**
 * Where memory capture runs while `held` is in a quota cooldown: the provider
 * dispatch is using, when that is a different one and not itself holding.
 * Null otherwise, and always null with no quota fallback configured, so a
 * default install is unchanged.
 *
 * Read by the session-start notice, through the mirrored cooldown. It asks
 * dispatch rather than `quotaFallbackTarget(held)` because the held provider
 * can be either one: after the fallback hits its own quota while the primary
 * has recovered, capture is back on the primary. It also follows dispatch
 * through the cmem-gateway branch, which ignores the quota fallback rule.
 *
 * Paused work does not need a resume of its own: the periodic sweep
 * (SessionRoutes.resumePendingSessions) paces itself on the provider dispatch
 * returns here, so it restarts quota-paused sessions on whichever provider can
 * take them.
 */
export function quotaServingProvider(held: QuotaProvider, nowMs: number = Date.now()): SelectableProvider | null {
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
 * Claiming makes it what the comment always said it was: exactly one probe,
 * through the quota breaker's own claim under the DISTINCT 'cmem-gateway' key.
 * That key never had an entry — the marker IS the gateway's window, so nothing
 * armed it — and a key with no entry admits every caller without a claim,
 * which let the whole herd through. `tryAdmitCmemGatewayProbe` creates the
 * entry for its claim alone: quota-cooldown neither persists nor mirrors it,
 * because while the fallback stands memory runs on the Anthropic plan, which
 * is not a pause.
 */
export function selectProviderForGenerator(): ProviderSelection {
  if (isCodexSelected()) return selectWithQuotaFallback('codex');
  if (isOpenRouterSelected() && isOpenRouterAvailable()) {
    const settings = SettingsDefaultsManager.loadFromFile(paths.settings());
    if (settings.CLAUDE_MEM_PRO_FALLBACK_AT && isCmemGatewayUrl(settings.CLAUDE_MEM_OPENROUTER_BASE_URL)) {
      if (staysOnClaudeInFallback(settings.CLAUDE_MEM_PRO_FALLBACK_AT)) {
        return { provider: 'claude', gatewayProbeClaimId: null };
      }
      // Window elapsed: exactly one caller re-probes the gateway, the rest stay
      // on the Anthropic plan until that probe resolves — any failure re-stamps
      // the marker, a success clears it, and every exit releases the claim.
      const admission = tryAdmitCmemGatewayProbe();
      if (!admission.admitted) {
        return { provider: 'claude', gatewayProbeClaimId: null };
      }
      return { provider: 'openrouter', gatewayProbeClaimId: admission.claimId };
    }
    return selectWithQuotaFallback('openrouter');
  }
  if (isGeminiSelected() && isGeminiAvailable()) return selectWithQuotaFallback('gemini');
  if (isOpenAICompatSelected() && isOpenAICompatAvailable()) return selectWithQuotaFallback('openai-compatible');
  return selectWithQuotaFallback('claude');
}

/** Release a gateway re-probe claim taken by `selectProviderForGenerator`. */
export function releaseCmemGatewayProbe(claimId: number | null): void {
  releaseQuotaProbe('cmem-gateway', claimId);
}

/**
 * The gateway saying it has stopped serving this account, which is the
 * fallback's trigger:
 *  - kind 'quota_exhausted' (code allowance_exhausted, or a legacy 402): the
 *    allowance is spent, paid accounts at their monthly cap included;
 *  - kind 'auth_invalid': the gateway refused the key. Code 'key_invalid' (not
 *    recognized), code 'subscription_inactive' (a lapsed, cancelled, or unpaid
 *    trial or plan — the very case the installer's fallback promise is for,
 *    #3687, and the most common way the gateway turns an account away), or a
 *    401/403 with no taxonomy envelope at all (an edge or WAF page). Every
 *    refusal leaves the key unusable here, and an auth cooldown in its place
 *    would leave memory on neither the gateway nor Claude.
 */
function isTerminalGatewayRejection(error: ClassifiedProviderError): boolean {
  return error.kind === 'quota_exhausted' || error.kind === 'auth_invalid';
}

/**
 * Settle a failed OpenRouter run against the cmem trial-expiry fallback.
 * Returns true when memory stays on — or moves to — the Anthropic plan: the
 * caller must then NOT feed the observer-health ledger or arm a breaker (the
 * provider switch is the remedy; there is no outage to warn about).
 *
 *  - A terminal gateway rejection records the fallback, with the gateway's own
 *    words for the session-start notice.
 *  - Any other failure of the single post-window re-probe (this run holds the
 *    claim, and no gateway response has cleared the marker since) re-stamps
 *    it: a rate limit or an upstream outage on the probe would otherwise leave
 *    memory on neither the gateway nor Claude.
 *
 * Anything else — a rate limit or an outage outside a fallback, and every
 * failure on a non-gateway base URL (a personal openrouter.ai key running dry)
 * — is not a fallback; the caller books it like any other failure.
 */
export function recordCmemFallbackIfEligible(
  error: unknown,
  gatewayProbeClaimId: number | null = null,
  settingsPath: string = paths.settings(),
): boolean {
  const rejection = isClassified(error) && isTerminalGatewayRejection(error) ? error : null;
  if (rejection === null && gatewayProbeClaimId === null) {
    return false;
  }
  const settings = SettingsDefaultsManager.loadFromFile(settingsPath);
  if (!isCmemGatewayUrl(settings.CLAUDE_MEM_OPENROUTER_BASE_URL)) {
    return false;
  }
  if (rejection === null && !settings.CLAUDE_MEM_PRO_FALLBACK_AT) {
    // The re-probe's claim, but a gateway response already cleared the marker:
    // an ordinary failure of a gateway that serves the account again.
    return false;
  }
  // Already falling back — another generator's rejection armed the window.
  // Handled, but rewriting settings.json would restart the window and race
  // every other writer of the file.
  if (shouldUseCmemFallback(settings.CLAUDE_MEM_PRO_FALLBACK_AT)) {
    return true;
  }
  const detail = isClassified(error) ? { kind: error.kind, ...(error.code ? { code: error.code } : {}) } : {};
  const fallbackAt = new Date().toISOString();
  try {
    // A rejection brings the gateway's words; a failed re-probe only re-stamps,
    // keeping the words of the rejection that started the fallback.
    writeProFallbackAt(fallbackAt, settingsPath, rejection ? gatewayNotice(rejection) : undefined);
  } catch (writeError: unknown) {
    // The marker could not be persisted, so the failure is NOT handled: return
    // false, and the caller books it like any other failure rather than
    // dropping it. This diagnostic explains why the fallback did not arm.
    logger.warn(
      'SESSION',
      'Could not persist the cmem trial-expiry fallback; retaining normal provider failure handling',
      detail,
      writeError instanceof Error ? writeError : new Error(String(writeError)),
    );
    return false;
  }
  logger.info(
    'SESSION',
    rejection
      ? 'Recorded cmem trial-expiry fallback; dispatch switches to the Claude provider'
      : 'cmem gateway re-probe failed; memory stays on the Claude provider',
    { ...detail, fallbackAt },
  );
  return true;
}

/**
 * The gateway's own words for a rejection, from its taxonomy envelope. A legacy
 * body carries no code and no words, and the notice then stays plan-neutral.
 */
function gatewayNotice(error: ClassifiedProviderError): ProFallbackNotice {
  if (!error.code) return {};
  return {
    message: scrubErrorMessage(error.message),
    ...(error.action ? { action: scrubErrorMessage(error.action) } : {}),
    ...(error.url ? { url: error.url } : {}),
  };
}
