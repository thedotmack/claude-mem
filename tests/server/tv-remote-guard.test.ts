// SPDX-License-Identifier: Apache-2.0
//
// Observation TV read-only broadcast guard.
//
// The worker's HTTP surface has no request authentication; its only defence is
// the loopback bind. When the operator opens that bind so a second device can
// watch Observation TV, `createRemoteReadOnlyGuard` is the whole security
// boundary. These tests cover the 23 cases the plan requires: loopback is never
// gated, and every non-loopback request is default-denied except an exact-match
// allowlist of four read-only paths behind a shared secret.
//
// The pure `decideRemoteAccess` carries the policy so it can be exercised
// without a second network interface (the same shape as
// `assertServerRuntimeForCli` in server-runtime-guard.test.ts). The HTTP tests
// reach the non-loopback branch by sending `X-Forwarded-For`: the guard refuses
// a loopback claim that arrived with a forwarded-client header, which is both
// case 23 and the only way to drive the real token-extraction path in-process.

import { afterAll, beforeAll, describe, expect, it, spyOn } from 'bun:test';
import type { Application, Request, Response } from 'express';
import { logger } from '../../src/utils/logger.js';
import { Server, type ServerOptions } from '../../src/services/server/Server.js';
import { decideRemoteAccess, generateTvToken } from '../../src/services/worker/http/middleware.js';

const TOKEN = 'tv-test-secret-token';
const REMOTE = { 'x-forwarded-for': '203.0.113.5' };

function baseOptions(overrides: Partial<ServerOptions> = {}): ServerOptions {
  return {
    getInitializationComplete: () => true,
    getMcpReady: () => true,
    onShutdown: () => Promise.resolve(),
    onRestart: () => Promise.resolve(),
    workerPath: '/test/worker-service.cjs',
    getAiStatus: () => ({ provider: 'disabled', authMethod: 'api-key', lastInteraction: null }),
    ...overrides,
  };
}

// Stubs for the routes the real worker mounts after construction, so an
// allowed request lands on a handler instead of Express's default 404.
const stubRoutes = {
  setupRoutes(app: Application): void {
    const ok = (_req: Request, res: Response) => { res.json({ stub: true }); };
    app.get('/api/settings', ok);
    app.get('/api/observations', ok);
    app.get('/api/observations/by-file', ok);
    app.get('/api/logs', ok);
    app.get('/api/auth/session', ok);
    app.get('/v1/info', ok);
    app.get('/viewer.html', ok);
    app.get('/restart', ok);
    app.get('/tv', ok);
    app.get('/tv.html', ok);
    app.get('/stream', ok);
    app.post('/api/settings', ok);
    app.post('/api/observations/batch', ok);
    app.delete('/api/observation/:id', ok);
    app.get('/', ok);
  },
};

let guarded: Server;
let guardedPort = 0;
let unguarded: Server;
let unguardedPort = 0;
let emptyToken: Server;
let emptyTokenPort = 0;
let spies: ReturnType<typeof spyOn>[] = [];

