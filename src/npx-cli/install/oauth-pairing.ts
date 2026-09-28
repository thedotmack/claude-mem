/**
 * The installer's OAuth pairing client for cmem.ai: start a pairing, parse
 * and validate its browser URLs, and poll it once. Shared by the installer,
 * `claude-mem login`, and the worker's SessionStart sign-in reminder, so it
 * stays free of prompts and console output.
 */

import { hostname } from 'os';
import {
  CMEM_INSTALLER_OAUTH_POLL_URL,
  CMEM_INSTALLER_OAUTH_START_URL,
  CMEM_PRO_BASE_URL,
  CMEM_PRO_MODEL,
} from '../cmem-pro-costs.js';

// --- claude-mem OAuth pairing ----------------------------------------------
// Every installer authenticates through the same GitHub/Google OAuth screen as
// cmem.ai. Login only proves account ownership; provider selection happens
// afterward, and only the CMEM Pro choice continues into trial enrollment.

export function nonEmptyTrimmedString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

export const OAUTH_START_TIMEOUT_MS = 10_000;
// The optional end-of-install sign-in offer must not hold a finished install
// hostage to a stalled cmem.ai: give up well before the blocking login would.
export const OAUTH_DEFERRED_START_TIMEOUT_MS = 3_000;
export const OAUTH_POLL_TIMEOUT_MS = 10_000;
// Fallback budget when the server does not report `expires_in`. The server
// pairing lives 30 minutes; polling past that only yields `gone`.
export const OAUTH_POLL_BUDGET_MS = 240_000;
export const OAUTH_POLL_BUDGET_MAX_MS = 30 * 60 * 1000;
export const OAUTH_DEFAULT_POLL_INTERVAL_S = 3;

export type InstallerPollStage = 'awaiting_login' | 'awaiting_checkout' | 'awaiting_approval';
export type TrialPlan = 'trial' | 'pro' | 'none';

export interface InstallerOAuthPairing {
  pairingId: string;
  secret: string;
  userCode: string;
  authorizationUrl: string;
  checkoutUrl: string;
  pollIntervalMs: number;
  /**
   * Absolute epoch ms after which polling stops, derived from the server's
   * `expires_in` at parse time and clamped to OAUTH_POLL_BUDGET_MAX_MS.
   * Undefined when the server did not report one (fallback budget applies).
   */
  expiresAt?: number;
  /** Defensive compatibility for a server that returns ready during login. */
  delivered?: TrialReadyResult;
}

