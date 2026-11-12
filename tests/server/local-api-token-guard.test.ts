// Local API token mode (#5141) on the worker API.
//
// With a token set, `createLocalApiTokenGuard` refuses every request that does not
// carry it, loopback included, except the exact routes in shared/local-api-token.ts.
// With no token nothing is mounted and the worker behaves as before. The policy
// itself is covered in tests/shared/local-api-token.test.ts; these tests prove it is
// mounted ahead of every route and reads the real request.

import { afterAll, beforeAll, describe, expect, it, spyOn } from 'bun:test';
import type { Application, Request, Response } from 'express';
import { logger } from '../../src/utils/logger.js';
import { Server, type ServerOptions } from '../../src/services/server/Server.js';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LOCAL_API_TOKEN_HEADER } from '../../src/shared/local-api-token.js';
import { uiStaticPaths } from '../../src/services/worker/http/middleware.js';
import { listenOnEphemeralPort } from '../helpers/ephemeral-port.js';

const TOKEN = 'local-api-guard-test-secret';
const WRONG = 'local-api-guard-wrong-secret';

let shutdownCalls = 0;

function baseOptions(overrides: Partial<ServerOptions> = {}): ServerOptions {
  return {
    getInitializationComplete: () => true,
    getMcpReady: () => true,
    onShutdown: () => { shutdownCalls += 1; return Promise.resolve(); },
    onRestart: () => Promise.resolve(),
    workerPath: '/test/worker-service.cjs',
    getAiStatus: () => ({ provider: 'disabled', authMethod: 'api-key', lastInteraction: null }),
    ...overrides,
  };
}

// The data-free UI files the guard serves without a token; production lists them with uiStaticPaths.
const STATIC_PATHS = new Set(['/', '/viewer', '/viewer-bundle.js']);

// Stubs for routes the real worker mounts after construction, so a request that
// passes the guard lands on a handler instead of Express's default 404.
const stubRoutes = {
  setupRoutes(app: Application): void {
    const ok = (_req: Request, res: Response) => { res.json({ stub: true }); };
    app.get('/api/settings', ok);
    app.post('/api/settings', ok);
    app.get('/api/observations', ok);
    app.delete('/api/observation/:id', ok);
    app.post('/api/spool/ingest', ok);
    app.get('/', ok);
    app.get('/viewer', ok);
    app.get('/viewer-bundle.js', ok);
    app.get('/stream', ok);
  },
};

let guarded: Server;
let guardedPort = 0;
let unguarded: Server;
let unguardedPort = 0;
let emptyToken: Server;
let emptyTokenPort = 0;
let withTv: Server;
let withTvPort = 0;
let spies: ReturnType<typeof spyOn>[] = [];
let warnings: string[] = [];

async function start(options: ServerOptions): Promise<{ server: Server; port: number }> {
  const server = new Server(options);
  const port = await listenOnEphemeralPort(server);
  server.registerRoutes(stubRoutes);
  return { server, port };
}

beforeAll(async () => {
  spies = [
    spyOn(logger, 'info').mockImplementation(() => {}),
    spyOn(logger, 'debug').mockImplementation(() => {}),
    spyOn(logger, 'warn').mockImplementation((...args: unknown[]) => { warnings.push(JSON.stringify(args)); }),
    spyOn(process, 'exit').mockImplementation(() => undefined as never),
  ];

  ({ server: guarded, port: guardedPort } = await start(baseOptions({ localApiToken: { getToken: () => TOKEN, openStaticPaths: STATIC_PATHS } })));
  ({ server: unguarded, port: unguardedPort } = await start(baseOptions()));
  ({ server: emptyToken, port: emptyTokenPort } = await start(baseOptions({ localApiToken: { getToken: () => '', openStaticPaths: STATIC_PATHS } })));
  ({ server: withTv, port: withTvPort } = await start(baseOptions({
    localApiToken: { getToken: () => TOKEN },
    remoteReadOnly: { getToken: () => 'tv-secret' },
  })));
});

afterAll(async () => {
  for (const server of [guarded, unguarded, emptyToken, withTv]) {
    if (server?.getHttpServer()) {
      try { await server.close(); } catch { /* ignore */ }
    }
  }
  spies.forEach(s => s.mockRestore());
  spies = [];
});

const at = (port: number, path: string) => `http://127.0.0.1:${port}${path}`;

describe('local-api-token guard: no token set', () => {
  it('changes nothing: loopback with no token reaches the handler', async () => {
    const res = await fetch(at(unguardedPort, '/api/settings'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ stub: true });
  });
});

