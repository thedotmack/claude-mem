import { afterEach, describe, expect, it, mock } from 'bun:test';
import express from 'express';
import http from 'http';
import {
  buildWorkerOriginPolicy,
  createCorsMiddleware,
  createForeignPageDeleteGuard,
  createWorkerHostGuard,
  isOwnPageOrigin,
  parseAllowedOriginsSetting,
  type WorkerOriginPolicy,
} from '../../../src/services/worker/http/middleware.js';
import { Server } from '../../../src/services/server/Server.js';

// plan-23 step 4: same-host origins and an explicit allowlist for CORS, plus a
// Host check against DNS rebinding. The request helper is from #3514: it uses
// http.request so the Host header can be set to a name while still connecting
// to loopback, which is exactly what a rebound browser request looks like.

interface TestResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function request(port: number, options: {
  path?: string;
  method?: string;
  headers?: Record<string, string>;
}): Promise<TestResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: options.path ?? '/api/echo',
      method: options.method ?? 'GET',
      headers: options.headers ?? {},
    }, res => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
});

async function listen(app: express.Application): Promise<number> {
  const server = await new Promise<http.Server>((resolve) => {
    const started = app.listen(0, '127.0.0.1', () => resolve(started));
  });
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  return address.port;
}

async function workerApp(policy: WorkerOriginPolicy): Promise<number> {
  const app = express();
  app.use(createWorkerHostGuard(policy));
  app.use(createCorsMiddleware(policy));
  app.all('/api/echo', (_req, res) => { res.json({ ok: true }); });
  return listen(app);
}

const defaultPolicy: WorkerOriginPolicy = { allowedOrigins: [], workerHost: '127.0.0.1' };