async function start(options: ServerOptions): Promise<{ server: Server; port: number }> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 12; attempt++) {
    const server = new Server(options);
    const port = 41000 + Math.floor(Math.random() * 9000);
    try {
      await server.listen(port, '127.0.0.1');
      server.registerRoutes(stubRoutes);
      return { server, port };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

beforeAll(async () => {
  spies = [
    spyOn(logger, 'info').mockImplementation(() => {}),
    spyOn(logger, 'warn').mockImplementation(() => {}),
    spyOn(logger, 'debug').mockImplementation(() => {}),
    // POST /api/admin/restart answers through flushResponseThen, whose
    // `finish` handler calls process.exit(0). Case 2 exercises that route on
    // loopback, so the exit is neutered for the length of this file — without
    // it the runner dies mid-suite and reports nothing.
    spyOn(process, 'exit').mockImplementation(() => undefined as never),
  ];

  ({ server: guarded, port: guardedPort } = await start(
    baseOptions({ remoteReadOnly: { getToken: () => TOKEN } }),
  ));
  ({ server: unguarded, port: unguardedPort } = await start(baseOptions()));
  ({ server: emptyToken, port: emptyTokenPort } = await start(
    baseOptions({ remoteReadOnly: { getToken: () => '' } }),
  ));
});

afterAll(async () => {
  for (const server of [guarded, unguarded, emptyToken]) {
    if (server?.getHttpServer()) {
      try { await server.close(); } catch { /* ignore */ }
    }
  }
  spies.forEach(s => s.mockRestore());
  spies = [];
});

function url(path: string): string {
  return `http://127.0.0.1:${guardedPort}${path}`;
}

// A request that passes the guard is stamped `Cache-Control: no-store`, which
// makes "allowed" observable independently of whatever handler runs next.
function allowed(res: globalThis.Response): boolean {
  return res.headers.get('cache-control') === 'no-store';
}

describe('Observation TV guard — loopback is never gated', () => {
  it('case 1: loopback GET /api/settings with no token reaches the handler', async () => {
    const res = await fetch(url('/api/settings'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ stub: true });
    // Not stamped by the guard: loopback short-circuits before the pass path.
    expect(res.headers.get('cache-control')).toBeNull();
  });

  it('case 2: loopback POST /api/admin/restart still behaves as today (requireLocalhost governs)', async () => {
    // The guard must not touch this: it is a POST, and a POST from a remote
    // client is 403 (case 12). From loopback it reaches requireLocalhost and
    // the admin handler exactly as before the guard existed.
    const res = await fetch(url('/api/admin/restart'), { method: 'POST' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'restarting' });
    expect(res.headers.get('cache-control')).toBeNull();
  });

  it('loopback is unchanged when no guard is mounted at all', async () => {
    const res = await fetch(`http://127.0.0.1:${unguardedPort}/api/settings`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBeNull();
  });
});

describe('Observation TV guard — remote allow paths', () => {
  it('case 3: remote GET /tv with the correct ?token= is allowed', async () => {
    const res = await fetch(url(`/tv?token=${encodeURIComponent(TOKEN)}`), { headers: REMOTE });
    expect(res.status).toBe(200);
    expect(allowed(res)).toBe(true);
  });

  it('case 4: remote GET /tv with a correct Authorization: Bearer is allowed', async () => {
    const res = await fetch(url('/tv'), {
      headers: { ...REMOTE, authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    expect(allowed(res)).toBe(true);
  });

  it('case 5: remote GET /tv with a correct X-Api-Key is allowed', async () => {
    const res = await fetch(url('/tv'), { headers: { ...REMOTE, 'x-api-key': TOKEN } });
    expect(res.status).toBe(200);
    expect(allowed(res)).toBe(true);
  });

  it('case 8: remote GET /stream with the correct token is allowed', async () => {
    const res = await fetch(url(`/stream?token=${encodeURIComponent(TOKEN)}`), { headers: REMOTE });
    expect(res.status).toBe(200);
    expect(allowed(res)).toBe(true);
  });

  it('case 9: remote GET /api/observations with the correct token is allowed', async () => {
    const res = await fetch(url(`/api/observations?token=${encodeURIComponent(TOKEN)}`), { headers: REMOTE });
    expect(res.status).toBe(200);
    expect(allowed(res)).toBe(true);
  });

  it('remote GET /tv.html with the correct token is allowed', async () => {
    const res = await fetch(url(`/tv.html?token=${encodeURIComponent(TOKEN)}`), { headers: REMOTE });
    // Both halves matter: the guard stamps `no-store` BEFORE calling next(), so
    // the header alone would still be there if the downstream stack blew up.
    expect(res.status).toBe(200);
    expect(allowed(res)).toBe(true);
  });

  // Token extraction trims deliberately (parseBearerToken trims, x-api-key is
  // .trim()ed, readQueryToken trims), so surrounding whitespace is accepted.
  it('a token with surrounding whitespace is accepted — extraction trims before the compare', async () => {
    const res = await fetch(url(`/tv?token=${encodeURIComponent(` ${TOKEN} `)}`), { headers: REMOTE });
    expect(res.status).toBe(200);
    expect(allowed(res)).toBe(true);

    const viaHeader = await fetch(url('/tv'), { headers: { ...REMOTE, 'x-api-key': ` ${TOKEN} ` } });
    expect(viaHeader.status).toBe(200);
    expect(allowed(viaHeader)).toBe(true);
  });

  // Regression: createCorsMiddleware used to answer a foreign Origin with
  // next(new Error('CORS not allowed')). The worker never calls
  // finalizeRoutes(), so that reached Express's default error handler and
  // returned a 500 HTML page with a stack trace full of absolute paths — on any
  // allowlisted path, to any token holder who sent an Origin header.
  it('an allowed remote request with a foreign Origin is never a 500 stack page', async () => {
    const res = await fetch(url(`/tv?token=${encodeURIComponent(TOKEN)}`), {
      headers: { ...REMOTE, origin: 'http://evil.example' },
    });
    expect(res.status).not.toBe(500);
    expect(res.status).toBe(403);
    const body = await res.text();
    expect(body).not.toContain('Error:');
    expect(body).not.toContain('    at ');
    expect(body).not.toContain('middleware.ts');
    expect(body).not.toContain('/workspace');
    expect(JSON.parse(body)).toEqual({ error: 'Forbidden', message: 'CORS not allowed' });
  });
});

describe('Observation TV guard — remote token failures are 401', () => {
  it('case 6: remote GET /tv with a wrong token is 401', async () => {
    const res = await fetch(url('/tv?token=wrong'), { headers: REMOTE });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      error: 'Unauthorized',
      message: 'Missing or invalid Observation TV token',
    });
  });

  it('case 7: remote GET /tv with no token at all is 401', async () => {
    const res = await fetch(url('/tv'), { headers: REMOTE });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      error: 'Unauthorized',
      message: 'Missing or invalid Observation TV token',
    });
  });

  it('case 21: a repeated ?token= (array) is 401 and does not crash the worker', async () => {
    const res = await fetch(url(`/tv?token=${encodeURIComponent(TOKEN)}&token=other`), { headers: REMOTE });
    expect(res.status).toBe(401);
    // Still serving afterwards.
    const alive = await fetch(url(`/tv?token=${encodeURIComponent(TOKEN)}`), { headers: REMOTE });
    expect(alive.status).toBe(200);
  });
});

describe('Observation TV guard — everything off the allowlist is 404', () => {
  const cases: Array<[string, string]> = [
    ['case 10 (the headline)', '/api/settings'],
    ['case 11 (exact match, not prefix)', '/api/observations/by-file'],
    ['case 15', '/api/auth/session'],
    ['case 16', '/v1/info'],
    ['case 17a', '/'],
    ['case 17b', '/viewer.html'],
    ['case 18', '/restart'],
    ['case 19', '/api/logs'],
    ['case 20 (pid/platform disclosure)', '/health'],
  ];

  for (const [label, path] of cases) {
    it(`${label}: remote GET ${path} with the CORRECT token is 404`, async () => {
      const res = await fetch(url(`${path}?token=${encodeURIComponent(TOKEN)}`), { headers: REMOTE });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'Not found' });
    });
  }

  it('case 10: the 404 body carries no settings payload', async () => {
    const res = await fetch(url(`/api/settings?token=${encodeURIComponent(TOKEN)}`), { headers: REMOTE });
    const body = await res.text();
    expect(body).toBe(JSON.stringify({ error: 'Not found' }));
    expect(body.toLowerCase()).not.toContain('api_key');
    expect(body).not.toContain('stub');
  });
});

