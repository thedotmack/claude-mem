import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { createGate, isAllowed, SESSION_COOKIE } from '../src/gate.js';
import { signToken, verifyToken } from '../src/token.js';

const SECRET = 'x'.repeat(40);
const OWNER = 'user-owner';
const PUBLIC_ORIGIN = 'https://viewer.example';
const SIGN_IN = 'https://cmem.example/work';
const now = () => Math.floor(Date.now() / 1000);

interface Seen { method: string; path: string; headers: Record<string, string>; body: string }
let seen: Seen[] = [];
let upstream: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  upstream = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request) {
      const url = new URL(request.url);
      const headers: Record<string, string> = {};
      request.headers.forEach((value, name) => { headers[name] = value; });
      seen.push({ method: request.method, path: `${url.pathname}${url.search}`, headers, body: await request.text() });
      if (url.pathname === '/api/health') return Response.json({ status: 'ok' });
      if (url.pathname === '/api/work-view/events') {
        return new Response(new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('event: heartbeat\ndata: {}\n\n'));
            controller.close();
          },
        }), { headers: { 'Content-Type': 'text/event-stream' } });
      }
      return new Response(JSON.stringify({ ok: true }), {
        headers: { 'Content-Type': 'application/json', 'Set-Cookie': 'worker=leak', 'X-Upstream': 'kept' },
      });
    },
  });
});

afterAll(() => upstream.stop(true));

function gate() {
  return createGate({ ownerUserId: OWNER, secret: SECRET, upstreamOrigin: `http://127.0.0.1:${upstream.port}`, publicOrigin: PUBLIC_ORIGIN, signInUrl: SIGN_IN });
}

function sessionCookie(sub = OWNER, exp = now() + 3600) {
  return `${SESSION_COOKIE}=${signToken(SECRET, { sub, aud: 'session', exp })}`;
}

describe('tokens', () => {
  it('round-trips and rejects tampering, another audience, another secret and expiry', () => {
    const token = signToken(SECRET, { sub: OWNER, aud: 'link', exp: now() + 60 });
    expect(verifyToken(SECRET, token, 'link')?.sub).toBe(OWNER);
    expect(verifyToken(SECRET, token, 'session')).toBeNull();
    expect(verifyToken('y'.repeat(40), token, 'link')).toBeNull();
    const [v, payload, sig] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ sub: 'someone-else', aud: 'link', exp: now() + 60 })).toString('base64url');
    expect(verifyToken(SECRET, `${v}.${forged}.${sig}`, 'link')).toBeNull();
    expect(verifyToken(SECRET, `${v}.${payload}`, 'link')).toBeNull();
    expect(verifyToken(SECRET, signToken(SECRET, { sub: OWNER, aud: 'link', exp: now() - 1 }), 'link')).toBeNull();
  });
});

describe('token interop', () => {
  // The same vector is in claude-mem-pro scripts/test-viewer-link.ts: cmem.ai's links must verify here.
  it('verifies the link cmem.ai mints for the same claims', () => {
    expect(signToken(SECRET, { sub: 'user-1', aud: 'link', exp: 2_000_000_000 })).toBe('v1.eyJzdWIiOiJ1c2VyLTEiLCJhdWQiOiJsaW5rIiwiZXhwIjoyMDAwMDAwMDAwfQ.61EKU4CPNr1riCae6rUoImSRPkc1jYS1v7jZhrb0E6E');
    expect(verifyToken(SECRET, 'v1.eyJzdWIiOiJ1c2VyLTEiLCJhdWQiOiJsaW5rIiwiZXhwIjoyMDAwMDAwMDAwfQ.61EKU4CPNr1riCae6rUoImSRPkc1jYS1v7jZhrb0E6E', 'link', 1_900_000_000)?.sub).toBe('user-1');
  });
});

