import { beforeEach, describe, expect, it } from 'bun:test';
import { DEFAULT_REPLICA_FLY_APP_NAME_PREFIX } from '../src/defaults.js';
import { createGate, SESSION_COOKIE } from '../src/gate.js';
import { createRouter } from '../src/router.js';
import { perUserViewerLinkSecret, replicaFlyAppNameForUser, signToken } from '../src/token.js';

const MASTER = 'x'.repeat(40);
const PREFIX = DEFAULT_REPLICA_FLY_APP_NAME_PREFIX;
const SIGN_IN = 'https://cmem.example/work';
const ORIGIN = 'https://work.example';
const now = () => Math.floor(Date.now() / 1000);

const logged: string[] = [];
beforeEach(() => { logged.length = 0; });
const appFor = (userId: string) => replicaFlyAppNameForUser(MASTER, PREFIX, userId);
function router() {
  return createRouter({ masterSecret: MASTER, replicaFlyAppNamePrefix: PREFIX, publicOrigin: ORIGIN, signInUrl: SIGN_IN, log: message => logged.push(message) });
}

function session(sub: string, key = perUserViewerLinkSecret(MASTER, sub), exp = now() + 3600) {
  return `${SESSION_COOKIE}=${signToken(key, { sub, aud: 'session', exp })}`;
}

function get(path: string, headers: Record<string, string> = {}) {
  return router()(new Request(`${ORIGIN}${path}`, { headers }));
}

describe('per-account keys and app names', () => {
  // The same vectors are pinned in claude-mem-pro src/lib/viewer-host/link.ts's test (Phase 4):
  // cmem.ai and the router must derive the same key and app name for the same user.
  it('derives the fixed vectors', () => {
    const key = perUserViewerLinkSecret(MASTER, 'user-1');
    expect(key).toBe('6YVYFD9YYVAguxhXRr8nZFoW4SJgWwPxwkOyFn3fNl8');
    expect(key.length).toBe(43);
    expect(replicaFlyAppNameForUser(MASTER, PREFIX, 'user-1')).toBe('cmem-vw-e9f4a44e1da73154acd563c3');
    expect(signToken(key, { sub: 'user-1', aud: 'link', exp: 2_000_000_000 })).toBe('v1.eyJzdWIiOiJ1c2VyLTEiLCJhdWQiOiJsaW5rIiwiZXhwIjoyMDAwMDAwMDAwfQ.bXKhd0hd-ixssg5wNO8uM2gUPuOcOpwDI4OizkOBOMY');
  });

  it('gives each user a different key and app name', () => {
    expect(perUserViewerLinkSecret(MASTER, 'user-a')).not.toBe(perUserViewerLinkSecret(MASTER, 'user-b'));
    expect(appFor('user-a')).not.toBe(appFor('user-b'));
    expect(appFor('user-a')).toMatch(/^cmem-vw-[0-9a-f]{24}$/);
    // Keyed: another master secret gives another name, so names can't be worked out from user ids alone.
    expect(replicaFlyAppNameForUser('y'.repeat(40), PREFIX, 'user-a')).not.toBe(appFor('user-a'));
  });
});

