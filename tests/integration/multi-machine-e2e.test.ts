/**
 * Multi-Machine End-to-End Integration Tests
 *
 * Validates the full proxy → server flow using real HTTP servers (no mocks).
 * Tests the three critical scenarios for multi-machine networking:
 *
 * 1. Proxy → Server forwarding with provenance headers
 * 2. Offline buffer + replay when server recovers
 * 3. Auth header injection and auth middleware rejection
 */

import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import path from 'path';
import os from 'os';
import express from 'express';
import http from 'http';
import type { Request, Response, NextFunction } from 'express';
import { logger } from '../../src/utils/logger.js';
import { ProxyServer } from '../../src/services/proxy/ProxyServer.js';
import { createAuthMiddleware } from '../../src/services/worker/http/auth-middleware.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Start an Express server on a random port, resolving with { server, port, app }. */
function startMockServer(): Promise<{ server: http.Server; port: number; app: express.Express }> {
  return new Promise((resolve, reject) => {
    const app = express();
    app.use(express.json());

    const server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        reject(new Error('Could not get server address'));
        return;
      }
      resolve({ server, port: addr.port, app });
    });
    server.on('error', reject);
  });
}

/** Gracefully shut down an http.Server. */
function stopServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
}

/** Pick a random high port unlikely to be in use. */
function randomProxyPort(): number {
  return 42000 + Math.floor(Math.random() * 8000);
}

// ─── Suppress logger output during tests ──────────────────────────────────────

let loggerSpies: ReturnType<typeof spyOn>[] = [];

// ─── Test Suite ───────────────────────────────────────────────────────────────

