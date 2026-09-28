/**
 * SessionStart sign-in reminder for agent-run installs in experiment arm C.
 *
 * Only installs that went through the deferred sign-in offer are ever
 * `unclaimed`, so existing users are never nagged. Per session, at most once:
 *   1. the previous pending pairing is polled; `authenticated` marks the
 *      install `claimed` and shows nothing;
 *   2. otherwise a fresh login-only pairing (source npx-session-reminder)
 *      gives a link that is valid for the whole reminder window.
 * Any failure or timeout means no reminder, never an error.
 */

import {
  pollInstallerPairingOnce,
  startInstallerOAuthPairing,
  type InstallerOAuthPairing,
  type InstallerPollOutcome,
} from '../npx-cli/install/oauth-pairing.js';
import { armShowsReminder } from '../npx-cli/install/signin-arm.js';
import {
  markReminderShown,
  readPendingSignin,
  readSigninState,
  reminderShownForSession,
  savePendingSignin,
  writeSigninState,
  type PendingSignin,
  type SigninStateRecord,
} from '../npx-cli/install/signin-state.js';

export const REMINDER_SOURCE = 'npx-session-reminder';
export const REMINDER_TIMEOUT_MS = 3_000;
const PAIRING_TTL_FALLBACK_MS = 30 * 60 * 1000;

export type SigninReminder =
  | { show: false; reason: 'disabled' | 'no-session' | 'not-unclaimed' | 'arm' | 'already-shown' | 'claimed' | 'unavailable' }
  | { show: true; url: string; expiresIn: number };

export interface SigninReminderDeps {
  enabled: () => boolean;
  readState: () => SigninStateRecord | null;
  readPending: () => PendingSignin | null;
  poll: (pairing: InstallerOAuthPairing) => Promise<InstallerPollOutcome>;
  start: () => Promise<InstallerOAuthPairing | null>;
  savePending: (pending: PendingSignin) => void;
  markClaimed: () => void;
  shownForSession: (sessionId: string) => boolean;
  markShown: (sessionId: string) => void;
  now: () => number;
}

/** Resolves to `fallback` if `promise` has not settled within `ms`. */
function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      () => { clearTimeout(timer); resolve(fallback); },
    );
  });
}

export async function resolveSigninReminder(sessionId: string, deps: SigninReminderDeps): Promise<SigninReminder> {
  try {
    if (!deps.enabled()) return { show: false, reason: 'disabled' };
    if (!sessionId) return { show: false, reason: 'no-session' };
    const state = deps.readState();
    if (!state || state.state !== 'unclaimed') return { show: false, reason: 'not-unclaimed' };
    if (!state.arm || !armShowsReminder(state.arm)) return { show: false, reason: 'arm' };
    if (deps.shownForSession(sessionId)) return { show: false, reason: 'already-shown' };

    const previous = deps.readPending();
    if (previous) {
      const outcome = await withTimeout<InstallerPollOutcome>(deps.poll({
        pairingId: previous.pairingId,
        secret: previous.secret,
        userCode: '',
        authorizationUrl: previous.url,
        checkoutUrl: '',
        pollIntervalMs: 0,
      }), REMINDER_TIMEOUT_MS, { kind: 'unreachable' });
      if (outcome.kind === 'authenticated' || outcome.kind === 'ready') {
        deps.markClaimed();
        return { show: false, reason: 'claimed' };
      }
    }

    const pairing = await withTimeout(deps.start(), REMINDER_TIMEOUT_MS, null);
    if (!pairing) return { show: false, reason: 'unavailable' };
    const expiresAt = pairing.expiresAt ?? deps.now() + PAIRING_TTL_FALLBACK_MS;
    deps.savePending({
      pairingId: pairing.pairingId,
      secret: pairing.secret,
      url: pairing.authorizationUrl,
      expiresAt: new Date(expiresAt).toISOString(),
      source: REMINDER_SOURCE,
      createdAt: new Date(deps.now()).toISOString(),
    });
    deps.markShown(sessionId);
    return { show: true, url: pairing.authorizationUrl, expiresIn: Math.round((expiresAt - deps.now()) / 1000) };
  } catch {
    // [ANTI-PATTERN IGNORED]: the reminder is optional; any failure means no reminder, never a hook error.
    return { show: false, reason: 'unavailable' };
  }
}

export function defaultSigninReminderDeps(enabled: () => boolean): SigninReminderDeps {
  return {
    enabled,
    readState: readSigninState,
    readPending: readPendingSignin,
    poll: pollInstallerPairingOnce,
    start: () => startInstallerOAuthPairing({ source: REMINDER_SOURCE, timeoutMs: REMINDER_TIMEOUT_MS }),
    savePending: savePendingSignin,
    markClaimed: () => { writeSigninState('claimed'); },
    shownForSession: reminderShownForSession,
    markShown: markReminderShown,
    now: Date.now,
  };
}

/** Human line (systemMessage) and model line (additionalContext) for a shown reminder. */
export function formatSigninReminder(url: string, expiresIn: number): { systemMessage: string; additionalContext: string } {
  const minutes = Math.max(1, Math.round(expiresIn / 60));
  return {
    systemMessage: `claude-mem: sign-in not finished (free). Link, valid ${minutes} min: ${url}`,
    additionalContext: `claude-mem sign-in is not finished for this install. The user can finish it here (valid ${minutes} min): ${url}. New link: npx claude-mem login --request.`,
  };
}