describe('DNS-rebinding Host check', () => {
  it('lets hooks, curl and the local viewer through (IP and localhost Hosts)', async () => {
    const port = await workerApp(defaultPolicy);
    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`, 'app.localhost:37777']) {
      expect((await request(port, { headers: { Host: host } })).status).toBe(200);
    }
  });

  it('lets LAN access by IP address through without checking the socket peer', async () => {
    const port = await workerApp(defaultPolicy);
    expect((await request(port, { headers: { Host: '192.168.1.20:37777' } })).status).toBe(200);
  });

  it('lets containers reach the host worker as host.docker.internal', async () => {
    const port = await workerApp(defaultPolicy);
    expect((await request(port, { headers: { Host: 'host.docker.internal:37777' } })).status).toBe(200);
  });

  it('refuses a rebound request that carries an untrusted DNS name, with a JSON 403 that says how to allow it', async () => {
    const port = await workerApp(defaultPolicy);
    const response = await request(port, { headers: { Host: 'evil.example:37777' } });
    expect(response.status).toBe(403);
    const body = JSON.parse(response.body);
    expect(body.error).toBe('Forbidden');
    expect(body.message).toContain('evil.example');
    expect(body.message).toContain('CLAUDE_MEM_ALLOWED_ORIGINS');
  });

  it('refuses a rebound same-origin POST even though its Origin matches its Host', async () => {
    const port = await workerApp(defaultPolicy);
    const response = await request(port, {
      method: 'POST',
      headers: { Host: 'evil.example:37777', Origin: 'http://evil.example:37777' },
    });
    expect(response.status).toBe(403);
  });

  it('trusts CLAUDE_MEM_WORKER_HOST and the hosts of allowlisted origins', async () => {
    const port = await workerApp({
      allowedOrigins: ['http://mybox.local:37777'],
      workerHost: 'worker.lan',
    });
    expect((await request(port, { headers: { Host: 'worker.lan:37777' } })).status).toBe(200);
    expect((await request(port, { headers: { Host: 'mybox.local:37777' } })).status).toBe(200);
    expect((await request(port, { headers: { Host: 'other.lan:37777' } })).status).toBe(403);
  });
});

describe('worker CORS', () => {
  it('allows the viewer to call its own API from a LAN address (same host)', async () => {
    const port = await workerApp(defaultPolicy);
    const response = await request(port, {
      method: 'POST',
      headers: { Host: '192.168.1.20:37777', Origin: 'http://192.168.1.20:37777' },
    });
    expect(response.status).toBe(200);
    expect(response.headers['access-control-allow-origin']).toBe('http://192.168.1.20:37777');
  });

  it('refuses a different origin with a JSON 403', async () => {
    const port = await workerApp(defaultPolicy);
    const response = await request(port, {
      method: 'POST',
      headers: { Host: '192.168.1.20:37777', Origin: 'http://192.168.1.99:37777' },
    });
    expect(response.status).toBe(403);
    expect(JSON.parse(response.body)).toEqual({ error: 'Forbidden', message: 'CORS not allowed' });
  });

  it('allows an origin listed in CLAUDE_MEM_ALLOWED_ORIGINS', async () => {
    const port = await workerApp({ allowedOrigins: ['https://app.example.com'], workerHost: '127.0.0.1' });
    const response = await request(port, {
      method: 'OPTIONS',
      headers: {
        Host: `127.0.0.1:${port}`,
        Origin: 'https://app.example.com',
        'Access-Control-Request-Method': 'POST',
      },
    });
    expect(response.status).toBe(204);
    expect(response.headers['access-control-allow-origin']).toBe('https://app.example.com');
  });

  it('still allows the localhost origins without any configuration', async () => {
    const port = await workerApp(defaultPolicy);
    const response = await request(port, {
      headers: { Host: `127.0.0.1:${port}`, Origin: 'http://localhost:5173' },
    });
    expect(response.status).toBe(200);
  });
});

// A delete is tombstoned for cloud sync, so a stray DELETE from any page CORS
// lets read (every http://localhost:* page) would remove memories on every
// device. Deletes are accepted only from the worker's own page, an allowlisted
// origin, or a client that sends no Origin (hooks, the CLI, curl).
describe('browser deletes', () => {
  async function workerAppWithDelete(policy: WorkerOriginPolicy, deleted: string[]): Promise<number> {
    const app = express();
    app.use(createWorkerHostGuard(policy));
    app.use(createForeignPageDeleteGuard(policy));
    app.use(createCorsMiddleware(policy));
    app.delete('/api/observation/:id', (req, res) => { deleted.push(req.params.id); res.json({ success: true }); });
    app.get('/api/observation/:id', (_req, res) => { res.json({ ok: true }); });
    return listen(app);
  }

  it('refuses a DELETE from another localhost page, which may still read', async () => {
    const deleted: string[] = [];
    const port = await workerAppWithDelete(defaultPolicy, deleted);
    const headers = { Host: `localhost:${port}`, Origin: 'http://localhost:5173' };

    const refused = await request(port, { method: 'DELETE', path: '/api/observation/7', headers });
    expect(refused.status).toBe(403);
    expect(JSON.parse(refused.body).error).toBe('Forbidden');
    expect(deleted).toEqual([]);

    expect((await request(port, { method: 'GET', path: '/api/observation/7', headers })).status).toBe(200);
  });

  it('refuses a DELETE from a page on another loopback port or with an opaque origin', async () => {
    const deleted: string[] = [];
    const port = await workerAppWithDelete(defaultPolicy, deleted);
    for (const origin of ['http://127.0.0.1:3000', 'null', 'chrome-extension://abcdef']) {
      const response = await request(port, {
        method: 'DELETE',
        path: '/api/observation/1',
        headers: { Host: `127.0.0.1:${port}`, Origin: origin },
      });
      expect(response.status).toBe(403);
    }
    expect(deleted).toEqual([]);
  });

  it('lets the viewer delete from its own page, on loopback or a LAN address', async () => {
    const deleted: string[] = [];
    const port = await workerAppWithDelete(defaultPolicy, deleted);
    for (const [host, origin] of [
      [`localhost:${port}`, `http://localhost:${port}`],
      [`127.0.0.1:${port}`, `http://127.0.0.1:${port}`],
      ['192.168.1.20:37777', 'http://192.168.1.20:37777'],
    ]) {
      const response = await request(port, { method: 'DELETE', path: '/api/observation/2', headers: { Host: host, Origin: origin } });
      expect(response.status).toBe(200);
    }
    expect(deleted).toEqual(['2', '2', '2']);
  });

  it('lets hooks, the CLI and curl delete (no Origin header)', async () => {
    const deleted: string[] = [];
    const port = await workerAppWithDelete(defaultPolicy, deleted);
    const response = await request(port, { method: 'DELETE', path: '/api/observation/3', headers: { Host: `127.0.0.1:${port}` } });
    expect(response.status).toBe(200);
    expect(deleted).toEqual(['3']);
  });

  it('lets an allowlisted origin delete, such as the CLAUDE_MEM_PUBLIC_URL viewer behind a port-forward', async () => {
    const deleted: string[] = [];
    const policy = buildWorkerOriginPolicy({ CLAUDE_MEM_PUBLIC_URL: 'https://37700.host.example' });
    const port = await workerAppWithDelete(policy, deleted);
    const response = await request(port, {
      method: 'DELETE',
      path: '/api/observation/4',
      headers: { Host: `127.0.0.1:${port}`, Origin: 'https://37700.host.example' },
    });
    expect(response.status).toBe(200);
    expect(deleted).toEqual(['4']);
  });

  it('decides "own page" from the Origin and Host alone', () => {
    expect(isOwnPageOrigin('http://localhost:37777', 'localhost:37777', defaultPolicy)).toBe(true);
    expect(isOwnPageOrigin('http://localhost:37777', '127.0.0.1:37777', defaultPolicy)).toBe(true);
    expect(isOwnPageOrigin('http://[::1]:37777', '[::1]:37777', defaultPolicy)).toBe(true);
    expect(isOwnPageOrigin('http://localhost:3000', 'localhost:37777', defaultPolicy)).toBe(false);
    expect(isOwnPageOrigin('http://localhost:37777', undefined, defaultPolicy)).toBe(false);
    expect(isOwnPageOrigin('not a url', 'localhost:37777', defaultPolicy)).toBe(false);
  });
});

