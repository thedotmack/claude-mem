import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import path from 'path';
import os from 'os';
import express from 'express';
import http from 'http';
import { logger } from '../../src/utils/logger.js';
import { ProxyServer } from '../../src/services/proxy/ProxyServer.js';

// Suppress logger output during tests
let loggerSpies: ReturnType<typeof spyOn>[] = [];

/** Create an Express mock server on a random port. Returns { server, port, app }. */
function createMockServer(): Promise<{ server: http.Server; port: number; app: express.Express }> {
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

/** Shut down an http.Server. */
function closeMockServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
}

/** Get a random high port. */
function randomPort(): number {
  return 41000 + Math.floor(Math.random() * 10000);
}

describe('ProxyServer', () => {
  let tmpDir: string;
  let mockServer: http.Server | null = null;
  let mockApp: express.Express | null = null;
  let mockPort: number = 0;
  let proxy: ProxyServer | null = null;
  let proxyPort: number;

  beforeEach(async () => {
    loggerSpies = [
      spyOn(logger, 'info').mockImplementation(() => {}),
      spyOn(logger, 'debug').mockImplementation(() => {}),
      spyOn(logger, 'warn').mockImplementation(() => {}),
      spyOn(logger, 'error').mockImplementation(() => {}),
    ];

    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'proxy-server-test-'));
    proxyPort = randomPort();

    // Set predictable node identity via env vars
    process.env.CLAUDE_MEM_NODE_NAME = 'test-node';
    process.env.CLAUDE_MEM_INSTANCE_NAME = 'test-instance';
  });

  afterEach(async () => {
    loggerSpies.forEach(spy => spy.mockRestore());

    if (proxy) {
      try { await proxy.stop(); } catch { /* ignore */ }
      proxy = null;
    }
    if (mockServer) {
      try { await closeMockServer(mockServer); } catch { /* ignore */ }
      mockServer = null;
    }

    rmSync(tmpDir, { recursive: true, force: true });

    delete process.env.CLAUDE_MEM_NODE_NAME;
    delete process.env.CLAUDE_MEM_INSTANCE_NAME;
  });

  describe('GET forwarding', () => {
    it('should forward GET requests and return same status + body', async () => {
      const mock = await createMockServer();
      mockServer = mock.server;
      mockPort = mock.port;
      mockApp = mock.app;

      mockApp.get('/api/health', (_req, res) => {
        res.status(200).json({ status: 'ok', uptime: 12345 });
      });

      proxy = new ProxyServer('127.0.0.1', mockPort, 'test-token', tmpDir);
      await proxy.start(proxyPort);

      const response = await fetch(`http://127.0.0.1:${proxyPort}/api/health`);
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body.status).toBe('ok');
      expect(body.uptime).toBe(12345);
    });

    it('should forward GET with query string', async () => {
      const mock = await createMockServer();
      mockServer = mock.server;
      mockPort = mock.port;
      mockApp = mock.app;

      let receivedQuery: any = {};
      mockApp.get('/api/search', (req, res) => {
        receivedQuery = req.query;
        res.status(200).json({ results: [] });
      });

      proxy = new ProxyServer('127.0.0.1', mockPort, 'test-token', tmpDir);
      await proxy.start(proxyPort);

      await fetch(`http://127.0.0.1:${proxyPort}/api/search?q=hello&limit=10`);
      expect(receivedQuery.q).toBe('hello');
      expect(receivedQuery.limit).toBe('10');
    });
  });

  describe('POST forwarding', () => {
    it('should forward POST body to the server', async () => {
      const mock = await createMockServer();
      mockServer = mock.server;
      mockPort = mock.port;
      mockApp = mock.app;

      let receivedBody: any = null;
      mockApp.post('/api/sessions/observations', (req, res) => {
        receivedBody = req.body;
        res.status(201).json({ id: 42 });
      });

      proxy = new ProxyServer('127.0.0.1', mockPort, 'test-token', tmpDir);
      await proxy.start(proxyPort);

      const response = await fetch(`http://127.0.0.1:${proxyPort}/api/sessions/observations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'test observation', tool: 'Bash' }),
      });

      expect(response.status).toBe(201);
      const body = await response.json();
      expect(body.id).toBe(42);
      expect(receivedBody.content).toBe('test observation');
      expect(receivedBody.tool).toBe('Bash');
    });
  });

  describe('auth and node headers', () => {
    it('should add X-Claude-Mem-Node, X-Claude-Mem-Instance, X-Claude-Mem-Mode, and Authorization headers', async () => {
      const mock = await createMockServer();
      mockServer = mock.server;
      mockPort = mock.port;
      mockApp = mock.app;

      let receivedHeaders: Record<string, string | string[] | undefined> = {};
      mockApp.get('/api/test', (req, res) => {
        receivedHeaders = req.headers;
        res.status(200).json({ ok: true });
      });

      proxy = new ProxyServer('127.0.0.1', mockPort, 'my-secret-token', tmpDir);
      await proxy.start(proxyPort);

      await fetch(`http://127.0.0.1:${proxyPort}/api/test`);

      expect(receivedHeaders['x-claude-mem-node']).toBe('test-node');
      expect(receivedHeaders['x-claude-mem-instance']).toBe('test-instance');
      expect(receivedHeaders['x-claude-mem-mode']).toBe('proxy');
      expect(receivedHeaders['authorization']).toBe('Bearer my-secret-token');
    });

    it('should omit Authorization header when token is empty', async () => {
      const mock = await createMockServer();
      mockServer = mock.server;
      mockPort = mock.port;
      mockApp = mock.app;

      let receivedHeaders: Record<string, string | string[] | undefined> = {};
      mockApp.get('/api/test', (req, res) => {
        receivedHeaders = req.headers;
        res.status(200).json({ ok: true });
      });

      proxy = new ProxyServer('127.0.0.1', mockPort, '', tmpDir);
      await proxy.start(proxyPort);

      await fetch(`http://127.0.0.1:${proxyPort}/api/test`);

      expect(receivedHeaders['x-claude-mem-node']).toBe('test-node');
      expect(receivedHeaders['x-claude-mem-mode']).toBe('proxy');
      expect(receivedHeaders['authorization']).toBeUndefined();
    });
  });

  describe('server down — POST buffering', () => {
    it('should return 202 with buffered: true when server is unreachable', async () => {
      // Point proxy at a port with no server
      const deadPort = randomPort() + 100;
      proxy = new ProxyServer('127.0.0.1', deadPort, 'test-token', tmpDir);
      await proxy.start(proxyPort);

      const response = await fetch(`http://127.0.0.1:${proxyPort}/api/sessions/observations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'offline observation' }),
      });

      expect(response.status).toBe(202);
      const body = await response.json();
      expect(body.buffered).toBe(true);
      expect(body.path).toBe('/api/sessions/observations');

      // Buffer should have 1 pending entry
      expect(proxy.getPendingCount()).toBe(1);
    });

    it('should buffer multiple POST requests when server is down', async () => {
      const deadPort = randomPort() + 100;
      proxy = new ProxyServer('127.0.0.1', deadPort, 'test-token', tmpDir);
      await proxy.start(proxyPort);

      for (let i = 0; i < 3; i++) {
        await fetch(`http://127.0.0.1:${proxyPort}/api/data`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ index: i }),
        });
      }

      expect(proxy.getPendingCount()).toBe(3);
    });
  });

  describe('server down — GET returns 503', () => {
    it('should return 503 when server is unreachable for GET', async () => {
      const deadPort = randomPort() + 100;
      proxy = new ProxyServer('127.0.0.1', deadPort, 'test-token', tmpDir);
      await proxy.start(proxyPort);

      const response = await fetch(`http://127.0.0.1:${proxyPort}/api/health`);

      expect(response.status).toBe(503);
      const body = await response.json();
      expect(body.error).toBe('server_unreachable');
      expect(body.serverHost).toBe('127.0.0.1');
    });
  });

  describe('serverReachable state', () => {
    it('should report server as reachable after successful forward', async () => {
      const mock = await createMockServer();
      mockServer = mock.server;
      mockPort = mock.port;
      mockApp = mock.app;

      mockApp.get('/api/health', (_req, res) => {
        res.status(200).json({ status: 'ok' });
      });

      proxy = new ProxyServer('127.0.0.1', mockPort, 'test-token', tmpDir);
      await proxy.start(proxyPort);

      // Initially not marked reachable (no requests yet)
      expect(proxy.isServerReachable()).toBe(false);

      // Make a request
      await fetch(`http://127.0.0.1:${proxyPort}/api/health`);

      expect(proxy.isServerReachable()).toBe(true);
    });

    it('should report server as unreachable after failed request', async () => {
      const deadPort = randomPort() + 100;
      proxy = new ProxyServer('127.0.0.1', deadPort, 'test-token', tmpDir);
      await proxy.start(proxyPort);

      await fetch(`http://127.0.0.1:${proxyPort}/api/health`);

      expect(proxy.isServerReachable()).toBe(false);
    });
  });

  describe('buffer replay when server comes back', () => {
    it('should replay buffered requests when health check detects server recovery', async () => {
      // Step 1: Start proxy pointing at dead port, buffer some requests
      const deadPort = randomPort() + 100;
      proxy = new ProxyServer({
        serverHost: '127.0.0.1',
        serverPort: deadPort,
        authToken: 'test-token',
        dataDir: tmpDir,
        healthCheckIntervalMs: 500,  // Fast health check for tests
      });
      await proxy.start(proxyPort);

      // Buffer 2 POST requests
      await fetch(`http://127.0.0.1:${proxyPort}/api/sessions/observations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'obs1' }),
      });
      await fetch(`http://127.0.0.1:${proxyPort}/api/sessions/observations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'obs2' }),
      });

      expect(proxy.getPendingCount()).toBe(2);
      expect(proxy.isServerReachable()).toBe(false);

      // Step 2: Stop the proxy so we can create a new one pointing at a live server
      await proxy.stop();

      // Step 3: Start a real mock server
      const mock = await createMockServer();
      mockServer = mock.server;
      mockPort = mock.port;
      mockApp = mock.app;

      const replayedBodies: any[] = [];
      let replayHeaderSeen = false;
      mockApp.post('/api/sessions/observations', (req, res) => {
        replayedBodies.push(req.body);
        if (req.headers['x-claude-mem-replayed'] === 'true') {
          replayHeaderSeen = true;
        }
        res.status(201).json({ ok: true });
      });

      mockApp.get('/api/health', (_req, res) => {
        res.status(200).json({ status: 'ok' });
      });

      // Step 4: Create new proxy pointing at the live server, sharing same buffer dir.
      // serverReachable starts as false, so the first successful health check
      // will trigger the unreachable->reachable transition and replay.
      const proxyPort2 = randomPort() + 200;
      proxy = new ProxyServer({
        serverHost: '127.0.0.1',
        serverPort: mockPort,
        authToken: 'test-token',
        dataDir: tmpDir,
        healthCheckIntervalMs: 500,  // Fast health check for tests
      });
      await proxy.start(proxyPort2);

      // Verify buffer still has entries from step 1
      expect(proxy.getPendingCount()).toBe(2);

      // Step 5: Wait for health check to fire, detect server is up, and trigger replay.
      // With 500ms interval, this should complete within a few seconds.
      const start = Date.now();
      while (proxy.getPendingCount() > 0 && Date.now() - start < 5_000) {
        await new Promise(resolve => setTimeout(resolve, 200));
      }

      expect(proxy.getPendingCount()).toBe(0);
      expect(replayedBodies.length).toBe(2);
      expect(replayedBodies[0].content).toBe('obs1');
      expect(replayedBodies[1].content).toBe('obs2');
      expect(replayHeaderSeen).toBe(true);
      expect(proxy.isServerReachable()).toBe(true);
    }, 10_000); // 10s timeout
  });

  describe('stop', () => {
    it('should stop the server and clean up', async () => {
      const mock = await createMockServer();
      mockServer = mock.server;
      mockPort = mock.port;

      proxy = new ProxyServer('127.0.0.1', mockPort, 'test-token', tmpDir);
      await proxy.start(proxyPort);

      await proxy.stop();

      // Requesting the stopped proxy should fail
      try {
        await fetch(`http://127.0.0.1:${proxyPort}/api/health`);
        // If fetch doesn't throw, it should at least fail with connection refused
        expect(true).toBe(false); // should not reach here
      } catch (error: any) {
        // Expected: connection refused
        expect(error.message || error.code).toBeDefined();
      }

      proxy = null; // don't double-stop in afterEach
    });
  });
});
