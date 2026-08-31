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

import { createHash, timingSafeEqual } from 'crypto';
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

export interface CmemGatewayIdentity {
  apiKey?: string | null;
  deliveredBaseUrl?: string | null;
  deliveredKeyHash?: string | null;
}

export interface CmemGatewayProvenanceSettings {
  CLAUDE_MEM_PRO_GATEWAY_BASE_URL: string;
  CLAUDE_MEM_PRO_GATEWAY_KEY_HASH: string;
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return normalized === 'localhost'
    || normalized.endsWith('.localhost')
    || normalized === '::1'
    || /^127(?:\.\d{1,3}){3}$/.test(normalized);
}

/**
 * Normalize a gateway base URL delivered by the trusted browser-pairing
 * response. Remote keys must never be sent over plaintext HTTP; loopback HTTP
 * remains available for the documented local CMEM_PRO_ORIGIN development flow.
 */
export function normalizeDeliveredCmemGatewayBaseUrl(value: string | undefined | null): string | null {
  const trimmed = (value ?? '').trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
    if (parsed.protocol === 'http:' && !isLoopbackHostname(parsed.hostname)) return null;
    if (parsed.username || parsed.password || parsed.search || parsed.hash) return null;
    const pathname = parsed.pathname.replace(/\/+$/, '');
    return `${parsed.origin}${pathname === '' ? '' : pathname}`;
  } catch {
    return null;
  }
}

export function cmemGatewayKeyHash(apiKey: string): string {
  return createHash('sha256').update(apiKey, 'utf-8').digest('hex');
}

/** Bind a backend-delivered gateway URL to the exact delivered key. */
export function buildCmemGatewayProvenance(
  baseUrl: string,
  apiKey: string,
): CmemGatewayProvenanceSettings | null {
  const normalizedBaseUrl = normalizeDeliveredCmemGatewayBaseUrl(baseUrl);
  const normalizedApiKey = apiKey.trim();
  if (!normalizedBaseUrl || !normalizedApiKey) return null;
  return {
    CLAUDE_MEM_PRO_GATEWAY_BASE_URL: normalizedBaseUrl,
    CLAUDE_MEM_PRO_GATEWAY_KEY_HASH: cmemGatewayKeyHash(normalizedApiKey),
  };
}

function isUrlWithinBase(candidateUrl: string, baseUrl: string): boolean {
  try {
    const candidate = new URL(candidateUrl);
    const base = new URL(baseUrl);
    if (candidate.origin !== base.origin) return false;
    const basePath = base.pathname.replace(/\/+$/, '');
    return basePath === ''
      || candidate.pathname === basePath
      || candidate.pathname.startsWith(`${basePath}/`);
  } catch {
    return false;
  }
}

function keyHashMatches(apiKey: string, expectedHash: string): boolean {
  if (!/^[0-9a-f]{64}$/i.test(expectedHash)) return false;
  const actual = Buffer.from(cmemGatewayKeyHash(apiKey), 'hex');
  const expected = Buffer.from(expectedHash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
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
    const expected = new URL(cmemProOrigin());
    const candidate = new URL(trimmed);
    if (candidate.origin !== expected.origin) return false;

    // CMEM_PRO_ORIGIN is normally origin-only, but keep dev overrides with a
    // path prefix precise as well. A raw startsWith check would incorrectly
    // trust lookalikes such as https://cmem.ai.evil.example/.
    const expectedPath = expected.pathname.replace(/\/+$/, '');
    return expectedPath === ''
      || candidate.pathname === expectedPath
      || candidate.pathname.startsWith(`${expectedPath}/`);
  } catch {
    return false;
  }
}

/**
 * Recognize either the legacy cmem.ai origin or a custom gateway that the
 * browser-pairing response delivered. Custom origins require URL provenance
 * bound to the currently configured key, so editing a generic OpenRouter key
 * cannot accidentally opt it into CMEM's terminal-error fallback behavior.
 */
export function isCmemGatewayRequest(
  requestUrl: string | undefined | null,
  identity: CmemGatewayIdentity = {},
): boolean {
  const candidate = (requestUrl ?? '').trim();
  if (!candidate) return false;
  if (isCmemGatewayUrl(candidate)) return true;

  const deliveredBaseUrl = normalizeDeliveredCmemGatewayBaseUrl(identity.deliveredBaseUrl);
  const apiKey = (identity.apiKey ?? '').trim();
  const deliveredKeyHash = (identity.deliveredKeyHash ?? '').trim();
  return deliveredBaseUrl !== null
    && apiKey !== ''
    && keyHashMatches(apiKey, deliveredKeyHash)
    && isUrlWithinBase(candidate, deliveredBaseUrl);
}

interface RawSettingsDocument {
  document: Record<string, unknown>;
  target: Record<string, unknown>;
}

/**
 * Read settings.json without flattening it. Legacy `{env:{...}}` files may
 * also carry peer keys such as hooks and permissions; the fallback marker is
 * mutated inside `env`, while the complete top-level document is written back.
 */
function readRawSettingsDocument(settingsPath: string): RawSettingsDocument {
  const document = existsSync(settingsPath)
    ? parseJsonWithBom<Record<string, unknown>>(readFileSync(settingsPath, 'utf-8'))
    : {};
  const env = document.env;
  return {
    document,
    target: env && typeof env === 'object' ? (env as Record<string, unknown>) : document,
  };
}

/** Persist the fallback timestamp — the OpenRouter dispatch reads it back. */
export function writeProFallbackAt(isoNow: string, settingsPath: string = USER_SETTINGS_PATH): void {
  const { document, target } = readRawSettingsDocument(settingsPath);
  target.CLAUDE_MEM_PRO_FALLBACK_AT = isoNow;
  writeJsonFileAtomic(settingsPath, document);
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
  const { document, target } = readRawSettingsDocument(settingsPath);
  if (target.CLAUDE_MEM_PRO_FALLBACK_AT) {
    target.CLAUDE_MEM_PRO_FALLBACK_AT = '';
    writeJsonFileAtomic(settingsPath, document);
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
export interface ClearProFallbackOnSuccessOptions {
  identity?: CmemGatewayIdentity;
  settingsPath?: string;
  dataDir?: string;
}

export function clearProFallbackOnGatewaySuccess(
  requestUrl: string,
  options: ClearProFallbackOnSuccessOptions = {},
): void {
  if (!isCmemGatewayRequest(requestUrl, options.identity)) return;
  clearProFallback(options.settingsPath, options.dataDir);
}

/**
 * One-time session-start notice tracking — marker-file pattern per
 * oauth-token.ts (oauth-stale.marker): present ⇔ the notice was already shown.
 */
export const PRO_FALLBACK_NOTICE_MARKER = 'pro-fallback-notice.marker';

/** Retry the cmem key occasionally so a resubscription can self-heal. */
export const PRO_FALLBACK_PROBE_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Whether a recorded fallback is old enough for one gateway probe. Invalid
 * timestamps are probeable rather than pinning the user to Claude forever.
 */
export function isProFallbackProbeDue(
  fallbackAt: string | undefined | null,
  nowMs: number = Date.now(),
): boolean {
  const trimmed = (fallbackAt ?? '').trim();
  if (trimmed === '') return false;
  const fallbackAtMs = Date.parse(trimmed);
  return Number.isNaN(fallbackAtMs)
    || nowMs - fallbackAtMs >= PRO_FALLBACK_PROBE_INTERVAL_MS;
}

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
