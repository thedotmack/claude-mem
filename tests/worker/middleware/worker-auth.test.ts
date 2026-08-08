
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import express from 'express';
import http from 'http';
import {
  createCorsMiddleware,
  parseAllowedOriginsSetting,
} from '../../../src/services/worker/http/middleware.js';
import {
  createWorkerAuthMiddleware,
  isTrustedOriginlessHost,
  parseWorkerAuthMode,
  type WorkerAuthMode,
} from '../../../src/services/worker/http/worker-auth.js';
import { createServerApiKey, revokeServerApiKey } from '../../../src/server/auth/sqlite-api-key-service.js';

const ALLOWED_ORIGIN = 'https://app.example.com';

interface TestResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

// http.request instead of fetch so the Host header can be overridden (the
// DNS-rebinding cases need Host: evil.com while connecting to loopback).
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

describe('worker CORS allowlist + auth', () => {
  let db: Database;
  let server: http.Server;
  let port: number;
  let rawKey: string;
  let keyId: string;

  async function startApp(mode: WorkerAuthMode, allowedOrigins: string[] = [ALLOWED_ORIGIN]): Promise<void> {
    const app = express();
    // Same mount order and paths as Server.ts: CORS first, then auth on
    // /api + /v1 + the root-level /stream SSE route.
    app.use(createCorsMiddleware({ allowedOrigins }));
    app.use(['/api', '/v1', '/stream'], createWorkerAuthMiddleware({
      mode,
      getDatabase: () => db,
      exemptPaths: ['/health'],
    }));
    app.all('/api/echo', (_req, res) => { res.json({ ok: true }); });
    app.get('/api/health', (_req, res) => { res.json({ status: 'ok' }); });
    app.get('/stream', (_req, res) => { res.json({ sse: true }); });
    await new Promise<void>(resolve => {
      server = app.listen(0, '127.0.0.1', resolve);
    });
    port = (server.address() as { port: number }).port;
  }

  beforeEach(() => {
    db = new Database(':memory:');
    db.run('PRAGMA foreign_keys = ON');
    const created = createServerApiKey(db, { name: 'external-client' });
    rawKey = created.rawKey;
    keyId = created.record.id;
  });

  afterEach(async () => {
    db.close();
    if (server?.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close(err => err ? reject(err) : resolve());
      });
    }
  });

  describe('CORS allowlist', () => {
    it('echoes an allowlisted https origin with Vary: Origin', async () => {
      await startApp('off');
      const res = await request(port, { headers: { Origin: ALLOWED_ORIGIN } });
      expect(res.status).toBe(200);
      expect(res.headers['access-control-allow-origin']).toBe(ALLOWED_ORIGIN);
      expect(res.headers['vary']).toBe('Origin');
    });

    it('rejects an unlisted origin with clean 403 JSON (not an HTML 500)', async () => {
      await startApp('off');
      const res = await request(port, { headers: { Origin: 'https://evil.com' } });
      expect(res.status).toBe(403);
      expect(res.headers['content-type']).toContain('application/json');
      expect(JSON.parse(res.body).error).toBe('origin_not_allowed');
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('still allows the localhost origin family with no allowlist configured', async () => {
      await startApp('off', []);
      const res = await request(port, { headers: { Origin: 'http://localhost:37777' } });
      expect(res.status).toBe(200);
      expect(res.headers['access-control-allow-origin']).toBe('http://localhost:37777');
    });

    it('normalizes allowlist entries (case, trailing slash, whitespace)', async () => {
      expect(parseAllowedOriginsSetting(' https://App.Example.com/ , https://b.dev')).toEqual([
        'https://app.example.com',
        'https://b.dev',
      ]);
      await startApp('off', parseAllowedOriginsSetting('https://App.Example.com/'));
      const res = await request(port, { headers: { Origin: ALLOWED_ORIGIN } });
      expect(res.status).toBe(200);
    });

    it('answers preflight with Access-Control-Allow-Private-Network when requested', async () => {
      await startApp('origin');
      const res = await request(port, {
        method: 'OPTIONS',
        headers: {
          Origin: ALLOWED_ORIGIN,
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Private-Network': 'true',
        },
      });
      expect(res.status).toBe(204);
      expect(res.headers['access-control-allow-private-network']).toBe('true');
      expect(res.headers['access-control-allow-origin']).toBe(ALLOWED_ORIGIN);
      expect(res.headers['access-control-allow-headers']).toContain('X-Api-Key');
    });

    it('omits the private-network header when the preflight does not request it', async () => {
      await startApp('origin');
      const res = await request(port, {
        method: 'OPTIONS',
        headers: { Origin: ALLOWED_ORIGIN, 'Access-Control-Request-Method': 'POST' },
      });
      expect(res.status).toBe(204);
      expect(res.headers['access-control-allow-private-network']).toBeUndefined();
    });

    it('rejects preflight from an unlisted origin before emitting CORS headers', async () => {
      await startApp('origin');
      const res = await request(port, {
        method: 'OPTIONS',
        headers: {
          Origin: 'https://evil.com',
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Private-Network': 'true',
        },
      });
      expect(res.status).toBe(403);
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
      expect(res.headers['access-control-allow-private-network']).toBeUndefined();
    });
  });

  describe("mode 'origin' (default)", () => {
    beforeEach(() => startApp('origin'));

    it('originless loopback request needs no token (hooks/curl invariant)', async () => {
      const res = await request(port, { method: 'POST' });
      expect(res.status).toBe(200);
    });

    it('originless request with a localhost Host header needs no token (bundled viewer)', async () => {
      const res = await request(port, { headers: { Host: `localhost:${1}` } });
      expect(res.status).toBe(200);
    });

    it('originless request with a foreign DNS-name Host is rejected (DNS rebinding)', async () => {
      const res = await request(port, { method: 'POST', headers: { Host: 'evil.example.net:37777' } });
      expect(res.status).toBe(401);
    });

    it('originless request with a foreign Host passes with a valid key', async () => {
      const res = await request(port, {
        headers: { Host: 'memory.internal.lan:37777', Authorization: `Bearer ${rawKey}` },
      });
      expect(res.status).toBe(200);
    });

    it('allowlisted origin without a token is 401', async () => {
      const res = await request(port, { headers: { Origin: ALLOWED_ORIGIN } });
      expect(res.status).toBe(401);
      expect(JSON.parse(res.body).error).toBe('Unauthorized');
    });

    it('allowlisted origin with a valid Bearer token is 200', async () => {
      const res = await request(port, {
        headers: { Origin: ALLOWED_ORIGIN, Authorization: `Bearer ${rawKey}` },
      });
      expect(res.status).toBe(200);
    });

    it('allowlisted origin with a valid X-Api-Key is 200', async () => {
      const res = await request(port, {
        headers: { Origin: ALLOWED_ORIGIN, 'X-Api-Key': rawKey },
      });
      expect(res.status).toBe(200);
    });

    it('an invalid key is 403', async () => {
      const res = await request(port, {
        headers: { Origin: ALLOWED_ORIGIN, Authorization: 'Bearer cmem_not-a-real-key' },
      });
      expect(res.status).toBe(403);
    });

    it('a revoked key is 403', async () => {
      revokeServerApiKey(db, keyId);
      const res = await request(port, {
        headers: { Origin: ALLOWED_ORIGIN, Authorization: `Bearer ${rawKey}` },
      });
      expect(res.status).toBe(403);
    });

    it('localhost origins stay tokenless (same-origin viewer requests)', async () => {
      const res = await request(port, { headers: { Origin: 'http://localhost:3000' } });
      expect(res.status).toBe(200);
    });

    it('preflight needs no token (browsers never attach credentials to preflight)', async () => {
      const res = await request(port, {
        method: 'OPTIONS',
        headers: { Origin: ALLOWED_ORIGIN, 'Access-Control-Request-Method': 'POST' },
      });
      expect(res.status).toBe(204);
    });

    it('exempt paths stay tokenless even with a foreign Host', async () => {
      const res = await request(port, { path: '/api/health', headers: { Host: 'evil.example.net:1' } });
      expect(res.status).toBe(200);
    });

    it('the root /stream SSE route is covered: allowlisted origin without a key is 401', async () => {
      const res = await request(port, { path: '/stream', headers: { Origin: ALLOWED_ORIGIN } });
      expect(res.status).toBe(401);
    });

    it('/stream works for an allowlisted origin with a valid key', async () => {
      const res = await request(port, {
        path: '/stream',
        headers: { Origin: ALLOWED_ORIGIN, Authorization: `Bearer ${rawKey}` },
      });
      expect(res.status).toBe(200);
    });

    it('/stream stays tokenless for the originless loopback viewer', async () => {
      const res = await request(port, { path: '/stream' });
      expect(res.status).toBe(200);
    });
  });

  describe("mode 'all'", () => {
    beforeEach(() => startApp('all'));

    it('originless loopback request without a token is 401', async () => {
      const res = await request(port, {});
      expect(res.status).toBe(401);
    });

    it('originless loopback request with a token is 200', async () => {
      const res = await request(port, { headers: { Authorization: `Bearer ${rawKey}` } });
      expect(res.status).toBe(200);
    });

    it('exempt paths stay open', async () => {
      const res = await request(port, { path: '/api/health' });
      expect(res.status).toBe(200);
    });
  });

  describe("mode 'off'", () => {
    it('no token checks at all', async () => {
      await startApp('off');
      const res = await request(port, { method: 'POST', headers: { Host: 'evil.example.net:1' } });
      expect(res.status).toBe(200);
    });
  });

  describe('non-loopback socket peer (0.0.0.0 bind reached from the LAN)', () => {
    // A LAN client controls its Host header entirely, so an IP-literal Host
    // must NOT count as proof of locality — only the socket peer address can.
    // Test sockets always connect via loopback, so drive the middleware with
    // a synthetic request carrying a LAN peer address.
    function invoke(mode: WorkerAuthMode, overrides: {
      ip: string;
      headers?: Record<string, string | undefined>;
    }): Promise<number | 'next'> {
      const middleware = createWorkerAuthMiddleware({ mode, getDatabase: () => db });
      const headers: Record<string, string | undefined> = {
        host: '192.168.1.10:37777',
        ...overrides.headers,
      };
      const req = {
        method: 'POST',
        path: '/write',
        ip: overrides.ip,
        socket: { remoteAddress: overrides.ip },
        headers,
        header(name: string) { return headers[name.toLowerCase()]; },
      };
      return new Promise(resolve => {
        const res = {
          status(code: number) { resolve(code); return this; },
          json() { return this; },
        };
        middleware(req as never, res as never, () => resolve('next'));
      });
    }

    it('originless keyless request from a LAN peer with an IPv4-literal Host is 401', async () => {
      expect(await invoke('origin', { ip: '169.254.0.21' })).toBe(401);
    });

    it('originless keyless request from a LAN peer with a localhost Host is still 401', async () => {
      expect(await invoke('origin', { ip: '169.254.0.21', headers: { host: 'localhost:37777' } })).toBe(401);
    });

    it('a LAN peer with a valid key passes', async () => {
      expect(await invoke('origin', { ip: '169.254.0.21', headers: { authorization: `Bearer ${rawKey}` } })).toBe('next');
    });

    it('a loopback peer with an IP-literal Host still needs no token (hooks invariant)', async () => {
      expect(await invoke('origin', { ip: '127.0.0.1', headers: { host: '127.0.0.1:37777' } })).toBe('next');
    });

    it("mode 'off' skips the peer check", async () => {
      expect(await invoke('off', { ip: '169.254.0.21' })).toBe('next');
    });
  });

  describe('helpers', () => {
    it('parseWorkerAuthMode normalizes and defaults to origin', () => {
      expect(parseWorkerAuthMode('origin')).toBe('origin');
      expect(parseWorkerAuthMode(' ALL ')).toBe('all');
      expect(parseWorkerAuthMode('Off')).toBe('off');
      expect(parseWorkerAuthMode('')).toBe('origin');
      expect(parseWorkerAuthMode('banana')).toBe('origin');
    });

    it('isTrustedOriginlessHost trusts localhost and IP literals only', () => {
      expect(isTrustedOriginlessHost('127.0.0.1:37777')).toBe(true);
      expect(isTrustedOriginlessHost('localhost:37777')).toBe(true);
      expect(isTrustedOriginlessHost('0.0.0.0:37777')).toBe(true);
      expect(isTrustedOriginlessHost('192.168.1.5:37777')).toBe(true);
      expect(isTrustedOriginlessHost('[::1]:37777')).toBe(true);
      expect(isTrustedOriginlessHost('evil.com:37777')).toBe(false);
      expect(isTrustedOriginlessHost('localhost.evil.com:37777')).toBe(false);
      expect(isTrustedOriginlessHost('')).toBe(false);
    });
  });
});