describe('settings', () => {
  it('parses CLAUDE_MEM_ALLOWED_ORIGINS into exact, lowercased origins', () => {
    expect(parseAllowedOriginsSetting(' https://App.Example.com/, http://mybox.local:37777 ,, ')).toEqual([
      'https://app.example.com',
      'http://mybox.local:37777',
    ]);
  });

  it('trusts the origin of CLAUDE_MEM_PUBLIC_URL, where a remote viewer is loaded from', () => {
    const policy = buildWorkerOriginPolicy({
      CLAUDE_MEM_ALLOWED_ORIGINS: '',
      CLAUDE_MEM_WORKER_HOST: '127.0.0.1',
      CLAUDE_MEM_PUBLIC_URL: 'https://37700.host.example/',
    });
    expect(policy.allowedOrigins).toEqual(['https://37700.host.example']);
  });
});

describe('Server wiring', () => {
  function server(originPolicy?: WorkerOriginPolicy, routes?: (app: express.Application) => void): Server {
    const instance = new Server({
      getInitializationComplete: () => true,
      getMcpReady: () => true,
      onShutdown: mock(() => Promise.resolve()),
      onRestart: mock(() => Promise.resolve()),
      workerPath: '/test/worker.cjs',
      getAiStatus: () => ({ provider: 'disabled', authMethod: 'none', lastInteraction: null }),
      ...(originPolicy ? { originPolicy } : {}),
    });
    if (routes) instance.registerRoutes({ setupRoutes: routes });
    instance.finalizeRoutes();
    return instance;
  }

  async function start(instance: Server): Promise<number> {
    await instance.listen(0, '127.0.0.1');
    const address = instance.getHttpServer()?.address();
    if (!address || typeof address === 'string') throw new Error('no port');
    return address.port;
  }

  // Same shutdown tolerance as the other Server tests: under bun, close() after
  // closeAllConnections() can report the server as already stopped.
  async function stop(instance: Server): Promise<void> {
    try {
      await instance.close();
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ERR_SERVER_NOT_RUNNING') throw error;
    }
  }

  it('mounts the Host check when the worker passes a policy', async () => {
    const instance = server(defaultPolicy);
    const port = await start(instance);
    try {
      expect((await request(port, { path: '/api/health', headers: { Host: 'evil.example' } })).status).toBe(403);
      expect((await request(port, { path: '/api/health', headers: { Host: `127.0.0.1:${port}` } })).status).toBe(200);
    } finally {
      await stop(instance);
    }
  });

  it('refuses a DELETE from another localhost page when the worker passes a policy', async () => {
    const deleted: string[] = [];
    const instance = server(defaultPolicy, app => {
      app.delete('/api/observation/:id', (req, res) => { deleted.push(req.params.id); res.json({ success: true }); });
    });
    const port = await start(instance);
    try {
      const foreign = await request(port, {
        method: 'DELETE',
        path: '/api/observation/9',
        headers: { Host: `localhost:${port}`, Origin: 'http://localhost:5173' },
      });
      expect(foreign.status).toBe(403);
      const ownPage = await request(port, {
        method: 'DELETE',
        path: '/api/observation/9',
        headers: { Host: `localhost:${port}`, Origin: `http://localhost:${port}` },
      });
      expect(ownPage.status).toBe(200);
      expect(deleted).toEqual(['9']);
    } finally {
      await stop(instance);
    }
  });

  it('leaves the server runtime (no policy) reachable by its public DNS name', async () => {
    const instance = server();
    const port = await start(instance);
    try {
      expect((await request(port, { path: '/api/health', headers: { Host: 'memory.example.com' } })).status).toBe(200);
    } finally {
      await stop(instance);
    }
  });
});