describe('policy', () => {
  it('reads pass except machine configuration; only My Work saves may write', () => {
    expect(isAllowed('GET', '/')).toBe(true);
    expect(isAllowed('GET', '/api/work-view')).toBe(true);
    expect(isAllowed('GET', '/viewer')).toBe(true);
    expect(isAllowed('GET', '/api/settings')).toBe(false);
    expect(isAllowed('GET', '/api/settings/dependency-health')).toBe(false);
    expect(isAllowed('GET', '/api/logs')).toBe(false);
    expect(isAllowed('GET', '/api/setup/state')).toBe(false);
    expect(isAllowed('GET', '/restart')).toBe(false);
    expect(isAllowed('POST', '/api/work-view/review')).toBe(true);
    expect(isAllowed('POST', '/api/work-view/focus')).toBe(true);
    expect(isAllowed('POST', '/api/work-view/rules/load-in-claude-code')).toBe(false);
    expect(isAllowed('POST', '/api/settings')).toBe(false);
    expect(isAllowed('POST', '/api/admin/shutdown')).toBe(false);
    expect(isAllowed('DELETE', '/api/observation/1')).toBe(false);
    // The worker's router ignores case and decodes escapes; the policy reads the path the same way.
    expect(isAllowed('GET', '/API/SETTINGS')).toBe(false);
    expect(isAllowed('GET', '/Api/Logs')).toBe(false);
    expect(isAllowed('GET', '/api/%73ettings')).toBe(false);
    expect(isAllowed('GET', '/api/%zz')).toBe(false);
    expect(isAllowed('GET', '//127.0.0.1:37777/api/settings')).toBe(false);
    expect(isAllowed('GET', '/api/work-view/%2e%2e/settings')).toBe(false);
    expect(isAllowed('POST', '/API/WORK-VIEW/REVIEW')).toBe(true);
  });
});

