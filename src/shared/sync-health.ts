// SPDX-License-Identifier: Apache-2.0

/**
 * File-backed cloud sync health, so a stalled or rejected sync is never
 * silent. Before this, a flush failure only reached `logger.warn` and the
 * local `/api/sync/status` route: users found out when cloud memories went
 * missing, and support mail arrived with hand-pulled status JSON.
 *
 * CloudSync records outcomes (auth pause, failure streak, recovery) here.
 * Session-start context assembly (ContextBuilder) reads the file and appends
 * one plain-language line with the cause and the action to take. Same shape
 * as observer-health: a file, because the state must survive worker restarts
 * and be readable from the hook process without the worker HTTP API.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { paths } from './paths.js';
import { describeDuration, scrubErrorMessage } from './observer-health.js';
import { logger } from '../utils/logger.js';

export const SYNC_HEALTH_FILENAME = 'sync-health.json';

/** Failing this long (or this many flushes in a row) raises the banner. */
export const SYNC_FAILING_WARN_AFTER_MS = 15 * 60 * 1_000;
export const SYNC_FAILING_WARN_AFTER_FAILURES = 5;

export type SyncAuthCode = 'invalid_token' | 'subscription_inactive';

export interface SyncAuthFailure {
  code: SyncAuthCode;
  /** HTTP status the sync server answered with (401 or 403). */
  status: number;
  /** Plain-language cause and action, safe to show the user. */
  message: string;
}

export const SYNC_AUTH_MESSAGES: Record<SyncAuthCode, string> = {
  invalid_token:
    'Cloud sync is paused: this device\'s sync token is no longer valid (connecting another machine can rotate it). '
    + 'Reconnect at https://cmem.ai (Connect), then restart claude-mem. Your local memories are safe.',
  subscription_inactive:
    'Cloud sync is paused: your CMEM Pro trial or subscription is not active. '
    + 'Renew at https://cmem.ai/pro and sync resumes on its own within the hour. Your local memories are safe.',
};

/**
 * Classify a sync-server response as an authentication/entitlement failure.
 * 401 and 403 both mean "retrying with the same credentials cannot succeed",
 * so the client stops its retry loop. The server passes the Pro app's
 * machine-readable `code` through; older servers only say "invalid token",
 * which maps to `invalid_token`.
 */
export function classifySyncAuthFailure(status: number, body: string): SyncAuthFailure | null {
  if (status !== 401 && status !== 403) return null;
  let code: SyncAuthCode = 'invalid_token';
  let parsedCode: unknown = null;
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      parsedCode = (parsed as Record<string, unknown>).code;
    }
  } catch { /* non-JSON body: fall back to text sniffing */ }
  if (
    parsedCode === 'subscription_inactive'
    || /subscription_inactive|subscription not active/i.test(body)
  ) {
    code = 'subscription_inactive';
  }
  return { code, status, message: SYNC_AUTH_MESSAGES[code] };
}

/**
 * Make a raw sync error readable: an HTML error page (Cloudflare 1027/429,
 * proxy 502 pages) becomes a short description instead of a 200-character
 * slice of markup. Credentials are scrubbed.
 */
export function friendlySyncError(message: string): string {
  const htmlAt = message.search(/<!DOCTYPE|<html/i);
  const text = htmlAt >= 0
    ? `${message.slice(0, htmlAt).trim()} (the sync server returned an HTML error page)`
    : message;
  return scrubErrorMessage(text);
}

export type SyncHealthStateName = 'ok' | 'auth_paused' | 'failing';

export interface SyncHealthState {
  state: SyncHealthStateName;
  /** SyncAuthCode while auth_paused; HTTP status/"error" while failing. */
  code: string | null;
  /** Plain-language message (already scrubbed). */
  message: string | null;
  consecutiveFailures: number;
  failingSinceAt: number | null;
  lastErrorAt: number | null;
  lastSuccessAt: number | null;
  updatedAt: number;
}

export function defaultSyncHealthFilePath(): string {
  return join(paths.dataDir(), SYNC_HEALTH_FILENAME);
}

export function readSyncHealth(filePath: string = defaultSyncHealthFilePath()): SyncHealthState | null {
  try {
    if (!existsSync(filePath)) return null;
    const parsed: unknown = JSON.parse(readFileSync(filePath, 'utf-8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const record = parsed as Partial<SyncHealthState>;
    if (record.state !== 'ok' && record.state !== 'auth_paused' && record.state !== 'failing') return null;
    return {
      state: record.state,
      code: typeof record.code === 'string' ? record.code : null,
      message: typeof record.message === 'string' ? record.message : null,
      consecutiveFailures: typeof record.consecutiveFailures === 'number' ? record.consecutiveFailures : 0,
      failingSinceAt: typeof record.failingSinceAt === 'number' ? record.failingSinceAt : null,
      lastErrorAt: typeof record.lastErrorAt === 'number' ? record.lastErrorAt : null,
      lastSuccessAt: typeof record.lastSuccessAt === 'number' ? record.lastSuccessAt : null,
      updatedAt: typeof record.updatedAt === 'number' ? record.updatedAt : 0,
    };
  } catch {
    return null;
  }
}

export function writeSyncHealth(state: SyncHealthState, filePath: string = defaultSyncHealthFilePath()): void {
  try {
    const dir = join(filePath, '..');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = `${filePath}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2), { encoding: 'utf-8', mode: 0o600 });
    renameSync(tmp, filePath);
  } catch (error) {
    logger.debug('CLOUD_SYNC', 'Failed to write sync-health file', { filePath },
      error instanceof Error ? error : new Error(String(error)));
  }
}

/** Remove the ledger (sync turned off: no stale banner for a feature not in use). */
export function clearSyncHealth(filePath: string = defaultSyncHealthFilePath()): void {
  try {
    if (existsSync(filePath)) unlinkSync(filePath);
  } catch { /* best effort */ }
}

export function shouldWarnSyncHealth(state: SyncHealthState | null, nowMs: number = Date.now()): state is SyncHealthState {
  if (!state) return false;
  if (state.state === 'auth_paused') return true;
  if (state.state !== 'failing') return false;
  if (state.consecutiveFailures >= SYNC_FAILING_WARN_AFTER_FAILURES) return true;
  return state.failingSinceAt !== null && nowMs - state.failingSinceAt >= SYNC_FAILING_WARN_AFTER_MS;
}

/** One short block: cause, what is safe, what to do. '' when healthy. */
export function renderSyncHealthWarning(state: SyncHealthState | null, nowMs: number = Date.now()): string {
  if (!shouldWarnSyncHealth(state, nowMs)) return '';
  if (state.state === 'auth_paused') {
    const known = state.code === 'subscription_inactive' || state.code === 'invalid_token'
      ? SYNC_AUTH_MESSAGES[state.code]
      : (state.message ?? SYNC_AUTH_MESSAGES.invalid_token);
    return `⚠ ${known}`;
  }
  const since = state.failingSinceAt !== null
    ? ` for ${describeDuration(nowMs - state.failingSinceAt)}`
    : '';
  const detail = state.message ? ` Last error: ${scrubErrorMessage(state.message)}` : '';
  return [
    `⚠ Cloud sync has been failing${since} (${state.consecutiveFailures} attempt${state.consecutiveFailures === 1 ? '' : 's'}). `
      + 'New memories are saved locally and queued; they upload once the sync server accepts them.'
      + detail,
    'Details: /api/sync/status on the claude-mem worker.',
  ].join('\n');
}