export function parseBrowserUrl(value: unknown, expectedPath: string): URL | null {
  const candidate = nonEmptyTrimmedString(value);
  if (!candidate) return null;
  try {
    const parsed = new URL(candidate);
    const expectedOrigin = new URL(CMEM_INSTALLER_OAUTH_START_URL).origin;
    if (
      parsed.origin !== expectedOrigin
      || parsed.pathname !== expectedPath
      || parsed.username
      || parsed.password
      || parsed.hash
    ) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function hasExactSearchParams(url: URL, expected: Record<string, string>): boolean {
  const entries = [...url.searchParams.entries()];
  const expectedEntries = Object.entries(expected);
  return entries.length === expectedEntries.length
    && expectedEntries.every(([key, value]) => url.searchParams.get(key) === value);
}

/**
 * The checkout URL must carry exactly `pairing` and `trial`, and nothing else —
 * but the trial LENGTH is not the installer's business to pin.
 *
 * This previously required `trial: '7'` exactly. That made the server unable to
 * change the offer without breaking every installer already published: a
 * `trial=30` URL was rejected outright, surfacing as "Could not start OAuth
 * login" with no hint that the length was the reason. The shape stays strict
 * (both params present, pairing must match, no extras); only the number is now
 * the server's to choose.
 */
export function hasPairingAndTrialParams(url: URL, pairingId: string): boolean {
  const entries = [...url.searchParams.entries()];
  if (entries.length !== 2) return false;
  if (url.searchParams.get('pairing') !== pairingId) return false;
  const trial = url.searchParams.get('trial');
  if (trial === null || !/^[0-9]{1,3}$/.test(trial)) return false;
  const days = Number(trial);
  return days >= 1 && days <= 365;
}

/** Pure parser used by the mock-server contract tests. */
export function parseInstallerOAuthStartBody(body: unknown): InstallerOAuthPairing | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as {
    pairing_id?: unknown;
    secret?: unknown;
    user_code?: unknown;
    authorization_url?: unknown;
    checkout_url?: unknown;
    poll_interval?: unknown;
    expires_in?: unknown;
  };
  const pairingId = nonEmptyTrimmedString(b.pairing_id);
  const secret = nonEmptyTrimmedString(b.secret);
  const userCode = nonEmptyTrimmedString(b.user_code);
  const authorizationUrl = parseBrowserUrl(b.authorization_url, '/login');
  const checkoutUrl = parseBrowserUrl(b.checkout_url, '/api/pro/trial/claim');
  if (
    !pairingId
    || !/^[0-9a-f]{32}$/.test(pairingId)
    || !secret
    || !/^[0-9a-f]{48}$/.test(secret)
    || !userCode
    || !/^[A-HJ-KM-NP-TV-Z2-9]{4}-[A-HJ-KM-NP-TV-Z2-9]{4}$/.test(userCode)
    || !authorizationUrl
    || !checkoutUrl
  ) return null;

  const expectedOrigin = new URL(CMEM_INSTALLER_OAUTH_START_URL).origin;
  const loginNext = authorizationUrl.searchParams.get('next');
  if (
    !loginNext
    || !loginNext.startsWith('/')
    || loginNext.startsWith('//')
    || !hasExactSearchParams(authorizationUrl, { next: loginNext })
  ) return null;

  const loginClaim = parseBrowserUrl(`${expectedOrigin}${loginNext}`, '/api/pro/trial/claim');
  if (
    !loginClaim
    || !hasExactSearchParams(loginClaim, { pairing: pairingId, login_only: '1' })
    || !hasPairingAndTrialParams(checkoutUrl, pairingId)
  ) return null;

  const pollIntervalS =
    typeof b.poll_interval === 'number' && Number.isFinite(b.poll_interval) && b.poll_interval > 0
      ? Math.min(Math.max(b.poll_interval, 1), 30)
      : OAUTH_DEFAULT_POLL_INTERVAL_S;

  const expiresAt =
    typeof b.expires_in === 'number' && Number.isFinite(b.expires_in) && b.expires_in > 0
      ? Date.now() + Math.min(b.expires_in * 1000, OAUTH_POLL_BUDGET_MAX_MS)
      : undefined;

  return {
    pairingId,
    secret,
    userCode,
    authorizationUrl: authorizationUrl.toString(),
    checkoutUrl: checkoutUrl.toString(),
    pollIntervalMs: pollIntervalS * 1000,
    ...(expiresAt !== undefined ? { expiresAt } : {}),
  };
}

export type OAuthStartFailure = 'http_error' | 'network' | 'timeout' | 'bad_body';

// Why the most recent startInstallerOAuthPairing() returned null. A closed enum
// for the installer_oauth_start_failed telemetry event — never a URL, status
// text, or error message.
export let lastStartFailure: OAuthStartFailure | null = null;
export function lastOAuthStartFailure(): OAuthStartFailure | null {
  return lastStartFailure;
}

/** Starts an OAuth pairing. No email address or identity is accepted from the CLI. */
export async function startInstallerOAuthPairing(
  opts: { source?: string; timeoutMs?: number } = {},
): Promise<InstallerOAuthPairing | null> {
  const source = opts.source ?? 'npx-installer';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? OAUTH_START_TIMEOUT_MS);
  lastStartFailure = null;
  try {
    const response = await fetch(CMEM_INSTALLER_OAUTH_START_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source, device_name: hostname() }),
      signal: controller.signal,
    });
    if (!response.ok) {
      lastStartFailure = 'http_error';
      return null;
    }
    // A 2xx with unparseable JSON is a server-response problem, not a
    // connection failure; keep it out of the `network` bucket.
    let body: unknown;
    try {
      body = await response.json();
    } catch (error: unknown) {
      // The request timer can fire while the body is still streaming; that is
      // the same timeout as a stalled connect, not a malformed response.
      lastStartFailure = error instanceof Error && error.name === 'AbortError' ? 'timeout' : 'bad_body';
      return null;
    }
    const pairing = parseInstallerOAuthStartBody(body);
    if (!pairing) lastStartFailure = 'bad_body';
    return pairing;
  } catch (error: unknown) {
    lastStartFailure = error instanceof Error && error.name === 'AbortError' ? 'timeout' : 'network';
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Everything a ready poll delivers. The memory credentials are staged before
 * provider activation so one-shot delivery cannot be lost after enrollment.
 */
export interface TrialReadyResult {
  userId: string;
  setupToken: string;
  hubUrl: string;
  memoryKey: string;
  memoryBaseUrl: string;
  memoryModel: string;
  plan: TrialPlan;
  trialEndsAt: string | null;
}

export function buildTrialReadySettings(
  result: TrialReadyResult,
  deviceName: string = hostname(),
): Record<string, string> {
  return {
    CLAUDE_MEM_CLOUD_SYNC_TOKEN: result.setupToken,
    CLAUDE_MEM_CLOUD_SYNC_USER_ID: result.userId,
    CLAUDE_MEM_CLOUD_SYNC_HUB_URL: result.hubUrl,
    CLAUDE_MEM_CLOUD_SYNC_DEVICE_ID: '',
    CLAUDE_MEM_CLOUD_SYNC_DEVICE_NAME: deviceName,
    CLAUDE_MEM_PRO_TRIAL_STATE: 'active',
    CLAUDE_MEM_PRO_TRIAL_ENDS_AT: result.trialEndsAt ?? '',
    CLAUDE_MEM_PRO_PLAN: result.plan,
    CLAUDE_MEM_PRO_MEMORY_KEY: result.memoryKey,
    CLAUDE_MEM_PRO_MEMORY_BASE_URL: result.memoryBaseUrl,
    CLAUDE_MEM_PRO_MEMORY_MODEL: result.memoryModel,
    CLAUDE_MEM_PRO_FALLBACK_AT: '',
  };
}

export function parseTrialReadyBody(body: unknown): TrialReadyResult | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as {
    status?: unknown;
    user_id?: unknown;
    setup_token?: unknown;
    hub_url?: unknown;
    memory_key?: unknown;
    memory_base_url?: unknown;
    memory_model?: unknown;
    plan?: unknown;
    trial?: { ends_at?: unknown };
  };
  const userId = nonEmptyTrimmedString(b.user_id);
  const setupToken = nonEmptyTrimmedString(b.setup_token);
  const hubUrl = nonEmptyTrimmedString(b.hub_url);
  if (b.status !== 'ready' || !userId || !setupToken || !hubUrl) return null;

  return {
    userId,
    setupToken,
    hubUrl,
    memoryKey: nonEmptyTrimmedString(b.memory_key) ?? setupToken,
    memoryBaseUrl: nonEmptyTrimmedString(b.memory_base_url) ?? CMEM_PRO_BASE_URL,
    memoryModel: nonEmptyTrimmedString(b.memory_model) ?? CMEM_PRO_MODEL,
    plan: b.plan === 'trial' || b.plan === 'pro' || b.plan === 'none' ? b.plan : 'trial',
    trialEndsAt: nonEmptyTrimmedString(b.trial?.ends_at),
  };
}