describe('local-api-token guard: token set', () => {
  it('refuses a loopback request with no token, with 401 and a JSON body', async () => {
    const res = await fetch(at(guardedPort, '/api/settings'));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized', message: 'Missing or invalid local API token' });
  });

  it('refuses a wrong token', async () => {
    const res = await fetch(at(guardedPort, '/api/settings'), { headers: { [LOCAL_API_TOKEN_HEADER]: WRONG } });
    expect(res.status).toBe(401);
  });

  it('refuses writes and deletes with no token, before the handler runs', async () => {
    const write = await fetch(at(guardedPort, '/api/settings'), { method: 'POST' });
    expect(write.status).toBe(401);
    const del = await fetch(at(guardedPort, '/api/observation/1'), { method: 'DELETE' });
    expect(del.status).toBe(401);
  });

  it('refuses an admin route with no token and never calls the handler', async () => {
    const before = shutdownCalls;
    const res = await fetch(at(guardedPort, '/api/admin/shutdown'), { method: 'POST' });
    expect(res.status).toBe(401);
    expect(shutdownCalls).toBe(before);
  });

  it('refuses a route nothing handles, so an unknown path is not probed for free', async () => {
    const res = await fetch(at(guardedPort, '/api/does-not-exist'));
    expect(res.status).toBe(401);
  });

  it('admits X-Claude-Mem-Token', async () => {
    const res = await fetch(at(guardedPort, '/api/settings'), { headers: { [LOCAL_API_TOKEN_HEADER]: TOKEN } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ stub: true });
  });

  it('admits Authorization: Bearer', async () => {
    const res = await fetch(at(guardedPort, '/api/settings'), { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(res.status).toBe(200);
  });

  it('admits a write and a delete that carry the token', async () => {
    const write = await fetch(at(guardedPort, '/api/settings'), { method: 'POST', headers: { [LOCAL_API_TOKEN_HEADER]: TOKEN } });
    expect(write.status).toBe(200);
    const del = await fetch(at(guardedPort, '/api/observation/1'), { method: 'DELETE', headers: { [LOCAL_API_TOKEN_HEADER]: TOKEN } });
    expect(del.status).toBe(200);
  });

  it('leaves only the health probe open', async () => {
    expect((await fetch(at(guardedPort, '/api/health'))).status).toBe(200);
    expect((await fetch(at(guardedPort, '/api/readiness'))).status).toBe(401);
    expect((await fetch(at(guardedPort, '/api/ready'))).status).toBe(401);
    expect((await fetch(at(guardedPort, '/api/spool/ingest'), { method: 'POST' })).status).toBe(401);
    expect((await fetch(at(guardedPort, '/api/readiness'), { headers: { [LOCAL_API_TOKEN_HEADER]: TOKEN } })).status).toBe(200);
  });

  it('does not open the other methods or path variants of an open route', async () => {
    expect((await fetch(at(guardedPort, '/api/health'), { method: 'POST' })).status).toBe(401);
    expect((await fetch(at(guardedPort, '/api/health/'))).status).toBe(401);
    expect((await fetch(at(guardedPort, '/API/health'))).status).toBe(401);
  });

  it('is not fooled by a forwarded-client header, in either direction', async () => {
    const without = await fetch(at(guardedPort, '/api/settings'), { headers: { 'x-forwarded-for': '127.0.0.1' } });
    expect(without.status).toBe(401);
    const withToken = await fetch(at(guardedPort, '/api/settings'), {
      headers: { 'x-forwarded-for': '203.0.113.5', [LOCAL_API_TOKEN_HEADER]: TOKEN },
    });
    expect(withToken.status).toBe(200);
  });

  it('never writes a presented or expected token to the log', async () => {
    warnings = [];
    await fetch(at(guardedPort, '/api/settings'), { headers: { [LOCAL_API_TOKEN_HEADER]: WRONG } });
    expect(warnings.length).toBeGreaterThan(0);
    for (const line of warnings) {
      expect(line).not.toContain(WRONG);
      expect(line).not.toContain(TOKEN);
    }
  });
});

describe('local-api-token guard: a browser page', () => {
  // A cookie is shared by every port on localhost, so one would hand the token to any other
  // local server the browser visits (#6056 review). The guard never sets or reads one.
  it('sets no cookie for a valid ?token= page load', async () => {
    const res = await fetch(at(guardedPort, `/api/settings?token=${TOKEN}`));
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('does not take the token from a cookie', async () => {
    const res = await fetch(at(guardedPort, '/api/observations'), { headers: { cookie: `claude_mem_token=${TOKEN}` } });
    expect(res.status).toBe(401);
  });

  it('serves the data-free UI files without a token, for GET and HEAD only', async () => {
    expect((await fetch(at(guardedPort, '/viewer-bundle.js'))).status).toBe(200);
    expect((await fetch(at(guardedPort, '/viewer'))).status).toBe(200);
    expect((await fetch(at(guardedPort, '/'))).status).toBe(200);
    expect((await fetch(at(guardedPort, '/viewer-bundle.js'), { method: 'HEAD' })).status).toBe(200);
    expect((await fetch(at(guardedPort, '/viewer-bundle.js'), { method: 'POST' })).status).toBe(401);
  });

  it('matches UI files exactly, never by prefix or case', async () => {
    expect((await fetch(at(guardedPort, '/viewer-bundle.js/x'))).status).toBe(401);
    expect((await fetch(at(guardedPort, '/viewer/'))).status).toBe(401);
    expect((await fetch(at(guardedPort, '/VIEWER'))).status).toBe(401);
  });

  it('keeps the event stream and the API behind the token', async () => {
    expect((await fetch(at(guardedPort, '/stream'))).status).toBe(401);
    expect((await fetch(at(guardedPort, `/stream?token=${TOKEN}`))).status).toBe(200);
    expect((await fetch(at(guardedPort, '/api/observations'))).status).toBe(401);
  });

  it('takes ?token= on any read, such as an image or the event stream', async () => {
    expect((await fetch(at(guardedPort, `/api/observations?token=${TOKEN}`))).status).toBe(200);
    expect((await fetch(at(guardedPort, `/api/observations?token=${WRONG}`))).status).toBe(401);
  });

  it('never lets a write ride the query token: a write sends the header', async () => {
    expect((await fetch(at(guardedPort, `/api/settings?token=${TOKEN}`), { method: 'POST' })).status).toBe(401);
    expect((await fetch(at(guardedPort, `/api/observation/1?token=${TOKEN}`), { method: 'DELETE' })).status).toBe(401);
    expect((await fetch(at(guardedPort, '/api/settings'), { method: 'POST', headers: { [LOCAL_API_TOKEN_HEADER]: TOKEN } })).status).toBe(200);
  });

  it('refuses a repeated token, even beside a valid header', async () => {
    expect((await fetch(at(guardedPort, `/api/settings?token=${TOKEN}&token=${TOKEN}`))).status).toBe(401);
    expect((await fetch(at(guardedPort, `/api/settings?token=${TOKEN}&token=${TOKEN}`), { headers: { [LOCAL_API_TOKEN_HEADER]: TOKEN } })).status).toBe(401);
  });

  it('never writes a query-string token to the log', async () => {
    warnings = [];
    await fetch(at(guardedPort, `/api/settings?token=${WRONG}`));
    expect(warnings.length).toBeGreaterThan(0);
    for (const line of warnings) {
      expect(line).not.toContain(WRONG);
      expect(line).not.toContain('token=');
    }
  });
});

describe('uiStaticPaths', () => {
  it('lists every file under both UI layouts as an exact request path, plus the HTML shells', () => {
    const root = mkdtempSync(join(tmpdir(), 'cm-ui-static-'));
    try {
      mkdirSync(join(root, 'ui', 'work-view', 'assets'), { recursive: true });
      writeFileSync(join(root, 'ui', 'viewer-bundle.js'), '');
      writeFileSync(join(root, 'ui', 'work-view', 'assets', 'index-abc.js'), '');
      writeFileSync(join(root, 'ui', 'space name.css'), '');
      mkdirSync(join(root, 'plugin', 'ui'), { recursive: true });
      writeFileSync(join(root, 'plugin', 'ui', 'tv.html'), '');
      expect([...uiStaticPaths(root)].sort()).toEqual([
        '/', '/restart', '/space%20name.css', '/tv', '/tv.html', '/viewer', '/viewer-bundle.js', '/work-view/assets/index-abc.js',
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('is only the shells when no UI directory exists', () => {
    expect([...uiStaticPaths(join(tmpdir(), 'cm-ui-static-missing-dir'))].sort()).toEqual(['/', '/restart', '/tv', '/viewer']);
  });
});

describe('local-api-token guard: fails closed', () => {
  it('refuses everything, health and UI files included, if mounted with an empty token', async () => {
    expect((await fetch(at(emptyTokenPort, '/api/settings'), { headers: { [LOCAL_API_TOKEN_HEADER]: '' } })).status).toBe(401);
    expect((await fetch(at(emptyTokenPort, '/api/health'))).status).toBe(401);
    expect((await fetch(at(emptyTokenPort, '/viewer-bundle.js'))).status).toBe(401);
  });
});

describe('local-api-token guard with Observation TV', () => {
  it('runs first: the TV guard lets loopback through, this one still refuses it', async () => {
    const res = await fetch(at(withTvPort, '/api/observations'));
    expect(res.status).toBe(401);
  });

  it('a request with the local API token passes both', async () => {
    const res = await fetch(at(withTvPort, '/api/observations'), { headers: { [LOCAL_API_TOKEN_HEADER]: TOKEN } });
    expect(res.status).toBe(200);
  });
});
