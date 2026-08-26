// SPDX-License-Identifier: Apache-2.0

/**
 * cmem.ai inference-gateway detection and the trial-expiry fallback marker.
 *
 * When the installer's browser login delivers a memory key, the worker talks
 * to the cmem.ai gateway through the generic OpenRouter provider
 * (CLAUDE_MEM_OPENROUTER_BASE_URL points at `${CMEM_PRO_ORIGIN}/api/inference/v1`).
 * Once the free week ends without a subscription, the gateway answers with a
 * terminal quota/key error — and instead of surfacing an outage, memory falls
 * back to the user's Anthropic plan. The fallback state lives in settings.json
 * as CLAUDE_MEM_PRO_FALLBACK_AT (ISO timestamp; '' = no fallback) and is
 * strictly EVENT-driven: it is written only when the gateway rejects a request,
 * never from trial dates — a subscribed user's key keeps working past
 * `ends_at`, so the date alone must never disable anything.
 *
 * Shared (not npx-cli) because the worker, the session-start hook, and the
 * installer all need the same gateway check. The npx-cli endpoint constants in
 * src/npx-cli/cmem-pro-costs.ts derive from the same origin resolution.
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { paths, USER_SETTINGS_PATH } from './paths.js';
import { parseJsonWithBom, writeJsonFileAtomic } from './atomic-json.js';

/**
 * Origin for the cmem.ai funnel and gateway. Overridable so the whole flow can
 * be walked against a dev server (CMEM_PRO_ORIGIN=http://localhost:3005).
 * Read per-call, not at module load, so tests and the installer's env override
 * both work regardless of import order.
 */
export function cmemProOrigin(): string {
  return (process.env.CMEM_PRO_ORIGIN?.trim() || 'https://cmem.ai').replace(/\/+$/, '');
}

/**
 * Whether a configured base URL (or a resolved request URL) points at the
 * cmem.ai inference gateway. Blank means the default openrouter.ai endpoint —
 * a user-owned key — and is never the gateway: the trial-expiry fallback must
 * only ever fire for cmem-delivered keys.
 */
export function isCmemGatewayUrl(url: string | undefined | null): boolean {
  const trimmed = (url ?? '').trim();
  return trimmed !== '' && trimmed.startsWith(cmemProOrigin());
}

/**
 * Read settings.json as raw flat JSON (tolerating the legacy `{env:{}}` shape)
 * so fallback writes preserve keys this build does not declare.
 */
function readFlatRawSettings(settingsPath: string): Record<string, unknown> {
  if (!existsSync(settingsPath)) return {};
  const parsed = parseJsonWithBom<Record<string, unknown>>(readFileSync(settingsPath, 'utf-8'));
  const env = parsed.env;
  return env && typeof env === 'object' ? (env as Record<string, unknown>) : parsed;
}

/** Persist the fallback timestamp — the OpenRouter dispatch reads it back. */
export function writeProFallbackAt(isoNow: string, settingsPath: string = USER_SETTINGS_PATH): void {
  const raw = readFlatRawSettings(settingsPath);
  raw.CLAUDE_MEM_PRO_FALLBACK_AT = isoNow;
  writeJsonFileAtomic(settingsPath, raw);
}

/**
 * Clear the fallback (fresh key material from the installer, or a successful
 * gateway response, proves the key is funded again) and reset the one-time
 * session-start notice so a future fallback notifies again.
 */
export function clearProFallback(
  settingsPath: string = USER_SETTINGS_PATH,
  dataDir: string = paths.dataDir(),
): void {
  const raw = readFlatRawSettings(settingsPath);
  if (raw.CLAUDE_MEM_PRO_FALLBACK_AT) {
    raw.CLAUDE_MEM_PRO_FALLBACK_AT = '';
    writeJsonFileAtomic(settingsPath, raw);
  }
  const marker = join(dataDir, PRO_FALLBACK_NOTICE_MARKER);
  if (existsSync(marker)) unlinkSync(marker);
}

/**
 * Success hook for the OpenRouter provider: any successful response from the
 * cmem gateway clears the fallback. Called with the resolved request URL —
 * non-gateway endpoints (openrouter.ai, DeepSeek, LM Studio, …) are a no-op,
 * without even a settings read.
 */
export function clearProFallbackOnGatewaySuccess(
  requestUrl: string,
  settingsPath: string = USER_SETTINGS_PATH,
  dataDir: string = paths.dataDir(),
): void {
  if (!isCmemGatewayUrl(requestUrl)) return;
  clearProFallback(settingsPath, dataDir);
}

/**
 * One-time session-start notice tracking — marker-file pattern per
 * oauth-token.ts (oauth-stale.marker): present ⇔ the notice was already shown.
 */
export const PRO_FALLBACK_NOTICE_MARKER = 'pro-fallback-notice.marker';

export function hasShownProFallbackNotice(dataDir: string = paths.dataDir()): boolean {
  return existsSync(join(dataDir, PRO_FALLBACK_NOTICE_MARKER));
}

export function markProFallbackNoticeShown(dataDir: string = paths.dataDir()): void {
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dataDir, PRO_FALLBACK_NOTICE_MARKER), new Date().toISOString(), {
    encoding: 'utf-8',
    mode: 0o600,
  });
}

const DAY_MS = 86_400_000;

/**
 * Whole days until the stored trial end date — 0 when it ends later today,
 * negative once past, null when absent/unparseable. Computed locally from
 * CLAUDE_MEM_PRO_TRIAL_ENDS_AT; no network. Display-only nicety: nothing is
 * ever enabled or disabled from this value (the fallback is event-driven).
 */
export function trialDaysRemaining(
  endsAtIso: string | undefined | null,
  nowMs: number = Date.now(),
): number | null {
  const trimmed = (endsAtIso ?? '').trim();
  if (!trimmed) return null;
  const endMs = Date.parse(trimmed);
  if (Number.isNaN(endMs)) return null;
  return Math.floor((endMs - nowMs) / DAY_MS);
}
