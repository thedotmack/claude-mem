import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import express from 'express';
import http from 'http';
import { createCorsMiddleware, createMiddleware } from '../../../src/services/worker/http/middleware.js';

import { isLocalhostOrigin } from '../../../src/services/worker/http/origin-policy.js';

describe('CORS Restriction', () => {
  it.each([
    ['http://localhost:37777', true],
    ['http://localhost:3000', true],
    ['http://localhost:8080', true],
    ['http://127.0.0.1:37777', true],
    ['http://127.0.0.1:3000', true],
    ['http://evil.com', false],
    ['https://attacker.io', false],
    ['http://malicious-site.net:8080', false],
    ['https://localhost:37777', false],
    ['http://localhost.evil.com', false],
    ['http://localhost.attacker.io:8080', false],
    ['file://', false],
    ['null', false],
  ])('classifies %s as localhost: %s', (origin, expected) => {
    expect(isLocalhostOrigin(origin)).toBe(expected);
  });

  describe('preflight CORS headers (#1029)', () => {
    let app: express.Application;
    let server: http.Server;
    let testPort: number;

    beforeEach(async () => {
      app = express();
      createMiddleware().forEach(middleware => app.use(middleware));
      app.use(createCorsMiddleware());

      app.all('/api/settings', (_req, res) => {
        res.json({ ok: true });
      });

      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => reject(error);
        server = app.listen(0, '127.0.0.1', () => {
          server.removeListener('error', onError);
          const address = server.address();
          if (!address || typeof address === 'string') {
            reject(new Error('Test server did not expose an assigned port'));
            return;
          }
          testPort = address.port;
          resolve();
        });
        server.once('error', onError);
      });
    });

    afterEach(async () => {
      if (server?.listening) {
        await new Promise<void>((resolve, reject) => {
          server.close(err => err ? reject(err) : resolve());
        });
      }
    });

    it('allows requests without Origin header (hooks, curl, CLI)', async () => {
      const response = await fetch(`http://127.0.0.1:${testPort}/api/settings`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
    });

    it('preflight response includes supported methods and headers', async () => {
      const response = await fetch(`http://127.0.0.1:${testPort}/api/settings`, {
        method: 'OPTIONS',
        headers: {
          'Origin': 'http://localhost:37777',
          'Access-Control-Request-Method': 'PUT',
          'Access-Control-Request-Headers': 'Content-Type,Authorization',
        },
      });

      expect([200, 204]).toContain(response.status);
      const allowedMethods = response.headers.get('access-control-allow-methods');
      for (const method of ['PUT', 'PATCH', 'DELETE']) expect(allowedMethods).toContain(method);
      const allowedHeaders = response.headers.get('access-control-allow-headers');
      for (const header of ['Content-Type', 'Authorization']) expect(allowedHeaders).toContain(header);
    });

    it('preflight from localhost includes allow-origin header', async () => {
      const response = await fetch(`http://127.0.0.1:${testPort}/api/settings`, {
        method: 'OPTIONS',
        headers: {
          'Origin': 'http://localhost:37777',
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': 'Content-Type',
        },
      });

      expect([200, 204]).toContain(response.status);
      const origin = response.headers.get('access-control-allow-origin');
      expect(origin).toBe('http://localhost:37777');
    });

    it('preflight from external origin omits allow-origin header', async () => {
      const response = await fetch(`http://127.0.0.1:${testPort}/api/settings`, {
        method: 'OPTIONS',
        headers: {
          'Origin': 'http://evil.com',
          'Access-Control-Request-Method': 'POST',
        },
      });

      const origin = response.headers.get('access-control-allow-origin');
      expect(origin).toBeNull();
    });
  });
});
