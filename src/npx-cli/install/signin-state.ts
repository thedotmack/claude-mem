/**
 * Local state for the deferred / agent-run sign-in.
 *
 *   pending-signin.json   the most recent login-only pairing (id + secret),
 *                         mode 0600, so `login --check` needs no arguments and
 *                         the secret never has to be printed.
 *   signin-state.json     unclaimed | claimed | dismissed, plus the arm.
 *   signin-browser-opened marker: at most one auto-opened tab per install.
 *   signin-reminder-sessions.json  session ids already shown the reminder.
 *
 * Every reader tolerates a missing or corrupt file (returns null / empty):
 * sign-in state is a nicety and must never break an install or a hook.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { resolveDataDir } from '../../shared/paths.js';
import type { SigninArm } from './signin-arm.js';

export type SigninState = 'unclaimed' | 'claimed' | 'dismissed';

export interface PendingSignin {
  pairingId: string;
  secret: string;
  url: string;
  /** ISO timestamp the pairing stops accepting sign-ins. */
  expiresAt: string;
  source: string;
  createdAt: string;
}

export interface SigninStateRecord {
  state: SigninState;
  arm: SigninArm | null;
  updatedAt: string;
}

const PENDING_FILE = 'pending-signin.json';
const STATE_FILE = 'signin-state.json';
const BROWSER_MARKER_FILE = 'signin-browser-opened';
const REMINDER_SESSIONS_FILE = 'signin-reminder-sessions.json';
const MAX_REMEMBERED_SESSIONS = 50;

function dataPath(name: string): string {
  return join(resolveDataDir(), name);
}

function readJson(name: string): unknown {
  try {
    const path = dataPath(name);
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    // [ANTI-PATTERN IGNORED]: a corrupt state file reads as "no state"; the next write replaces it.
    return null;
  }
}

function writeJson(name: string, data: unknown, mode?: number): void {
  mkdirSync(resolveDataDir(), { recursive: true });
  const path = dataPath(name);
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n', mode === undefined ? undefined : { mode });
  // writeFileSync only applies `mode` when it creates the file.
  if (mode !== undefined) chmodSync(path, mode);
}

function isString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

export function savePendingSignin(pending: PendingSignin): void {
  writeJson(PENDING_FILE, pending, 0o600);
}

export function readPendingSignin(): PendingSignin | null {
  const raw = readJson(PENDING_FILE) as Partial<PendingSignin> | null;
  if (!raw || typeof raw !== 'object') return null;
  if (!isString(raw.pairingId) || !isString(raw.secret) || !isString(raw.url) || !isString(raw.expiresAt)) {
    return null;
  }
  return {
    pairingId: raw.pairingId,
    secret: raw.secret,
    url: raw.url,
    expiresAt: raw.expiresAt,
    source: isString(raw.source) ? raw.source : 'unknown',
    createdAt: isString(raw.createdAt) ? raw.createdAt : '',
  };
}

export function pendingSigninExpired(pending: PendingSignin, now: number = Date.now()): boolean {
  const at = Date.parse(pending.expiresAt);
  return !Number.isFinite(at) || at <= now;
}

export function readSigninState(): SigninStateRecord | null {
  const raw = readJson(STATE_FILE) as Partial<SigninStateRecord> | null;
  if (!raw || typeof raw !== 'object') return null;
  if (raw.state !== 'unclaimed' && raw.state !== 'claimed' && raw.state !== 'dismissed') return null;
  const arm = raw.arm === 'A' || raw.arm === 'B' || raw.arm === 'C' ? raw.arm : null;
  return { state: raw.state, arm, updatedAt: isString(raw.updatedAt) ? raw.updatedAt : '' };
}

/**
 * Record a state change. `claimed` and `dismissed` are terminal for the
 * reminder: a later deferred offer (a reinstall) never downgrades them back
 * to `unclaimed`.
 */
export function writeSigninState(state: SigninState, arm?: SigninArm | null): SigninStateRecord {
  const previous = readSigninState();
  if (state === 'unclaimed' && previous && previous.state !== 'unclaimed') return previous;
  const record: SigninStateRecord = {
    state,
    arm: arm ?? previous?.arm ?? null,
    updatedAt: new Date().toISOString(),
  };
  writeJson(STATE_FILE, record);
  return record;
}

export function browserAlreadyOpened(): boolean {
  return existsSync(dataPath(BROWSER_MARKER_FILE));
}

export function markBrowserOpened(): void {
  mkdirSync(resolveDataDir(), { recursive: true });
  writeFileSync(dataPath(BROWSER_MARKER_FILE), new Date().toISOString() + '\n');
}

export function reminderShownForSession(sessionId: string): boolean {
  const raw = readJson(REMINDER_SESSIONS_FILE);
  return Array.isArray(raw) && raw.includes(sessionId);
}

export function markReminderShown(sessionId: string): void {
  const raw = readJson(REMINDER_SESSIONS_FILE);
  const ids = Array.isArray(raw) ? raw.filter(isString) : [];
  if (ids.includes(sessionId)) return;
  ids.push(sessionId);
  writeJson(REMINDER_SESSIONS_FILE, ids.slice(-MAX_REMEMBERED_SESSIONS));
}
