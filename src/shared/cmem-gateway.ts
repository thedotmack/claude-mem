// SPDX-License-Identifier: Apache-2.0

/**
 * cmem.ai inference-gateway detection and the trial-expiry fallback marker.
 *
 * When the installer's browser login delivers a memory key, the worker talks
 * to the cmem.ai gateway through the generic OpenRouter provider
 * (CLAUDE_MEM_OPENROUTER_BASE_URL points at `${CMEM_PRO_ORIGIN}/api/inference/v1`).
 * When the gateway stops serving the account it answers with a terminal code —
 * `subscription_inactive` for a lapsed, cancelled, or unpaid trial or plan,
 * `allowance_exhausted` for a spent allowance (paid accounts at their cap
 * included), `key_invalid` for an unrecognized key — and instead of surfacing
 * an outage, memory falls back to the user's Anthropic plan. The fallback
 * state lives in settings.json as CLAUDE_MEM_PRO_FALLBACK_AT (ISO timestamp;
 * '' = no fallback), with the gateway's own words beside it for the
 * session-start notice. It is strictly EVENT-driven: written only when the
 * gateway rejects a request, never from trial dates — a subscribed user's key
 * keeps working past `ends_at`, so the date alone must never disable anything.
 *
 * Shared (not npx-cli) because the worker, the session-start hook, and the
 * installer all need the same gateway check. The npx-cli endpoint constants in
 * src/npx-cli/cmem-pro-costs.ts derive from the same origin resolution.
 */

import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { paths, USER_SETTINGS_PATH } from './paths.js';
import { updateSettingsDocument } from './settings-document.js';
import { emitDiagnostic } from './hook-io.js';
import { proTrialUrl } from './pro-promo.js';
import { relayedLine, relayedLink } from './relayed-text.js';

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
  if (!trimmed) return false;

  try {
    const gateway = new URL(cmemProOrigin());
    const candidate = new URL(trimmed);
    if (
      (gateway.protocol !== 'http:' && gateway.protocol !== 'https:')
      || candidate.origin !== gateway.origin
    ) {
      return false;
    }

    // CMEM_PRO_ORIGIN may include a development-server base path. Match that
    // path on a segment boundary so `/mock` accepts `/mock/api/...` but not
    // `/mockery`. URL.origin equality above rejects deceptive host/port
    // prefixes such as `cmem.ai.evil` and `localhost:30050`.
    const gatewayPath = gateway.pathname.replace(/\/+$/, '');
    return gatewayPath === ''
      || candidate.pathname === gatewayPath
      || candidate.pathname.startsWith(`${gatewayPath}/`);
  } catch {
    return false;
  }
}

/**
 * Whether an API key is the account-owned cmem.ai memory key. Every key the
 * gateway has issued is `cm_pro_` + 24 or 32 hex chars (the server-side
 * validator the installer once mirrored, 9d6742f1a); the prefix alone is the
 * test, so a future key length is still recognized. Such a key authenticates
 * only against the gateway and must never be sent anywhere else.
 */
export function isCmemMemoryKey(apiKey: string | undefined | null): boolean {
  return (apiKey ?? '').trim().startsWith('cm_pro_');
}

/** What the gateway said about the rejection that armed the fallback. */
export interface ProFallbackNotice {
  message?: string;
  action?: string;
  url?: string;
}

/** The settings keys that make up a fallback: the marker and the gateway's words. */
const PRO_FALLBACK_KEYS = [
  'CLAUDE_MEM_PRO_FALLBACK_AT',
  'CLAUDE_MEM_PRO_FALLBACK_MESSAGE',
  'CLAUDE_MEM_PRO_FALLBACK_ACTION',
  'CLAUDE_MEM_PRO_FALLBACK_URL',
] as const;

/**
 * The one-time session-start notice for an active fallback. The gateway's
 * words enter model context here, so each is relayed as one plain, bounded
 * line (relayed-text.ts), and its link only when it is a cmem.ai page, where
 * the plan is managed. Anything else gets the renewal link.
 *
 * Plan-neutral: paid accounts at their monthly cap are turned away too, so it
 * never assumes a trial ended. Without the gateway's words it says only what
 * is true for every account.
 */
export function proFallbackNotice(notice: ProFallbackNotice): string {
  const message = relayedLine(notice.message) || 'cmem.ai memory is paused for this account.';
  const action = relayedLine(notice.action);
  return [
    message,
    ...(action ? [action] : []),
    `Memory is using your Anthropic plan for now. Manage your plan: ${planLink(notice.url)}`,
  ].join('\n');
}

function planLink(url: string | undefined): string {
  const link = relayedLink(url);
  return link !== null && new URL(link).hostname === 'cmem.ai' ? link : proTrialUrl('fallback');
}

/**
 * Persist the fallback timestamp — the OpenRouter dispatch reads it back —
 * together with the gateway's words, in one write. Passing `notice` replaces
 * the stored words (missing parts become ''); omitting it re-stamps the time
 * and keeps the words of the rejection that started the fallback.
 *
 * Written through settings-document.ts, the one rule every settings reader
 * and writer uses: the marker lands where SettingsDefaultsManager, and so
 * dispatch, reads it (the root of a flat document, even with Claude Code's
 * `env` block beside claude-mem's keys), the document's other keys are kept,
 * and the file stays owner-only. Throws when settings.json cannot be updated,
 * e.g. it is unreadable: the caller then books an ordinary failure.
 */
export function writeProFallbackAt(
  isoNow: string,
  settingsPath: string = USER_SETTINGS_PATH,
  notice?: ProFallbackNotice,
): void {
  const updates: Record<string, string> = { CLAUDE_MEM_PRO_FALLBACK_AT: isoNow };
  if (notice) {
    updates.CLAUDE_MEM_PRO_FALLBACK_MESSAGE = notice.message ?? '';
    updates.CLAUDE_MEM_PRO_FALLBACK_ACTION = notice.action ?? '';
    updates.CLAUDE_MEM_PRO_FALLBACK_URL = notice.url ?? '';
  }
  const result = updateSettingsDocument(settingsPath, updates);
  if (result.status === 'refused') {
    throw result.error instanceof Error ? result.error : new Error(String(result.error));
  }
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
  // No settings file means no fallback to clear, and no reason to create one.
  if (existsSync(settingsPath)) {
    // Every key, not only the marker: a re-pair blanks the marker through the
    // installer's settings merge before calling this, and the gateway's words
    // must not outlive the fallback they described. An unchanged document is
    // not rewritten — a successful gateway response calls this every time.
    const result = updateSettingsDocument(settingsPath, {}, {}, (target) => {
      for (const key of PRO_FALLBACK_KEYS) {
        if (target[key]) target[key] = '';
      }
    });
    if (result.status === 'refused') {
      // Cleanup follows a successful login/request and must never turn that
      // success into an installer or provider failure. Leave a diagnostic so
      // the stale timestamp is still actionable.
      const reason = result.error instanceof Error ? result.error.message : String(result.error);
      emitDiagnostic(`[cmem-gateway] Could not clear fallback setting at ${settingsPath}: ${reason}\n`);
    }
  }

  try {
    const marker = join(dataDir, PRO_FALLBACK_NOTICE_MARKER);
    if (existsSync(marker)) unlinkSync(marker);
  } catch (error: unknown) {
    // The marker only controls whether a future notice is shown. Failure to
    // remove it must not invalidate freshly delivered credentials.
    emitDiagnostic(`[cmem-gateway] Could not clear fallback notice marker in ${dataDir}: ${error instanceof Error ? error.message : String(error)}\n`);
  }
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
