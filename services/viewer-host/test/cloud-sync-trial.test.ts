import { describe, expect, it } from 'bun:test';
import { createGate, SESSION_COOKIE } from '../src/gate.js';
import { signToken } from '../src/token.js';
import { NO_VIEWER_TRIAL } from '../src/cloud-trial.js';

const secret = 'test-secret-for-one-owner'.repeat(2);
const owner = 'test-owner';
const origin = 'https://work.example';
const now = Date.parse('2026-01-03T12:00:00Z');
const end = '2026-01-30T12:00:00.000Z';

function gate(billingFetch: typeof fetch, token = 'replica-sync-token') {
  return createGate({
    ownerUserId: owner, secret, publicOrigin: origin, signInUrl: 'https://cmem.ai/work', upstreamOrigin: 'http://127.0.0.1:1',
    now: () => now, env: { CLAUDE_MEM_CLOUD_SYNC_TOKEN: token }, billingFetch,
  });
}

function readTrial(userId: string | null, method = 'GET') {
  const headers = new Headers({ 'X-Viewer-Owner': 'spoof', Authorization: 'Bearer browser-value' });
  if (userId) headers.set('Cookie', SESSION_COOKIE + '=' + signToken(secret, { sub: userId, aud: 'session', exp: now / 1000 + 3600 }));
  return new Request(origin + '/api/viewer/cloud-sync-trial?user=spoof', { method, headers });
}

describe('private Work View trial banner', () => {
  it('uses the authenticated replica and returns only the date', async () => {
    const calls: Request[] = [];
    const g = gate(async (input, init) => {
      calls.push(new Request(input, init));
      return Response.json({ trialEndsAt: end, privateBillingValue: 'redacted' });
    });
    const response = await g(readTrial(owner));
    expect(await response.json()).toEqual({ trialEndsAt: end, onboarding: null });
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call.url).toBe('https://cmem.ai/api/cloud-sync/renewal-status');
    expect(call.redirect).toBe('error');
    expect(call.headers.get('Authorization')).toBe('Bearer replica-sync-token');
    expect(call.headers.get('X-Viewer-Owner')).toBe(owner);
    expect(call.headers.get('Cookie')).toBeNull();
  });

  it('keeps the guide when renewal is authorized and strips account data and invalid windows', async () => {
    const startedAt = '2026-01-01T12:00:00.000Z';
    const onboard = (start: unknown, finish: unknown) => gate(async () => Response.json({
      trialEndsAt: null, onboarding: { startedAt: start, endsAt: finish, customer: 'private' }, price: 'private',
    }))(readTrial(owner));
    expect(await (await onboard(startedAt, end)).json()).toEqual({ trialEndsAt: null, onboarding: { startedAt, endsAt: end } });
    for (const [start, finish] of [[end, end], [startedAt, startedAt], ['invalid', end], [null, end]]) {
      expect(await (await onboard(start, finish)).json()).toEqual(NO_VIEWER_TRIAL);
    }
  });

  it('only reads billing for an authenticated owner making a GET', async () => {
    let reads = 0;
    const g = gate(async () => { reads++; return Response.json({ trialEndsAt: end }); });
    for (const visitor of [null, 'another-owner']) expect((await g(readTrial(visitor))).status).toBe(401);
    expect((await g(readTrial(owner, 'POST'))).status).toBe(405);
    expect(reads).toBe(0);
  });

  it('keeps the account that opened card setup when a browser has another cmem.ai session', async () => {
    const g = gate(async () => { throw new Error('unexpected billing read'); });
    const link = (userId: string | null) => new Request(origin + '/api/viewer/cloud-sync-renew?owner=spoof', {
      headers: readTrial(userId).headers,
    });
    for (const visitor of [null, 'another-owner']) expect((await g(link(visitor))).status).toBe(401);
    const redirect = await g(link(owner));
    expect(redirect.status).toBe(303);
    expect(redirect.headers.get('Location')).toBe('https://cmem.ai/cloud-sync/renew?owner=test-owner');
    expect(redirect.headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(redirect.headers.get('Cache-Control')).toBe('no-store');
  });

  it('hides the banner for paid and expired accounts and on billing outages', async () => {
    const replies = [
      () => Response.json({ trialEndsAt: null }),
      () => Response.json({ trialEndsAt: '2026-01-03T12:00:00Z' }),
      () => Response.json({ trialEndsAt: 'invalid' }),
      () => new Response('', { status: 503 }),
      () => { throw new Error('billing unavailable'); },
    ];
    for (const reply of replies) {
      const response = await gate(async () => reply())(readTrial(owner));
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(NO_VIEWER_TRIAL);
    }
    let reads = 0;
    const noToken = gate(async () => { reads++; return Response.json({ trialEndsAt: end }); }, '');
    expect(await (await noToken(readTrial(owner))).json()).toEqual(NO_VIEWER_TRIAL);
    expect(reads).toBe(0);
  });
});