describe('Multi-machine E2E', () => {
  let tmpDir: string;
  let proxy: ProxyServer | null = null;
  let mockServer: http.Server | null = null;
  let extraServer: http.Server | null = null;

  beforeEach(() => {
    loggerSpies = [
      spyOn(logger, 'info').mockImplementation(() => {}),
      spyOn(logger, 'debug').mockImplementation(() => {}),
      spyOn(logger, 'warn').mockImplementation(() => {}),
      spyOn(logger, 'error').mockImplementation(() => {}),
    ];

    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'mm-e2e-test-'));

    // Predictable node identity for header assertions
    process.env.CLAUDE_MEM_NODE_NAME = 'e2e-node';
    process.env.CLAUDE_MEM_INSTANCE_NAME = 'e2e-instance';
  });

  afterEach(async () => {
    loggerSpies.forEach(spy => spy.mockRestore());

    if (proxy) {
      try { await proxy.stop(); } catch { /* ignore */ }
      proxy = null;
    }
    if (mockServer) {
      try { await stopServer(mockServer); } catch { /* ignore */ }
      mockServer = null;
    }
    if (extraServer) {
      try { await stopServer(extraServer); } catch { /* ignore */ }
      extraServer = null;
    }

    rmSync(tmpDir, { recursive: true, force: true });

    delete process.env.CLAUDE_MEM_NODE_NAME;
    delete process.env.CLAUDE_MEM_INSTANCE_NAME;
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Scenario 1: Proxy → Server forwarding with provenance
  // ───────────────────────────────────────────────────────────────────────────

  describe('Proxy → Server forwarding', () => {
    it('should forward POST with auth and node headers to the server', async () => {
      // Start mock "server" node
      const mock = await startMockServer();
      mockServer = mock.server;

      let receivedHeaders: Record<string, string | string[] | undefined> = {};
      let receivedBody: any = null;
      mock.app.post('/api/sessions/observations', (req: Request, res: Response) => {
        receivedHeaders = req.headers;
        receivedBody = req.body;
        res.status(201).json({ id: 99 });
      });

      // Start proxy pointing at the mock server
      const proxyPort = randomProxyPort();
      proxy = new ProxyServer({
        serverHost: '127.0.0.1',
        serverPort: mock.port,
        authToken: 'e2e-secret-token',
        dataDir: tmpDir,
        healthCheckIntervalMs: 30_000, // Don't interfere with test
      });
      await proxy.start(proxyPort);

      // Send POST through the proxy
      const response = await fetch(`http://127.0.0.1:${proxyPort}/api/sessions/observations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'e2e observation', tool: 'Bash' }),
      });

      // Proxy should return the server's response
      expect(response.status).toBe(201);
      const body = await response.json();
      expect(body.id).toBe(99);

      // Server should have received the original body
      expect(receivedBody).not.toBeNull();
      expect(receivedBody.content).toBe('e2e observation');
      expect(receivedBody.tool).toBe('Bash');

      // Server should have received provenance headers injected by the proxy
      expect(receivedHeaders['x-claude-mem-node']).toBe('e2e-node');
      expect(receivedHeaders['x-claude-mem-instance']).toBe('e2e-instance');
      expect(receivedHeaders['x-claude-mem-mode']).toBe('proxy');
      expect(receivedHeaders['authorization']).toBe('Bearer e2e-secret-token');
    });

    it('should forward GET and return the server response unchanged', async () => {
      const mock = await startMockServer();
      mockServer = mock.server;

      mock.app.get('/api/health', (_req: Request, res: Response) => {
        res.status(200).json({ status: 'ok' });
      });

      const proxyPort = randomProxyPort();
      proxy = new ProxyServer({
        serverHost: '127.0.0.1',
        serverPort: mock.port,
        authToken: 'e2e-secret-token',
        dataDir: tmpDir,
        healthCheckIntervalMs: 30_000,
      });
      await proxy.start(proxyPort);

      const response = await fetch(`http://127.0.0.1:${proxyPort}/api/health`);

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.status).toBe('ok');
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Scenario 2: Offline buffer + replay
  // ───────────────────────────────────────────────────────────────────────────

  describe('Offline buffer + replay', () => {
    it('should buffer when server is down and replay when it comes back', async () => {
      // Step 1: Start proxy pointing at a dead port, buffer requests
      const deadPort = 49000 + Math.floor(Math.random() * 500);
      const proxyPort = randomProxyPort();

      proxy = new ProxyServer({
        serverHost: '127.0.0.1',
        serverPort: deadPort,
        authToken: 'e2e-token',
        dataDir: tmpDir,
        healthCheckIntervalMs: 500, // Fast health checks for this test
      });
      await proxy.start(proxyPort);

      // Send 2 POST requests — they should be buffered
      const r1 = await fetch(`http://127.0.0.1:${proxyPort}/api/sessions/observations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'buffered-1' }),
      });
      const r2 = await fetch(`http://127.0.0.1:${proxyPort}/api/sessions/observations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'buffered-2' }),
      });

      // Responses should be 202 (buffered)
      expect(r1.status).toBe(202);
      expect(r2.status).toBe(202);
      expect((await r1.json()).buffered).toBe(true);
      expect((await r2.json()).buffered).toBe(true);

      // Buffer should hold 2 pending entries
      expect(proxy.getPendingCount()).toBe(2);
      expect(proxy.isServerReachable()).toBe(false);

      // Step 2: Stop the proxy so we can restart it pointing at a live server
      await proxy.stop();
      proxy = null;

      // Step 3: Start the mock server (on the dead port)
      const replayedBodies: any[] = [];
      let replayHeaderSeen = false;

      await new Promise<void>((resolve, reject) => {
        const app = express();
        app.use(express.json());

        app.post('/api/sessions/observations', (req: Request, res: Response) => {
          replayedBodies.push(req.body);
          if (req.headers['x-claude-mem-replayed'] === 'true') {
            replayHeaderSeen = true;
          }
          res.status(201).json({ ok: true });
        });

        app.get('/api/health', (_req: Request, res: Response) => {
          res.status(200).json({ status: 'ok' });
        });

        const server = app.listen(deadPort, '127.0.0.1', () => {
          mockServer = server;
          resolve();
        });
        server.on('error', reject);
      });

      // Step 4: Create a new proxy pointing at the live server, sharing the same buffer dir.
      // serverReachable starts as false → first successful health check triggers replay.
      const proxyPort2 = randomProxyPort();
      proxy = new ProxyServer({
        serverHost: '127.0.0.1',
        serverPort: deadPort,
        authToken: 'e2e-token',
        dataDir: tmpDir,
        healthCheckIntervalMs: 500,
      });
      await proxy.start(proxyPort2);

      // Buffer should still have 2 entries
      expect(proxy.getPendingCount()).toBe(2);

      // Step 5: Wait for health check to detect server is back and trigger replay (max 5s)
      const deadline = Date.now() + 5_000;
      while (proxy.getPendingCount() > 0 && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 150));
      }

      // All buffered requests replayed
      expect(proxy.getPendingCount()).toBe(0);
      expect(replayedBodies.length).toBe(2);
      expect(replayedBodies[0].content).toBe('buffered-1');
      expect(replayedBodies[1].content).toBe('buffered-2');

      // Replay header set by ProxyServer.replayBuffer()
      expect(replayHeaderSeen).toBe(true);
      expect(proxy.isServerReachable()).toBe(true);
    }, 10_000); // 10s timeout for timing-sensitive test
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Scenario 3: Auth header injection + auth middleware rejection
  // ───────────────────────────────────────────────────────────────────────────

  describe('Auth header injection', () => {
    it('should add Bearer token to all forwarded requests', async () => {
      const mock = await startMockServer();
      mockServer = mock.server;

      const receivedAuthHeaders: string[] = [];
      mock.app.all('*', (req: Request, res: Response) => {
        if (req.headers.authorization) {
          receivedAuthHeaders.push(req.headers.authorization);
        }
        res.status(200).json({ ok: true });
      });

      const proxyPort = randomProxyPort();
      proxy = new ProxyServer({
        serverHost: '127.0.0.1',
        serverPort: mock.port,
        authToken: 'my-bearer-token',
        dataDir: tmpDir,
        healthCheckIntervalMs: 30_000,
      });
      await proxy.start(proxyPort);

      // POST through proxy (no auth header in the client request)
      await fetch(`http://127.0.0.1:${proxyPort}/api/sessions/observations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: 'test' }),
      });

      // GET through proxy (use /api/version — not a proxy-intercepted endpoint)
      await fetch(`http://127.0.0.1:${proxyPort}/api/version`);

      // Both requests should have received the Bearer token injected by the proxy
      expect(receivedAuthHeaders.length).toBe(2);
      expect(receivedAuthHeaders[0]).toBe('Bearer my-bearer-token');
      expect(receivedAuthHeaders[1]).toBe('Bearer my-bearer-token');
    });

    it('should add X-Claude-Mem-Node header to every forwarded request', async () => {
      const mock = await startMockServer();
      mockServer = mock.server;

      const nodeHeaders: string[] = [];
      mock.app.all('*', (req: Request, res: Response) => {
        const h = req.headers['x-claude-mem-node'];
        if (h) nodeHeaders.push(h as string);
        res.status(200).json({ ok: true });
      });

      const proxyPort = randomProxyPort();
      proxy = new ProxyServer({
        serverHost: '127.0.0.1',
        serverPort: mock.port,
        authToken: 'token',
        dataDir: tmpDir,
        healthCheckIntervalMs: 30_000,
      });
      await proxy.start(proxyPort);

      // Use /api/version (non-intercepted GET) + POST to verify node header forwarding
      await fetch(`http://127.0.0.1:${proxyPort}/api/version`);
      await fetch(`http://127.0.0.1:${proxyPort}/api/sessions/observations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      expect(nodeHeaders.length).toBe(2);
      expect(nodeHeaders[0]).toBe('e2e-node');
      expect(nodeHeaders[1]).toBe('e2e-node');
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Scenario 3b: Auth middleware rejection (direct unit-style, no workaround needed)
  // ───────────────────────────────────────────────────────────────────────────

  describe('Auth rejection', () => {
    /**
     * The auth middleware always passes localhost requests. To test rejection we
     * call it directly with a non-localhost IP — exactly how it will behave for
     * remote machines in multi-machine mode.
     */
    it('should reject remote requests with 401 when no Bearer token is provided', () => {
      const middleware = createAuthMiddleware(() => 'server-secret');

      let capturedStatus: number | undefined;
      let capturedBody: any;

      const req = {
        ip: '192.168.1.50',
        connection: { remoteAddress: '192.168.1.50' },
        path: '/api/sessions/observations',
        headers: {},
      } as unknown as Request;

      const res = {
        status: (code: number) => { capturedStatus = code; return res; },
        json: (body: any) => { capturedBody = body; return res; },
      } as unknown as Response;

      const next = () => { throw new Error('next() should not be called'); };

      middleware(req, res, next as NextFunction);

      expect(capturedStatus).toBe(401);
      expect(capturedBody.error).toBe('unauthorized');
    });

    it('should reject remote requests with 403 when no auth token is configured on the server', () => {
      // Server-side: no token configured (open dev server, no CLAUDE_MEM_AUTH_TOKEN)
      const middleware = createAuthMiddleware(() => '');

      let capturedStatus: number | undefined;
      let capturedBody: any;

      const req = {
        ip: '10.0.0.42',
        connection: { remoteAddress: '10.0.0.42' },
        path: '/api/sessions/observations',
        headers: {},
      } as unknown as Request;

      const res = {
        status: (code: number) => { capturedStatus = code; return res; },
        json: (body: any) => { capturedBody = body; return res; },
      } as unknown as Response;

      const next = () => { throw new Error('next() should not be called'); };

      middleware(req, res, next as NextFunction);

      expect(capturedStatus).toBe(403);
      expect(capturedBody.error).toBe('forbidden');
    });

    it('should reject remote requests with 401 when Bearer token is wrong', () => {
      const middleware = createAuthMiddleware(() => 'correct-token');

      let capturedStatus: number | undefined;
      const req = {
        ip: '10.0.0.1',
        connection: { remoteAddress: '10.0.0.1' },
        path: '/api/health',
        headers: { authorization: 'Bearer wrong-token' },
      } as unknown as Request;

      const res = {
        status: (code: number) => { capturedStatus = code; return res; },
        json: (_body: any) => res,
      } as unknown as Response;

      middleware(req, res, (() => { throw new Error('should not call next'); }) as NextFunction);

      expect(capturedStatus).toBe(401);
    });

    it('should pass localhost requests through without a token (proxy → server on same machine)', () => {
      // Proxied requests arrive as localhost since the proxy runs on 127.0.0.1
      const middleware = createAuthMiddleware(() => 'server-secret');

      let nextCalled = false;
      const req = {
        ip: '127.0.0.1',
        connection: { remoteAddress: '127.0.0.1' },
        path: '/api/sessions/observations',
        headers: {},
      } as unknown as Request;
      const res = {} as unknown as Response;

      middleware(req, res, (() => { nextCalled = true; }) as NextFunction);

      // Proxy itself runs on localhost, so the server always trusts it.
      // The proxy adds the Bearer token for remote-to-remote authentication.
      expect(nextCalled).toBe(true);
    });
  });
});