export type InstallerPollOutcome =
  | { kind: 'authenticated'; userId: string }
  | { kind: 'pending'; stage: InstallerPollStage }
  | ({ kind: 'ready' } & TrialReadyResult)
  | { kind: 'gone' }
  | { kind: 'unreachable' };

export async function pollInstallerPairingOnce(pairing: InstallerOAuthPairing): Promise<InstallerPollOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OAUTH_POLL_TIMEOUT_MS);
  try {
    const response = await fetch(CMEM_INSTALLER_OAUTH_POLL_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pairing_id: pairing.pairingId, secret: pairing.secret }),
      signal: controller.signal,
    });
    if (response.status === 404 || response.status === 410) return { kind: 'gone' };

    const body = await response.json().catch(() => ({})) as {
      status?: unknown;
      stage?: unknown;
      user_id?: unknown;
    };
    if (response.status === 202) {
      const stage: InstallerPollStage =
        body.stage === 'awaiting_checkout' || body.stage === 'awaiting_approval'
          ? body.stage
          : 'awaiting_login';
      return { kind: 'pending', stage };
    }
    if (response.ok && body.status === 'authenticated') {
      const userId = nonEmptyTrimmedString(body.user_id);
      return userId ? { kind: 'authenticated', userId } : { kind: 'unreachable' };
    }
    if (response.ok) {
      const ready = parseTrialReadyBody(body);
      return ready ? { kind: 'ready', ...ready } : { kind: 'unreachable' };
    }
    return { kind: 'unreachable' };
  } catch {
    return { kind: 'unreachable' };
  } finally {
    clearTimeout(timer);
  }
}