describe('router', () => {
  it('answers /health itself, without a token', async () => {
    const response = get('/health');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, role: 'router' });
    expect(response.headers.get('fly-replay')).toBeNull();
  });

  it('replays a valid session to that user\'s own app, with no body', async () => {
    const response = get('/api/work-view', { cookie: session('user-a') });
    expect(response.headers.get('fly-replay')).toBe(`app=${appFor('user-a')};fallback=force_self`);
    expect(await response.text()).toBe('');
  });

  it('replays a valid /auth link to that user\'s app', () => {
    const link = signToken(perUserViewerLinkSecret(MASTER, 'user-a'), { sub: 'user-a', aud: 'link', exp: now() + 120 });
    const response = get(`/auth?t=${encodeURIComponent(link)}`);
    expect(response.headers.get('fly-replay')).toBe(`app=${appFor('user-a')};fallback=force_self`);
  });

  it('round trip: the account gate trades the link for a session, and the router replays that session to the same app', async () => {
    const accountGate = createGate({
      ownerUserId: 'user-a',
      secret: perUserViewerLinkSecret(MASTER, 'user-a'),
      upstreamOrigin: 'http://127.0.0.1:9', // never reached: /auth is answered by the gate itself
      publicOrigin: ORIGIN,
      signInUrl: SIGN_IN,
    });
    const link = signToken(perUserViewerLinkSecret(MASTER, 'user-a'), { sub: 'user-a', aud: 'link', exp: now() + 120 });
    expect(get(`/auth?t=${encodeURIComponent(link)}`).headers.get('fly-replay')).toBe(`app=${appFor('user-a')};fallback=force_self`);
    const traded = await accountGate(new Request(`${ORIGIN}/auth?t=${encodeURIComponent(link)}`));
    expect(traded.status).toBe(303);
    const setCookie = traded.headers.get('set-cookie') ?? '';
    expect(setCookie.startsWith(`${SESSION_COOKIE}=v1.`)).toBe(true);
    const sessionCookie = setCookie.split(';')[0];
    const replayed = get('/api/work-view', { cookie: sessionCookie });
    expect(replayed.headers.get('fly-replay')).toBe(`app=${appFor('user-a')};fallback=force_self`);
  });

  it('refuses a session signed with the master secret itself', () => {
    const response = get('/api/work-view', { cookie: session('user-a', MASTER) });
    expect(response.status).toBe(401);
    expect(response.headers.get('fly-replay')).toBeNull();
  });

  it('refuses a session for user A signed with user B\'s key', () => {
    const response = get('/api/work-view', { cookie: session('user-a', perUserViewerLinkSecret(MASTER, 'user-b')) });
    expect(response.status).toBe(401);
    expect(response.headers.get('fly-replay')).toBeNull();
  });

  it('refuses an expired session and an expired link', () => {
    const expired = get('/api/work-view', { cookie: session('user-a', undefined, now() - 1) });
    expect(expired.status).toBe(401);
    expect(expired.headers.get('fly-replay')).toBeNull();
    const link = signToken(perUserViewerLinkSecret(MASTER, 'user-a'), { sub: 'user-a', aud: 'link', exp: now() - 1 });
    const expiredLink = get(`/auth?t=${encodeURIComponent(link)}`);
    expect(expiredLink.status).toBe(403);
    expect(expiredLink.headers.get('fly-replay')).toBeNull();
  });

  it('refuses a link used as a session and a session used as a link', () => {
    const key = perUserViewerLinkSecret(MASTER, 'user-a');
    const link = signToken(key, { sub: 'user-a', aud: 'link', exp: now() + 120 });
    expect(get('/api/work-view', { cookie: `${SESSION_COOKIE}=${link}` }).status).toBe(401);
    const sessionToken = signToken(key, { sub: 'user-a', aud: 'session', exp: now() + 120 });
    expect(get(`/auth?t=${encodeURIComponent(sessionToken)}`).status).toBe(403);
  });

  it('sends a page without a session to sign in, and an API call gets 401', () => {
    const pageResponse = get('/', { accept: 'text/html' });
    expect(pageResponse.status).toBe(302);
    expect(pageResponse.headers.get('location')).toBe(SIGN_IN);
    expect(get('/api/work-view').status).toBe(401);
    expect(get('/api/work-view', { cookie: `${SESSION_COOKIE}=garbage` }).status).toBe(401);
  });

  it('answers a failed replay with the 503 page and never replays again', async () => {
    const response = get('/', {
      cookie: session('user-a'),
      accept: 'text/html',
      'fly-replay-failed': 'instance=00bb33ff;app=cmem-vw-abc;region=iad;replay_source=11aa44ee;reason=timeout;elapsed_ms=10000',
    });
    expect(response.status).toBe(503);
    expect(response.headers.get('fly-replay')).toBeNull();
    const html = await response.text();
    expect(html).toContain('Your viewer is not available right now');
    expect(html).toContain(`href="${SIGN_IN}"`);
    expect(logged.join('\n')).toContain('reason=timeout');
  });

  it('treats a failed-replay header without a valid token like any unauthenticated request, and logs nothing', () => {
    const response = get('/api/work-view', { 'fly-replay-failed': 'reason=timeout;app=cmem-vw-abc' });
    expect(response.status).toBe(401);
    expect(response.headers.get('fly-replay')).toBeNull();
    expect(logged).toEqual([]);
  });

  it('answers 413 for a body Fly cannot replay', () => {
    const response = router()(new Request(`${ORIGIN}/api/work-view/review`, {
      method: 'POST',
      headers: { cookie: session('user-a'), 'content-length': String(2 * 1024 * 1024) },
    }));
    expect(response.status).toBe(413);
    expect(response.headers.get('fly-replay')).toBeNull();
  });

  it('answers 413 for a write whose body length cannot be checked', () => {
    const post = (headers: Record<string, string>) => {
      const request = new Request(`${ORIGIN}/api/work-view/review`, { method: 'POST', headers: { cookie: session('user-a'), ...headers } });
      for (const [name, value] of Object.entries(headers)) expect(request.headers.get(name)).toBe(value);
      return router()(request);
    };
    const uncheckable: Record<string, string>[] = [{ 'transfer-encoding': 'chunked' }, { 'content-length': 'abc' }, { 'content-length': '-1' }, { 'content-length': '1e3' }];
    for (const headers of uncheckable) {
      const response = post(headers);
      expect(response.status).toBe(413);
      expect(response.headers.get('fly-replay')).toBeNull();
    }
    expect(post({ 'content-length': '12' }).headers.get('fly-replay')).toBe(`app=${appFor('user-a')};fallback=force_self`);
    expect(post({}).headers.get('fly-replay')).toBe(`app=${appFor('user-a')};fallback=force_self`);
  });

  it('logs out by clearing the session cookie', () => {
    const response = router()(new Request(`${ORIGIN}/logout`, { method: 'POST' }));
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(SIGN_IN);
    expect(response.headers.get('set-cookie')).toContain(`${SESSION_COOKIE}=;`);
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
    expect(response.headers.get('fly-replay')).toBeNull();
  });
});

describe('VIEWER_ROLE', () => {
  it('must be exactly router or account: anything else stops the host at start', () => {
    for (const role of [undefined, '', 'Router', ' router', 'viewer']) {
      const env: Record<string, string> = { PATH: process.env.PATH ?? '', VIEWER_LINK_SECRET: MASTER };
      if (role !== undefined) env.VIEWER_ROLE = role;
      const run = Bun.spawnSync([process.execPath, `${import.meta.dir}/../src/index.ts`], { env });
      expect(run.exitCode).not.toBe(0);
      expect(run.stderr.toString()).toContain('VIEWER_ROLE must be "router" or "account"');
    }
  });
});
