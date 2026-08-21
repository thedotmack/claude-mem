// SPDX-License-Identifier: Apache-2.0

/**
 * File-backed CMEM Pro fallback state, so a definitive Pro gateway failure
 * (allowance exhausted, subscription inactive) switches memory generation to
 * the user's chosen fallback provider instead of stopping outright.
 *
 * A file — not in-memory state — because the flag is written by the worker's
 * OpenRouter provider and read by provider resolution AND by hook processes
 * (session-start / user-message banners), which never share a process (same
 * pattern as observer-health.ts).
 *
 * The state carries a 24h TTL evaluated on read (no timers): after expiry,
 * isFallbackActive() self-clears and resolution optimistically retries Pro —
 * so the system self-heals after the user pays, and the next definitive
 * failure simply re-activates the fallback.
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { paths } from './paths.js';
import { logger } from '../utils/logger.js';

export interface ProFallbackState {
  active: boolean;
  /** Gateway error code that triggered the fallback (e.g. 'allowance_exhausted'). */
  reason: string;
  /** ISO timestamp of activation — the TTL clock. */
  activatedAt: string;
}

export const PRO_FALLBACK_FILENAME = 'pro-fallback.json';

/** Retry Pro daily: past this age the state self-clears on read. */
export const PRO_FALLBACK_TTL_MS = 24 * 60 * 60 * 1000;

function defaultFallbackFilePath(): string {
  return join(paths.dataDir(), PRO_FALLBACK_FILENAME);
}

export function readProFallbackState(filePath: string = defaultFallbackFilePath()): ProFallbackState | null {
  try {
    if (!existsSync(filePath)) return null;
    const parsed: unknown = JSON.parse(readFileSync(filePath, 'utf-8'));
    if (typeof parsed !== 'object' || parsed === null) return null;
    const state = parsed as Partial<ProFallbackState>;
    if (typeof state.active !== 'boolean') return null;
    return {
      active: state.active,
      reason: typeof state.reason === 'string' ? state.reason : '',
      activatedAt: typeof state.activatedAt === 'string' ? state.activatedAt : '',
    };
  } catch (error) {
    logger.warn('SESSION', 'Failed to read pro-fallback file', { filePath },
      error instanceof Error ? error : new Error(String(error)));
    return null;
  }
}

export function activateFallback(
  reason: string,
  filePath: string = defaultFallbackFilePath(),
  nowMs: number = Date.now(),
): void {
  const state: ProFallbackState = {
    active: true,
    reason,
    activatedAt: new Date(nowMs).toISOString(),
  };
  try {
    const dir = dirname(filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(filePath, JSON.stringify(state, null, 2), { encoding: 'utf-8', mode: 0o600 });
  } catch (error) {
    logger.warn('SESSION', 'Failed to write pro-fallback file', { filePath },
      error instanceof Error ? error : new Error(String(error)));
  }
}

export function clearFallback(filePath: string = defaultFallbackFilePath()): void {
  try {
    if (existsSync(filePath)) unlinkSync(filePath);
  } catch (error) {
    logger.warn('SESSION', 'Failed to clear pro-fallback file', { filePath },
      error instanceof Error ? error : new Error(String(error)));
  }
}

/**
 * True while a Pro failure marker is fresh (< 24h). An expired or malformed
 * marker is deleted on the spot and reads as inactive, so Pro is retried at
 * most a day after the failure that activated the fallback.
 */
export function isFallbackActive(
  filePath: string = defaultFallbackFilePath(),
  nowMs: number = Date.now(),
): boolean {
  const state = readProFallbackState(filePath);
  if (!state || !state.active) return false;
  const activatedAtMs = Date.parse(state.activatedAt);
  if (!Number.isFinite(activatedAtMs) || nowMs - activatedAtMs > PRO_FALLBACK_TTL_MS) {
    clearFallback(filePath);
    return false;
  }
  return true;
}

/**
 * While the fallback marker is active but no fallback provider can serve
 * ('none', or 'gemini' without a key), generation must not send every queued
 * batch to the known-exhausted Pro gateway. Instead the caller holds queued
 * work while the marker is fresher than this interval, letting one probe
 * request through per interval: a definitive failure re-writes the marker
 * (re-arming the hold), while a success simply drains the buffer. Net effect:
 * at most one doomed request per interval, queued observations retained, and
 * recovery within one interval of the user paying.
 */
export const PRO_FALLBACK_PROBE_INTERVAL_MS = 5 * 60 * 1000;

/**
 * True while dispatch to the Pro gateway should be held (see
 * PRO_FALLBACK_PROBE_INTERVAL_MS). Callers apply this only when no usable
 * fallback provider exists — with a usable fallback, resolution never routes
 * to the Pro gateway while the marker is active in the first place.
 */
export function isProFallbackHoldActive(
  filePath: string = defaultFallbackFilePath(),
  nowMs: number = Date.now(),
): boolean {
  if (!isFallbackActive(filePath, nowMs)) return false;
  const state = readProFallbackState(filePath);
  if (!state) return false;
  const activatedAtMs = Date.parse(state.activatedAt);
  return Number.isFinite(activatedAtMs) && nowMs - activatedAtMs < PRO_FALLBACK_PROBE_INTERVAL_MS;
}

/**
 * Is this OpenRouter base URL the CMEM Pro inference gateway?
 *
 * Deliberately a tiny duplicate of the origin logic in
 * `src/npx-cli/cmem-pro-costs.ts` (CMEM_PRO_ORIGIN / CMEM_PRO_BASE_URL):
 * importing the npx-cli installer tree from the worker would be wrong
 * layering, and the check is one origin comparison. Honors the same
 * CMEM_PRO_ORIGIN dev override so the whole fallback flow can be exercised
 * against a local server.
 */
export function isCmemProBaseUrl(baseUrl: string): boolean {
  const origin = (process.env.CMEM_PRO_ORIGIN?.trim() || 'https://cmem.ai').replace(/\/+$/, '');
  try {
    return new URL(baseUrl).origin === new URL(origin).origin;
  } catch {
    // Not an absolute URL (empty/default/openrouter.ai relative form) — not the Pro gateway.
    return false;
  }
}

/**
 * Which provider should serve while the Pro fallback is active. Pure so
 * provider resolution stays testable: callers pass the configured
 * CLAUDE_MEM_FALLBACK_PROVIDER value and whether a Gemini key is available.
 * Returns null when the fallback cannot serve ('none', unknown value, or
 * 'gemini' without a key) — the caller then keeps its current behavior.
 */
export function resolveFallbackProvider(opts: {
  fallbackProvider: string;
  geminiAvailable: boolean;
}): 'claude' | 'gemini' | null {
  if (opts.fallbackProvider === 'claude') return 'claude';
  if (opts.fallbackProvider === 'gemini' && opts.geminiAvailable) return 'gemini';
  return null;
}
