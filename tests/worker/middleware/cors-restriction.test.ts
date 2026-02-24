/**
 * CORS Restriction Tests
 *
 * Verifies that CORS is properly restricted to localhost origins only,
 * and that preflight responses include the correct methods and headers (#1029).
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import express from 'express';
import cors from 'cors';
import http from 'http';

// Test the CORS origin validation logic directly
function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin) return true; // No origin = hooks, curl, CLI
  if (origin.startsWith('http://localhost:')) return true;
  if (origin.startsWith('http://127.0.0.1:')) return true;
  return false;
}

/**
 * Build the same CORS config used in production middleware.ts.
 * Duplicated here to avoid module-mock interference from other test files.
 */
function buildProductionCorsMiddleware() {
  return cors({
    origin: (origin, callback) => {
      if (!origin ||
          origin.startsWith('http://localhost:') ||
          origin.startsWith('http://127.0.0.1:')) {
        callback(null, true);
      } else {
        callback(new Error('CORS not allowed'));
      }
    },
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
    credentials: false
  });
}

describe('CORS Restriction', () => {
  describe('allowed origins', () => {
    it('allows requests without Origin header (hooks, curl, CLI)', () => {
      expect(isAllowedOrigin(undefined)).toBe(true);
    });

    it('allows localhost with port', () => {
      expect(isAllowedOrigin('http://localhost:37777')).toBe(true);
      expect(isAllowedOrigin('http://localhost:3000')).toBe(true);
      expect(isAllowedOrigin('http://localhost:8080')).toBe(true);
    });

    it('allows 127.0.0.1 with port', () => {
      expect(isAllowedOrigin('http://127.0.0.1:37777')).toBe(true);
      expect(isAllowedOrigin('http://127.0.0.1:3000')).toBe(true);
    });
  });

  describe('blocked origins', () => {
    it('blocks external domains', () => {
      expect(isAllowedOrigin('http://evil.com')).toBe(false);
      expect(isAllowedOrigin('https://attacker.io')).toBe(false);
      expect(isAllowedOrigin('http://malicious-site.net:8080')).toBe(false);
    });

    it('blocks HTTPS localhost (not typically used for local dev)', () => {
      // HTTPS localhost is unusual and could indicate a proxy attack
      expect(isAllowedOrigin('https://localhost:37777')).toBe(false);
    });

    it('blocks localhost-like domains (subdomain attacks)', () => {
      expect(isAllowedOrigin('http://localhost.evil.com')).toBe(false);
      expect(isAllowedOrigin('http://localhost.attacker.io:8080')).toBe(false);
    });

    it('blocks file:// origins', () => {
      expect(isAllowedOrigin('file://')).toBe(false);
    });

    it('blocks null origin', () => {
      // null origin can come from sandboxed iframes
      expect(isAllowedOrigin('null')).toBe(false);
    });
  });

  describe('preflight CORS headers (#1029)', () => {
    let app: express.Application;
    let server: http.Server;
    let testPort: number;

    beforeEach(async () => {
      app = express();
      app.use(express.json());
      app.use(buildProductionCorsMiddleware());

      // Add a test endpoint that supports all methods
      app.all('/api/settings', (_req, res) => {
        res.json({ ok: true });
      });

      testPort = 41000 + Math.floor(Math.random() * 10000);
      await new Promise<void>((resolve) => {
        server = app.listen(testPort, '127.0.0.1', resolve);
      });
    });

    afterEach(async () => {
      if (server) {
        await new Promise<void>((resolve, reject) => {
          server.close(err => err ? reject(err) : resolve());
        });
      }
    });

    it('preflight response includes PUT in allowed methods', async () => {
      const response = await fetch(`http://127.0.0.1:${testPort}/api/settings`, {
        method: 'OPTIONS',
        headers: {
          'Origin': 'http://localhost:37777',
          'Access-Control-Request-Method': 'PUT',
        },
      });

      expect(response.status).toBe(204);
      const allowedMethods = response.headers.get('access-control-allow-methods');
      expect(allowedMethods).toContain('PUT');
    });

    it('preflight response includes PATCH in allowed methods', async () => {
      const response = await fetch(`http://127.0.0.1:${testPort}/api/settings`, {
        method: 'OPTIONS',
        headers: {
          'Origin': 'http://localhost:37777',
          'Access-Control-Request-Method': 'PATCH',
        },
      });

      expect(response.status).toBe(204);
      const allowedMethods = response.headers.get('access-control-allow-methods');
      expect(allowedMethods).toContain('PATCH');
    });

    it('preflight response includes DELETE in allowed methods', async () => {
      const response = await fetch(`http://127.0.0.1:${testPort}/api/settings`, {
        method: 'OPTIONS',
        headers: {
          'Origin': 'http://localhost:37777',
          'Access-Control-Request-Method': 'DELETE',
        },
      });

      expect(response.status).toBe(204);
      const allowedMethods = response.headers.get('access-control-allow-methods');
      expect(allowedMethods).toContain('DELETE');
    });

    it('preflight response includes Content-Type in allowed headers', async () => {
      const response = await fetch(`http://127.0.0.1:${testPort}/api/settings`, {
        method: 'OPTIONS',
        headers: {
          'Origin': 'http://localhost:37777',
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': 'Content-Type',
        },
      });

      expect(response.status).toBe(204);
      const allowedHeaders = response.headers.get('access-control-allow-headers');
      expect(allowedHeaders).toContain('Content-Type');
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

      expect(response.status).toBe(204);
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

      // cors middleware rejects disallowed origins — browser enforces the block
      const origin = response.headers.get('access-control-allow-origin');
      expect(origin).toBeNull();
    });
  });
});
