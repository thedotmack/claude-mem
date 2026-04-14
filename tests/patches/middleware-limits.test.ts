/**
 * Tests for middleware hardening patches.
 */
import { describe, it, expect, afterEach } from 'bun:test';
import express from 'express';
import http from 'http';
import { createMiddleware, rateLimit } from '../../src/services/worker/http/middleware.js';

const openServers = new Set<http.Server>();

async function startServer(app: express.Application): Promise<number> {
  const server = app.listen(0, '127.0.0.1');
  openServers.add(server);
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('unexpected server address');
  return addr.port;
}

afterEach(async () => {
  for (const server of openServers) {
    if (!server.listening) continue;
    await new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
    });
  }
  openServers.clear();
});

function createJsonLimitApp(): express.Application {
  const app = express();
  app.use(createMiddleware(() => ''));
  app.post('/echo', (req, res) => {
    res.json({ ok: true, size: req.body?.data?.length ?? 0 });
  });
  app.use(((error, _req, res, next) => {
    if (error?.status) {
      res.status(error.status).json({ error: error.message });
      return;
    }
    next(error);
  }) as express.ErrorRequestHandler);
  return app;
}

function createRateLimitedApp(maxRequests: number, windowMs: number): express.Application {
  const app = express();
  app.set('trust proxy', true);
  app.get('/api/context/inject', rateLimit(maxRequests, windowMs), (_req, res) => {
    res.json({ ok: true });
  });
  return app;
}

describe('Middleware Limits (P3+P4)', () => {
  describe('JSON body limit (P3)', () => {
    it('middleware source has 5mb limit, not 50mb', async () => {
      const source = await Bun.file('src/services/worker/http/middleware.ts').text();
      expect(source).toContain("limit: '5mb'");
      expect(source).not.toContain("limit: '50mb'");
    });

    it('accepts JSON payloads below 5mb', async () => {
      const port = await startServer(createJsonLimitApp());
      const payload = { data: 'x'.repeat(4 * 1024 * 1024) };

      const res = await fetch(`http://127.0.0.1:${port}/echo`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      expect(res.status).toBe(200);
      const body = await res.json() as { ok: boolean; size: number };
      expect(body.ok).toBe(true);
      expect(body.size).toBe(payload.data.length);
    });

    it('rejects JSON payloads above 5mb', async () => {
      const port = await startServer(createJsonLimitApp());
      const payload = { data: 'x'.repeat(6 * 1024 * 1024) };

      const res = await fetch(`http://127.0.0.1:${port}/echo`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      expect(res.status).toBe(413);
    });
  });

  describe('Rate Limiter (P4)', () => {
    it('allows requests up to the configured limit', async () => {
      const port = await startServer(createRateLimitedApp(3, 60000));

      for (let i = 0; i < 3; i++) {
        const res = await fetch(`http://127.0.0.1:${port}/api/context/inject`);
        expect(res.status).toBe(200);
      }
    });

    it('returns 429 when the limit is exceeded', async () => {
      const port = await startServer(createRateLimitedApp(3, 60000));

      for (let i = 0; i < 3; i++) {
        await fetch(`http://127.0.0.1:${port}/api/context/inject`);
      }

      const res = await fetch(`http://127.0.0.1:${port}/api/context/inject`);
      expect(res.status).toBe(429);

      const body = await res.json() as { error: string; retryAfterMs: number };
      expect(body.error).toBe('Too many requests');
      expect(body.retryAfterMs).toBeGreaterThan(0);
      expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);
    });

    it('resets the counter after the window expires', async () => {
      const port = await startServer(createRateLimitedApp(1, 40));

      let res = await fetch(`http://127.0.0.1:${port}/api/context/inject`);
      expect(res.status).toBe(200);

      res = await fetch(`http://127.0.0.1:${port}/api/context/inject`);
      expect(res.status).toBe(429);

      await Bun.sleep(60);

      res = await fetch(`http://127.0.0.1:${port}/api/context/inject`);
      expect(res.status).toBe(200);
    });

    it('tracks each client independently for the same route', async () => {
      const port = await startServer(createRateLimitedApp(1, 60000));

      let res = await fetch(`http://127.0.0.1:${port}/api/context/inject`, {
        headers: { 'X-Forwarded-For': '10.0.0.1' },
      });
      expect(res.status).toBe(200);

      res = await fetch(`http://127.0.0.1:${port}/api/context/inject`, {
        headers: { 'X-Forwarded-For': '10.0.0.1' },
      });
      expect(res.status).toBe(429);

      res = await fetch(`http://127.0.0.1:${port}/api/context/inject`, {
        headers: { 'X-Forwarded-For': '10.0.0.2' },
      });
      expect(res.status).toBe(200);
    });

    it('does not share counters across middleware instances', async () => {
      const firstPort = await startServer(createRateLimitedApp(1, 60000));
      const secondPort = await startServer(createRateLimitedApp(1, 60000));
      const headers = { 'X-Forwarded-For': '10.0.0.1' };

      let res = await fetch(`http://127.0.0.1:${firstPort}/api/context/inject`, { headers });
      expect(res.status).toBe(200);

      res = await fetch(`http://127.0.0.1:${firstPort}/api/context/inject`, { headers });
      expect(res.status).toBe(429);

      res = await fetch(`http://127.0.0.1:${secondPort}/api/context/inject`, { headers });
      expect(res.status).toBe(200);
    });

    it('rejects invalid rate limiter configuration', () => {
      expect(() => rateLimit(0, 1000)).toThrow('maxRequests must be a positive integer');
      expect(() => rateLimit(1.5, 1000)).toThrow('maxRequests must be a positive integer');
      expect(() => rateLimit(1, 0)).toThrow('windowMs must be a positive integer');
      expect(() => rateLimit(1, 12.5)).toThrow('windowMs must be a positive integer');
    });

    it('worker service mounts the shared rate limiter on /api before route registration', async () => {
      const source = await Bun.file('src/services/worker-service.ts').text();
      const guardIndex = source.indexOf("this.server.app.use('/api', async (req, res, next) => {");
      const limiterIndex = source.indexOf("this.server.app.use('/api', rateLimit(300, 60_000));");
      const routeIndex = source.indexOf('this.server.registerRoutes(new ViewerRoutes');

      expect(guardIndex).toBeGreaterThan(-1);
      expect(limiterIndex).toBeGreaterThan(guardIndex);
      expect(routeIndex).toBeGreaterThan(limiterIndex);
    });
  });
});