describe('Observation TV guard — every mutation is 403 (method gate fires first)', () => {
  it('case 12: remote POST /api/admin/restart with the correct token is 403', async () => {
    const res = await fetch(url(`/api/admin/restart?token=${encodeURIComponent(TOKEN)}`), {
      method: 'POST',
      headers: REMOTE,
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: 'Forbidden',
      message: 'Observation TV remote access is read-only',
    });
    // The worker is still alive, which proves the restart was refused rather
    // than merely answered after running.
    const alive = await fetch(url(`/tv?token=${encodeURIComponent(TOKEN)}`), { headers: REMOTE });
    expect(alive.status).toBe(200);
  });

  it('case 13: remote POST /api/settings with the correct token is 403', async () => {
    const res = await fetch(url(`/api/settings?token=${encodeURIComponent(TOKEN)}`), {
      method: 'POST',
      headers: REMOTE,
    });
    expect(res.status).toBe(403);
  });

  it('case 14: remote POST /api/observations/batch with the correct token is 403', async () => {
    const res = await fetch(url(`/api/observations/batch?token=${encodeURIComponent(TOKEN)}`), {
      method: 'POST',
      headers: REMOTE,
    });
    expect(res.status).toBe(403);
  });

  it('remote DELETE /api/observation/1 with the correct token is 403', async () => {
    const res = await fetch(url(`/api/observation/1?token=${encodeURIComponent(TOKEN)}`), {
      method: 'DELETE',
      headers: REMOTE,
    });
    expect(res.status).toBe(403);
  });
});

