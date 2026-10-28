// Owner-auth guard (shared/worker-auth.ts + createOwnerAuthGuard).
//
// Loopback TCP origin is not proof of the owning OS user: on a multi-user
// host any local account could previously read every memory and rewrite every
// whitelisted setting through 127.0.0.1:<port>. The guard requires the shared
// secret from <DATA_DIR>/worker-auth-token (mode 0600) on /api/* and /stream.
// Same test harness as tv-remote-guard.test.ts.

import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from 'bun:test';
import { existsSync, readFileSync, statSync } from 'fs';
import type { Application, Request, Response } from 'express';
import { logger } from '../../src/utils/logger.js';
import { Server, type ServerOptions } from '../../src/services/server/Server.js';
import { listenOnEphemeralPort } from '../helpers/ephemeral-port.js';
import {
  loadWorkerAuthToken,
  resetWorkerAuthTokenCache,
  workerAuthTokenPath,
} from '../../src/shared/worker-auth.js';

const OWNER_TOKEN = 'owner-test-secret-token';
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

// Stubs so an allowed request lands on a handler instead of Express's 404.
const stubRoutes = {
  setupRoutes(app: Application): void {
    const ok = (_req: Request, res: Response) => { res.json({ stub: true }); };
    app.get('/api/settings', ok);
    app.post('/api/settings', ok);
    app.get('/api/observations', ok);
    app.post('/api/observations/batch', ok);
    app.get('/api/auth/session', ok);
    app.post('/api/spool/ingest', ok);
    app.get('/stream', ok);
    app.get('/viewer.html', ok);
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
  const server = new Server(options);
  const port = await listenOnEphemeralPort(server);
  server.registerRoutes(stubRoutes);
  return { server, port };
}

beforeAll(async () => {
  spies = [
    spyOn(logger, 'info').mockImplementation(() => {}),
    spyOn(logger, 'warn').mockImplementation(() => {}),
    spyOn(logger, 'debug').mockImplementation(() => {}),
    spyOn(process, 'exit').mockImplementation(() => undefined as never),
  ];

  ({ server: guarded, port: guardedPort } = await start(
    baseOptions({ ownerAuth: { getToken: () => OWNER_TOKEN } }),
  ));
  ({ server: unguarded, port: unguardedPort } = await start(baseOptions()));
  ({ server: emptyToken, port: emptyTokenPort } = await start(
    baseOptions({ ownerAuth: { getToken: () => '' } }),
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

function url(path: string, port = guardedPort): string {
  return `http://127.0.0.1:${port}${path}`;
}

describe('owner-auth guard — loopback /api/* requires the token', () => {
  it('denies a loopback GET without a token', async () => {
    const res = await fetch(url('/api/settings'));
    expect(res.status).toBe(401);
  });

  it('denies a loopback POST without a token', async () => {
    const res = await fetch(url('/api/settings'), { method: 'POST' });
    expect(res.status).toBe(401);
  });

  it('denies a wrong bearer token', async () => {
    const res = await fetch(url('/api/settings'), {
      headers: { Authorization: 'Bearer not-the-token' },
    });
    expect(res.status).toBe(401);
  });

  it('accepts the bearer token', async () => {
    const res = await fetch(url('/api/settings'), {
      headers: { Authorization: `Bearer ${OWNER_TOKEN}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ stub: true });
  });

  it('accepts the token as a query parameter (EventSource cannot set headers)', async () => {
    const res = await fetch(url(`/api/settings?token=${encodeURIComponent(OWNER_TOKEN)}`));
    expect(res.status).toBe(200);
  });

  it('protects /stream too', async () => {
    const denied = await fetch(url('/stream'));
    expect(denied.status).toBe(401);
    const allowed = await fetch(url(`/stream?token=${encodeURIComponent(OWNER_TOKEN)}`));
    expect(allowed.status).toBe(200);
  });

  it('denies /api/observations/batch (route added later is covered)', async () => {
    const res = await fetch(url('/api/observations/batch'), { method: 'POST' });
    expect(res.status).toBe(401);
  });
});

describe('owner-auth guard — exemptions and scope', () => {
  it('leaves /api/health open for probes', async () => {
    const res = await fetch(url('/api/health'));
    expect(res.status).not.toBe(401);
  });

  it('leaves /api/readiness open', async () => {
    const res = await fetch(url('/api/readiness'));
    expect(res.status).not.toBe(401);
  });

  it('leaves /api/spool/ingest to its own ingest bearer', async () => {
    const res = await fetch(url('/api/spool/ingest'), { method: 'POST' });
    expect(res.status).toBe(200);
  });

  it('leaves /api/auth/* to BetterAuth', async () => {
    const res = await fetch(url('/api/auth/session'));
    expect(res.status).toBe(200);
  });

  it('leaves non-/api paths (the SPA, /tv markup) untouched', async () => {
    const res = await fetch(url('/viewer.html'));
    expect(res.status).toBe(200);
  });
});

describe('owner-auth guard — scope of the loopback claim', () => {
  it('does not gate non-/api paths even with no token', async () => {
    const res = await fetch(url('/viewer.html'));
    expect(res.status).toBe(200);
  });

  it('skips forwarded (proxied) callers — the remote guard owns them', async () => {
    // A forwarded-client header means the socket peer is a proxy, so this
    // guard must not decide it: the remote read-only guard already did.
    const res = await fetch(url('/api/settings'), { headers: REMOTE });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ stub: true });
  });

  it('fails closed when the token cannot be resolved', async () => {
    const res = await fetch(url('/api/settings', emptyTokenPort));
    expect(res.status).toBe(401);
  });

  it('is inert when no ownerAuth option is given (server runtime, tests)', async () => {
    const res = await fetch(url('/api/settings', unguardedPort));
    expect(res.status).toBe(200);
  });
});

describe('worker-auth token resolution', () => {
  const ORIGINAL_AUTH = process.env.CLAUDE_MEM_WORKER_AUTH;
  const ORIGINAL_TOKEN = process.env.CLAUDE_MEM_WORKER_AUTH_TOKEN;

  afterEach(() => {
    if (ORIGINAL_AUTH === undefined) delete process.env.CLAUDE_MEM_WORKER_AUTH;
    else process.env.CLAUDE_MEM_WORKER_AUTH = ORIGINAL_AUTH;
    if (ORIGINAL_TOKEN === undefined) delete process.env.CLAUDE_MEM_WORKER_AUTH_TOKEN;
    else process.env.CLAUDE_MEM_WORKER_AUTH_TOKEN = ORIGINAL_TOKEN;
    resetWorkerAuthTokenCache();
  });

  it('returns "" when CLAUDE_MEM_WORKER_AUTH=off (the suite default)', () => {
    process.env.CLAUDE_MEM_WORKER_AUTH = 'off';
    resetWorkerAuthTokenCache();
    expect(loadWorkerAuthToken()).toBe('');
  });

  it('honors the env override before touching the file', () => {
    process.env.CLAUDE_MEM_WORKER_AUTH = 'on';
    process.env.CLAUDE_MEM_WORKER_AUTH_TOKEN = 'env-token-123';
    resetWorkerAuthTokenCache();
    expect(loadWorkerAuthToken()).toBe('env-token-123');
  });

  it('creates the token file with owner-only permissions and reuses it', () => {
    process.env.CLAUDE_MEM_WORKER_AUTH = 'on';
    delete process.env.CLAUDE_MEM_WORKER_AUTH_TOKEN;
    resetWorkerAuthTokenCache();
    const token = loadWorkerAuthToken();
    expect(token.length).toBe(64); // 32 random bytes, hex
    const path = workerAuthTokenPath();
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, 'utf-8').trim()).toBe(token);
    if (process.platform !== 'win32') {
      expect(statSync(path).mode & 0o777).toBe(0o600);
    }
    // Second call reads the same file — one shared secret for all clients.
    resetWorkerAuthTokenCache();
    expect(loadWorkerAuthToken()).toBe(token);
  });

  it('refuses to overwrite a pre-existing token file', () => {
    process.env.CLAUDE_MEM_WORKER_AUTH = 'on';
    delete process.env.CLAUDE_MEM_WORKER_AUTH_TOKEN;
    const path = workerAuthTokenPath();
    // The previous test created it; a planted file would win the same race.
    if (existsSync(path)) {
      const planted = readFileSync(path, 'utf-8').trim();
      resetWorkerAuthTokenCache();
      expect(loadWorkerAuthToken()).toBe(planted);
    }
  });
});