describe('gate', () => {
  it('sends a page visit without a session to cmem.ai to sign in, and an API call gets 401', async () => {
    const page = await gate()(new Request(`${PUBLIC_ORIGIN}/`, { headers: { Accept: 'text/html' } }));
    expect(page.status).toBe(302);
    expect(page.headers.get('Location')).toBe(SIGN_IN);
    const api = await gate()(new Request(`${PUBLIC_ORIGIN}/api/work-view`));
    expect(api.status).toBe(401);
    expect(seen.filter(request => request.path === '/api/work-view')).toHaveLength(0);
  });

  it("trades the owner's link for a session cookie, and refuses anyone else's", async () => {
    const link = signToken(SECRET, { sub: OWNER, aud: 'link', exp: now() + 120 });
    const response = await gate()(new Request(`${PUBLIC_ORIGIN}/auth?t=${link}`));
    expect(response.status).toBe(303);
    expect(response.headers.get('Location')).toBe('/');
    const cookie = response.headers.get('Set-Cookie') ?? '';
    expect(cookie).toContain(`${SESSION_COOKIE}=`);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=Lax');
    const session = cookie.split(';')[0].split('=').slice(1).join('=');
    expect(verifyToken(SECRET, session, 'session')?.sub).toBe(OWNER);

    const stranger = signToken(SECRET, { sub: 'someone-else', aud: 'link', exp: now() + 120 });
    expect((await gate()(new Request(`${PUBLIC_ORIGIN}/auth?t=${stranger}`))).status).toBe(403);
    // A session token cannot be used as a link.
    expect((await gate()(new Request(`${PUBLIC_ORIGIN}/auth?t=${session}`))).status).toBe(403);
  });

  it('opens one session per link', async () => {
    const g = gate();
    const link = signToken(SECRET, { sub: OWNER, aud: 'link', exp: now() + 120 });
    expect((await g(new Request(`${PUBLIC_ORIGIN}/auth?t=${link}`))).status).toBe(303);
    expect((await g(new Request(`${PUBLIC_ORIGIN}/auth?t=${link}`))).status).toBe(403);
  });

  it('never lets the path pick another host', async () => {
    seen = [];
    const response = await gate()(new Request(`${PUBLIC_ORIGIN}//127.0.0.1:${upstream.port}/api/settings`, { headers: { Cookie: sessionCookie() } }));
    expect(response.status).toBe(403);
    const upper = await gate()(new Request(`${PUBLIC_ORIGIN}/API/SETTINGS`, { headers: { Cookie: sessionCookie() } }));
    expect(upper.status).toBe(403);
    expect(seen).toHaveLength(0);
  });

  it("refuses another user's session", async () => {
    const response = await gate()(new Request(`${PUBLIC_ORIGIN}/api/work-view`, { headers: { Cookie: sessionCookie('someone-else') } }));
    expect(response.status).toBe(401);
  });

  it('forwards a read as a loopback request: worker Host, no proxy headers, no cookies', async () => {
    seen = [];
    const response = await gate()(new Request(`${PUBLIC_ORIGIN}/api/work-view?x=1`, {
      headers: {
        Cookie: `${sessionCookie()}; other=1`,
        'X-Forwarded-For': '203.0.113.9',
        'X-Forwarded-Host': 'viewer.example',
        Forwarded: 'for=203.0.113.9',
        'X-Real-IP': '203.0.113.9',
        'Fly-Client-IP': '203.0.113.9',
        Via: '1.1 fly.io',
        Accept: 'application/json',
      },
    }));
    expect(response.status).toBe(200);
    expect(response.headers.get('X-Upstream')).toBe('kept');
    expect(response.headers.get('Set-Cookie')).toBeNull();
    expect(response.headers.get('X-Frame-Options')).toBe('DENY');
    expect(seen).toHaveLength(1);
    const forwarded = seen[0];
    expect(forwarded.path).toBe('/api/work-view?x=1');
    expect(forwarded.headers.host).toBe(`127.0.0.1:${upstream.port}`);
    expect(forwarded.headers.accept).toBe('application/json');
    for (const name of ['cookie', 'x-forwarded-for', 'x-forwarded-host', 'forwarded', 'x-real-ip', 'fly-client-ip', 'via', 'origin']) {
      expect(forwarded.headers[name]).toBeUndefined();
    }
  });

  it('blocks machine configuration even for the owner', async () => {
    seen = [];
    const response = await gate()(new Request(`${PUBLIC_ORIGIN}/api/settings`, { headers: { Cookie: sessionCookie() } }));
    expect(response.status).toBe(403);
    expect(seen).toHaveLength(0);
  });

  it('passes a My Work save from its own page with a loopback Origin, and refuses one from anywhere else', async () => {
    seen = [];
    const body = JSON.stringify({ requestId: 'r1', expectedFingerprint: 'a'.repeat(64), checked: true });
    const ok = await gate()(new Request(`${PUBLIC_ORIGIN}/api/work-view/review`, {
      method: 'POST',
      headers: { Cookie: sessionCookie(), Origin: PUBLIC_ORIGIN, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json' },
      body,
    }));
    expect(ok.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0].method).toBe('POST');
    expect(seen[0].headers.origin).toBe(`http://127.0.0.1:${upstream.port}`);
    expect(seen[0].headers['content-type']).toBe('application/json');
    expect(seen[0].body).toBe(body);

    const foreign = await gate()(new Request(`${PUBLIC_ORIGIN}/api/work-view/review`, {
      method: 'POST',
      headers: { Cookie: sessionCookie(), Origin: 'https://evil.example', 'Content-Type': 'application/json' },
      body,
    }));
    expect(foreign.status).toBe(403);
    const noOrigin = await gate()(new Request(`${PUBLIC_ORIGIN}/api/work-view/review`, {
      method: 'POST',
      headers: { Cookie: sessionCookie(), 'Content-Type': 'application/json' },
      body,
    }));
    expect(noOrigin.status).toBe(403);
    expect(seen).toHaveLength(1);
  });

  it('streams the live feed through', async () => {
    const response = await gate()(new Request(`${PUBLIC_ORIGIN}/api/work-view/events`, { headers: { Cookie: sessionCookie() } }));
    expect(response.headers.get('Content-Type')).toBe('text/event-stream');
    expect(await response.text()).toContain('event: heartbeat');
  });

  it('reports health from the worker without a session', async () => {
    const response = await gate()(new Request(`${PUBLIC_ORIGIN}/health`));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, worker: 'ready' });
  });

  it('stays healthy while the worker is too busy to answer', async () => {
    const slow: typeof fetch = (_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
    });
    const busy = createGate({ ownerUserId: OWNER, secret: SECRET, upstreamOrigin: 'http://127.0.0.1:37777', publicOrigin: PUBLIC_ORIGIN, signInUrl: SIGN_IN, fetchImpl: slow });
    const started = Date.now();
    const response = await busy(new Request(`${PUBLIC_ORIGIN}/health`));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, worker: 'busy' });
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('says the viewer is starting while the worker is down', async () => {
    const down = createGate({ ownerUserId: OWNER, secret: SECRET, upstreamOrigin: 'http://127.0.0.1:1', publicOrigin: PUBLIC_ORIGIN, signInUrl: SIGN_IN });
    const health = await down(new Request(`${PUBLIC_ORIGIN}/health`));
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true, worker: 'down' });
    const page = await down(new Request(`${PUBLIC_ORIGIN}/`, { headers: { Cookie: sessionCookie(), Accept: 'text/html' } }));
    expect(page.status).toBe(503);
    expect(await page.text()).toContain('starting');
  });
});