describe('Observation TV guard — fail closed and forwarded-header handling', () => {
  it('case 22: decideRemoteAccess denies everything when the expected token is empty', () => {
    expect(decideRemoteAccess({ method: 'GET', path: '/tv', presentedToken: '', expectedToken: '' }))
      .toEqual({ allow: false, status: 401, reason: 'token' });
    expect(decideRemoteAccess({ method: 'GET', path: '/tv', presentedToken: 'anything', expectedToken: '' }))
      .toEqual({ allow: false, status: 401, reason: 'token' });
    expect(decideRemoteAccess({ method: 'GET', path: '/stream', presentedToken: null, expectedToken: '' }))
      .toEqual({ allow: false, status: 401, reason: 'token' });
    expect(decideRemoteAccess({ method: 'GET', path: '/api/settings', presentedToken: 'x', expectedToken: '' }))
      .toEqual({ allow: false, status: 404, reason: 'path' });
    expect(decideRemoteAccess({ method: 'POST', path: '/tv', presentedToken: 'x', expectedToken: '' }))
      .toEqual({ allow: false, status: 403, reason: 'method' });
  });

  it('case 22 (mounted): a guard with an empty token denies every remote request', async () => {
    const tv = await fetch(`http://127.0.0.1:${emptyTokenPort}/tv?token=${encodeURIComponent(TOKEN)}`, { headers: REMOTE });
    expect(tv.status).toBe(401);
    const settings = await fetch(`http://127.0.0.1:${emptyTokenPort}/api/settings`, { headers: REMOTE });
    expect(settings.status).toBe(404);
    // ...and loopback still works.
    const local = await fetch(`http://127.0.0.1:${emptyTokenPort}/api/settings`);
    expect(local.status).toBe(200);
  });

  it('case 23: a loopback req.ip carrying X-Forwarded-For is treated as remote, not loopback', async () => {
    const spoofed = await fetch(url('/api/settings'), { headers: { 'x-forwarded-for': '1.2.3.4' } });
    expect(spoofed.status).toBe(404);
    expect(await spoofed.json()).toEqual({ error: 'Not found' });

    // The same request without the header is plain loopback and reaches the handler.
    const plain = await fetch(url('/api/settings'));
    expect(plain.status).toBe(200);
    expect(await plain.json()).toEqual({ stub: true });
  });

  it('the other forwarded-client headers are refused too', async () => {
    for (const header of ['forwarded', 'x-forwarded-host', 'x-real-ip']) {
      const res = await fetch(url('/api/settings'), { headers: { [header]: 'proxy.example' } });
      expect(res.status).toBe(404);
    }
  });
});

describe('decideRemoteAccess — the policy as a pure function', () => {
  const expected = TOKEN;

  it('allows only GET/HEAD on the four allowlisted paths with the right token', () => {
    for (const path of ['/tv', '/tv.html', '/stream', '/api/observations']) {
      for (const method of ['GET', 'HEAD']) {
        expect(decideRemoteAccess({ method, path, presentedToken: expected, expectedToken: expected }))
          .toEqual({ allow: true });
      }
    }
  });

  it('gates the method before the path, so a mutation never reveals which paths exist', () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
      expect(decideRemoteAccess({ method, path: '/tv', presentedToken: expected, expectedToken: expected }))
        .toEqual({ allow: false, status: 403, reason: 'method' });
      expect(decideRemoteAccess({ method, path: '/api/settings', presentedToken: expected, expectedToken: expected }))
        .toEqual({ allow: false, status: 403, reason: 'method' });
    }
  });

  it('matches paths exactly — no prefixes, no trailing slash, no case folding', () => {
    for (const path of [
      '/api/observations/by-file',
      '/api/observations/batch',
      '/api/observations/',
      '/tv/',
      '/tvx',
      '/TV',
      '/stream/x',
      '/api/settings',
      '/health',
      '/',
    ]) {
      expect(decideRemoteAccess({ method: 'GET', path, presentedToken: expected, expectedToken: expected }))
        .toEqual({ allow: false, status: 404, reason: 'path' });
    }
  });

  it('rejects a missing, empty or wrong token on an allowlisted path', () => {
    expect(decideRemoteAccess({ method: 'GET', path: '/tv', presentedToken: null, expectedToken: expected }))
      .toEqual({ allow: false, status: 401, reason: 'token' });
    expect(decideRemoteAccess({ method: 'GET', path: '/tv', presentedToken: '', expectedToken: expected }))
      .toEqual({ allow: false, status: 401, reason: 'token' });
    expect(decideRemoteAccess({ method: 'GET', path: '/tv', presentedToken: expected.slice(0, -1), expectedToken: expected }))
      .toEqual({ allow: false, status: 401, reason: 'token' });
  });

  // The pure function compares byte-exactly and does NOT trim — but no caller
  // ever reaches it untrimmed, because every extraction path in the middleware
  // trims first. Over real HTTP a padded token is therefore accepted; see the
  // whitespace case in "remote allow paths".
  it('compares byte-exactly — trimming is the extraction layer\'s job, not this function\'s', () => {
    expect(decideRemoteAccess({ method: 'GET', path: '/tv', presentedToken: `${expected} `, expectedToken: expected }))
      .toEqual({ allow: false, status: 401, reason: 'token' });
  });
});

describe('generateTvToken', () => {
  it('mints a 32-byte base64url secret with no cmem_ prefix', () => {
    const token = generateTvToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(token.startsWith('cmem_')).toBe(false);
    expect(generateTvToken()).not.toBe(token);
  });
});
