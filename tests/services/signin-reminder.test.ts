import { describe, expect, it } from 'bun:test';
import express from 'express';
import type { AddressInfo } from 'net';
import {
  REMINDER_SOURCE,
  resolveSigninReminder,
  type SigninReminderDeps,
} from '../../src/services/signin-reminder';
import { SigninRoutes } from '../../src/services/worker/http/routes/SigninRoutes';
import type { InstallerOAuthPairing } from '../../src/npx-cli/install/oauth-pairing';
import type { PendingSignin, SigninStateRecord } from '../../src/npx-cli/install/signin-state';

const NOW = Date.parse('2026-09-28T12:00:00Z');
const freshPairing: InstallerOAuthPairing = {
  pairingId: 'd'.repeat(32),
  secret: 'e'.repeat(48),
  userCode: 'ABCD-2345',
  authorizationUrl: 'https://cmem.ai/login?next=fresh',
  checkoutUrl: 'https://cmem.ai/api/pro/trial/claim?pairing=d&trial=30',
  pollIntervalMs: 3000,
  expiresAt: NOW + 30 * 60_000,
};
const oldPending: PendingSignin = {
  pairingId: 'a'.repeat(32),
  secret: 'b'.repeat(48),
  url: 'https://cmem.ai/login?next=old',
  expiresAt: new Date(NOW - 60_000).toISOString(),
  source: 'npx-installer-deferred-open',
  createdAt: '',
};

function fakeDeps(overrides: Partial<SigninReminderDeps> = {}) {
  const shown = new Set<string>();
  const log = { saved: [] as PendingSignin[], claimed: 0, starts: 0, polls: 0 };
  let state: SigninStateRecord | null = { state: 'unclaimed', arm: 'C', updatedAt: '' };
  const deps: SigninReminderDeps = {
    enabled: () => true,
    readState: () => state,
    readPending: () => oldPending,
    poll: async () => { log.polls++; return { kind: 'pending', stage: 'awaiting_login' }; },
    start: async () => { log.starts++; return freshPairing; },
    savePending: (p) => { log.saved.push(p); },
    markClaimed: () => { log.claimed++; state = { state: 'claimed', arm: 'C', updatedAt: '' }; },
    shownForSession: (id) => shown.has(id),
    markShown: (id) => { shown.add(id); },
    now: () => NOW,
    ...overrides,
  };
  return { deps, log };
}

describe('resolveSigninReminder', () => {
  it('shows a fresh npx-session-reminder link once per session', async () => {
    const { deps, log } = fakeDeps();
    expect(await resolveSigninReminder('s1', deps)).toEqual({ show: true, url: freshPairing.authorizationUrl, expiresIn: 1800 });
    expect(log.saved[0]).toMatchObject({ pairingId: freshPairing.pairingId, source: REMINDER_SOURCE });
    expect(await resolveSigninReminder('s1', deps)).toEqual({ show: false, reason: 'already-shown' });
    expect((await resolveSigninReminder('s2', deps)).show).toBe(true);
    expect(log.starts).toBe(2);
  });

  it('an authenticated previous pairing marks the install claimed and shows nothing', async () => {
    const { deps, log } = fakeDeps({ poll: async () => ({ kind: 'authenticated', userId: 'u' }) });
    expect(await resolveSigninReminder('s1', deps)).toEqual({ show: false, reason: 'claimed' });
    expect(log.claimed).toBe(1);
    expect(log.starts).toBe(0);
    expect(await resolveSigninReminder('s2', deps)).toEqual({ show: false, reason: 'not-unclaimed' });
  });

  it('never shows when claimed, dismissed, outside arm C, disabled, or without a state file', async () => {
    const cases: Array<[Partial<SigninReminderDeps>, string]> = [
      [{ readState: () => ({ state: 'claimed', arm: 'C', updatedAt: '' }) }, 'not-unclaimed'],
      [{ readState: () => ({ state: 'dismissed', arm: 'C', updatedAt: '' }) }, 'not-unclaimed'],
      [{ readState: () => ({ state: 'unclaimed', arm: 'A', updatedAt: '' }) }, 'arm'],
      [{ readState: () => ({ state: 'unclaimed', arm: 'B', updatedAt: '' }) }, 'arm'],
      [{ readState: () => null }, 'not-unclaimed'],
      [{ enabled: () => false }, 'disabled'],
    ];
    for (const [overrides, reason] of cases) {
      const { deps, log } = fakeDeps(overrides);
      expect(await resolveSigninReminder('s', deps)).toEqual({ show: false, reason } as never);
      expect(log.starts + log.polls).toBe(0);
    }
  });

  it('a pairing start that hangs past 3s gives no reminder (and does not mark the session)', async () => {
    const { deps, log } = fakeDeps({ start: () => new Promise(() => {}) });
    const started = Date.now();
    expect(await resolveSigninReminder('s1', deps)).toEqual({ show: false, reason: 'unavailable' });
    expect(Date.now() - started).toBeLessThan(8_000);
    expect(log.saved).toEqual([]);
    expect(deps.shownForSession('s1')).toBe(false);
  }, 15_000);

  it('a throwing dependency gives no reminder', async () => {
    const { deps } = fakeDeps({ start: async () => { throw new Error('boom'); } });
    expect(await resolveSigninReminder('s1', deps)).toEqual({ show: false, reason: 'unavailable' });
  });
});

describe('GET /api/signin/reminder', () => {
  async function serve(deps: SigninReminderDeps) {
    const app = express();
    new SigninRoutes(deps).setupRoutes(app);
    const server = app.listen(0);
    await new Promise((r) => server.once('listening', r));
    const port = (server.address() as AddressInfo).port;
    return { base: `http://127.0.0.1:${port}`, close: () => server.close() };
  }

  it('answers show:true with url/expires_in, then show:false for the same session', async () => {
    const { deps } = fakeDeps();
    const srv = await serve(deps);
    try {
      const first = await fetch(`${srv.base}/api/signin/reminder?session_id=abc`);
      expect(first.status).toBe(200);
      expect(await first.json()).toEqual({ show: true, url: freshPairing.authorizationUrl, expires_in: 1800 });
      const again = await (await fetch(`${srv.base}/api/signin/reminder?session_id=abc`)).json();
      expect(again).toEqual({ show: false, reason: 'already-shown' });
      const noSession = await (await fetch(`${srv.base}/api/signin/reminder`)).json();
      expect(noSession).toEqual({ show: false, reason: 'no-session' });
    } finally {
      srv.close();
    }
  });

  it('a pairing timeout yields an empty (show:false) reply, not an error', async () => {
    const { deps } = fakeDeps({ start: () => new Promise(() => {}) });
    const srv = await serve(deps);
    try {
      const res = await fetch(`${srv.base}/api/signin/reminder?session_id=t`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ show: false, reason: 'unavailable' });
    } finally {
      srv.close();
    }
  }, 15_000);
});
