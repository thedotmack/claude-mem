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
import { isQuotaCooldownActive, releaseQuotaProbe, tryAdmitCmemGatewayProbe } from '../../shared/quota-cooldown.js';

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
}

/**
 * Read-only dispatch, for diagnostics and status. Never claims a probe, so it
 * is safe to call from anywhere — but a caller about to actually SEND must use
 * `selectProviderForGenerator` instead, or it becomes part of the herd.
 */
export function getSelectedProvider(): SelectableProvider {
  if (isCodexSelected()) return 'codex';
  if (isOpenRouterSelected() && isOpenRouterAvailable()) {
    const settings = SettingsDefaultsManager.loadFromFile(paths.settings());
    if (
      settings.CLAUDE_MEM_PRO_FALLBACK_AT
      && isCmemGatewayUrl(settings.CLAUDE_MEM_OPENROUTER_BASE_URL)
      && staysOnClaudeInFallback(settings.CLAUDE_MEM_PRO_FALLBACK_AT)
    ) {
      return 'claude';
    }
    return 'openrouter';
  }
  if (isGeminiSelected() && isGeminiAvailable()) return 'gemini';
  if (isOpenAICompatSelected() && isOpenAICompatAvailable()) return 'openai-compatible';
  return 'claude';
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
  if (isCodexSelected()) return { provider: 'codex', gatewayProbeClaimId: null };
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
    return { provider: 'openrouter', gatewayProbeClaimId: null };
  }
  if (isGeminiSelected() && isGeminiAvailable()) {
    return { provider: 'gemini', gatewayProbeClaimId: null };
  }
  if (isOpenAICompatSelected() && isOpenAICompatAvailable()) {
    return { provider: 'openai-compatible', gatewayProbeClaimId: null };
  }
  return { provider: 'claude', gatewayProbeClaimId: null };
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
