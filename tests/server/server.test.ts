import { describe, it, expect, mock, beforeEach, afterEach, spyOn } from 'bun:test';
import { logger } from '../../src/utils/logger.js';

import { Server } from '../../src/services/server/Server.js';
import type { RouteHandler, ServerOptions } from '../../src/services/server/Server.js';
import { listenOnEphemeralPort } from '../helpers/ephemeral-port.js';

let loggerSpies: ReturnType<typeof spyOn>[] = [];

describe('Server', () => {
  let server: Server;
  let mockOptions: ServerOptions;

  beforeEach(() => {
    loggerSpies = [
      spyOn(logger, 'info').mockImplementation(() => {}),
      spyOn(logger, 'debug').mockImplementation(() => {}),
      spyOn(logger, 'warn').mockImplementation(() => {}),
      spyOn(logger, 'error').mockImplementation(() => {}),
    ];

    mockOptions = {
      getInitializationComplete: () => true,
      getMcpReady: () => true,
      onShutdown: mock(() => Promise.resolve()),
      onRestart: mock(() => Promise.resolve()),
      workerPath: '/test/worker-service.cjs',
      getAiStatus: () => ({
        provider: 'claude',
        authMethod: 'cli',
        lastInteraction: null,
      }),
    };
  });

  afterEach(async () => {
    loggerSpies.forEach(spy => spy.mockRestore());
    if (server && server.getHttpServer()) {
      try {
        await server.close();
      } catch {
        // Ignore errors on cleanup
      }
    }
    mock.restore();
  });

  describe('constructor', () => {
    it('should create Express app', () => {
      server = new Server(mockOptions);

      expect(server.app).toBeDefined();
      expect(typeof server.app.get).toBe('function');
      expect(typeof server.app.post).toBe('function');
      expect(typeof server.app.use).toBe('function');
    });

    it('should expose app as readonly property', () => {
      server = new Server(mockOptions);

      expect(server.app).toBeDefined();

      expect(typeof server.app.listen).toBe('function');
    });

    it('should register pre-body-parser routes before normal middleware', async () => {
      server = new Server({
        ...mockOptions,
        preBodyParserRoutes: [{
          setupRoutes(app) {
            app.post('/api/auth/*splat', (req, res) => {
              res.json({
                bodyParsed: req.body !== undefined,
              });
            });
          },
        }],
      });

      const testPort = await listenOnEphemeralPort(server);

      const response = await fetch(`http://127.0.0.1:${testPort}/api/auth/session`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'http://localhost:37777',
        },
        body: JSON.stringify({ ok: true }),
      });

      expect(response.status).toBe(200);
      expect(response.headers.get('access-control-allow-origin')).toBe('http://localhost:37777');

      const body = await response.json();
      expect(body.bodyParsed).toBe(false);
    });
  });

  describe('listen', () => {
    it('should start server on specified port', async () => {
      server = new Server(mockOptions);

      await listenOnEphemeralPort(server);

      const httpServer = server.getHttpServer();
      expect(httpServer).not.toBeNull();
      expect(httpServer!.listening).toBe(true);
    });

    it('should reject if port is already in use', async () => {
      server = new Server(mockOptions);
      const server2 = new Server(mockOptions);

      const testPort = await listenOnEphemeralPort(server);

      await expect(server2.listen(testPort, '127.0.0.1')).rejects.toThrow();

      // #3380 — a failed bind must never leave a non-listening handle behind
      // for graceful shutdown to trip on.
      expect(server2.getHttpServer()).toBeNull();
    });
  });

  describe('close', () => {
    it('should stop server from listening after close', async () => {
      server = new Server(mockOptions);
      await listenOnEphemeralPort(server);

      const httpServerBefore = server.getHttpServer();
      expect(httpServerBefore).not.toBeNull();
      expect(httpServerBefore!.listening).toBe(true);

      try {
        await server.close();
      } catch (e: any) {
        if (e.code !== 'ERR_SERVER_NOT_RUNNING') {
          throw e;
        }
      }

      const httpServerAfter = server.getHttpServer();
      if (httpServerAfter) {
        expect(httpServerAfter.listening).toBe(false);
      }
    });

    it('should handle close when server not started', async () => {
      server = new Server(mockOptions);

      await expect(server.close()).resolves.toBeUndefined();
    });

    it('should allow starting a new server on same port after close', async () => {
      server = new Server(mockOptions);
      const testPort = await listenOnEphemeralPort(server);

      try {
        await server.close();
      } catch (e: any) {
        if (e.code !== 'ERR_SERVER_NOT_RUNNING') {
          throw e;
        }
      }

      await new Promise(resolve => setTimeout(resolve, 100));

      const server2 = new Server(mockOptions);
      await server2.listen(testPort, '127.0.0.1');

      expect(server2.getHttpServer()!.listening).toBe(true);

      try {
        await server2.close();
      } catch {
        // Ignore cleanup errors
      }
    });
  });

  describe('getHttpServer', () => {
    it('should return null before listen', () => {
      server = new Server(mockOptions);

      expect(server.getHttpServer()).toBeNull();
    });

    it('should return http.Server after listen', async () => {
      server = new Server(mockOptions);
      await listenOnEphemeralPort(server);

      const httpServer = server.getHttpServer();
      expect(httpServer).not.toBeNull();
      expect(httpServer!.listening).toBe(true);
    });
  });

  describe('registerRoutes', () => {
    it('should call setupRoutes on route handler', () => {
      server = new Server(mockOptions);

      const setupRoutesMock = mock(() => {});
      const mockRouteHandler: RouteHandler = {
        setupRoutes: setupRoutesMock,
      };

      server.registerRoutes(mockRouteHandler);

      expect(setupRoutesMock).toHaveBeenCalledTimes(1);
      expect(setupRoutesMock).toHaveBeenCalledWith(server.app);
    });

    it('should register multiple route handlers', () => {
      server = new Server(mockOptions);

      const handler1Mock = mock(() => {});
      const handler2Mock = mock(() => {});

      const handler1: RouteHandler = { setupRoutes: handler1Mock };
      const handler2: RouteHandler = { setupRoutes: handler2Mock };

      server.registerRoutes(handler1);
      server.registerRoutes(handler2);

      expect(handler1Mock).toHaveBeenCalledTimes(1);
      expect(handler2Mock).toHaveBeenCalledTimes(1);
    });
  });

  describe('finalizeRoutes', () => {
    it('should not throw when called', () => {
      server = new Server(mockOptions);

      expect(() => server.finalizeRoutes()).not.toThrow();
    });
  });

  describe('health endpoint', () => {
    it('should return 200 with status ok', async () => {
      server = new Server(mockOptions);
      const testPort = await listenOnEphemeralPort(server);

      const response = await fetch(`http://127.0.0.1:${testPort}/api/health`);

      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body.status).toBe('ok');
    });

    it('should include initialization status', async () => {
      server = new Server(mockOptions);
      const testPort = await listenOnEphemeralPort(server);

      const response = await fetch(`http://127.0.0.1:${testPort}/api/health`);
      const body = await response.json();

      expect(body.initialized).toBe(true);
      expect(body.mcpReady).toBe(true);
    });

    it('should reflect initialization state changes', async () => {
      let isInitialized = false;
      const dynamicOptions: ServerOptions = {
        getInitializationComplete: () => isInitialized,
        getMcpReady: () => true,
        onShutdown: mock(() => Promise.resolve()),
        onRestart: mock(() => Promise.resolve()),
        workerPath: '/test/worker-service.cjs',
        getAiStatus: () => ({ provider: 'claude', authMethod: 'cli', lastInteraction: null }),
      };

      server = new Server(dynamicOptions);
      const testPort = await listenOnEphemeralPort(server);

      let response = await fetch(`http://127.0.0.1:${testPort}/api/health`);
      let body = await response.json();
      expect(body.initialized).toBe(false);

      isInitialized = true;

      response = await fetch(`http://127.0.0.1:${testPort}/api/health`);
      body = await response.json();
      expect(body.initialized).toBe(true);
    });

    it('should include platform and pid', async () => {
      server = new Server(mockOptions);
      const testPort = await listenOnEphemeralPort(server);

      const response = await fetch(`http://127.0.0.1:${testPort}/api/health`);
      const body = await response.json();

      expect(body.platform).toBeDefined();
      expect(body.pid).toBeDefined();
      expect(typeof body.pid).toBe('number');
    });

    it('should return degraded health when BullMQ Redis health is errored', async () => {
      server = new Server({
        ...mockOptions,
        getQueueHealth: () => ({
          engine: 'bullmq',
          redis: {
            status: 'error',
            mode: 'external',
            host: '127.0.0.1',
            port: 6379,
            prefix: 'test_prefix',
            error: 'connection refused',
          },
        }),
      });
      const testPort = await listenOnEphemeralPort(server);

      const response = await fetch(`http://127.0.0.1:${testPort}/api/health`);
      const body = await response.json();

      expect(response.status).toBe(503);
      expect(body.status).toBe('degraded');
      expect(body.queue.redis.status).toBe('error');
    });
  });

  describe('readiness endpoint', () => {
    it('should return 200 when initialized', async () => {
      server = new Server(mockOptions);
      const testPort = await listenOnEphemeralPort(server);

      const response = await fetch(`http://127.0.0.1:${testPort}/api/readiness`);

      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body.status).toBe('ready');
    });

    it('should return 503 when not initialized', async () => {
      const uninitializedOptions: ServerOptions = {
        getInitializationComplete: () => false,
        getMcpReady: () => false,
        onShutdown: mock(() => Promise.resolve()),
        onRestart: mock(() => Promise.resolve()),
        workerPath: '/test/worker-service.cjs',
        getAiStatus: () => ({ provider: 'claude', authMethod: 'cli', lastInteraction: null }),
      };

      server = new Server(uninitializedOptions);
      const testPort = await listenOnEphemeralPort(server);

      const response = await fetch(`http://127.0.0.1:${testPort}/api/readiness`);

      expect(response.status).toBe(503);

      const body = await response.json();
      expect(body.status).toBe('initializing');
      expect(body.message).toBeDefined();
    });
  });

  describe('version endpoint', () => {
    it('should return 200 with version', async () => {
      server = new Server(mockOptions);
      const testPort = await listenOnEphemeralPort(server);

      const response = await fetch(`http://127.0.0.1:${testPort}/api/version`);

      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body.version).toBeDefined();
      expect(typeof body.version).toBe('string');
    });
  });

  describe('404 handling', () => {
    it('should return 404 for unknown routes after finalizeRoutes', async () => {
      server = new Server(mockOptions);
      server.finalizeRoutes();

      const testPort = await listenOnEphemeralPort(server);

      const response = await fetch(`http://127.0.0.1:${testPort}/api/nonexistent`);

      expect(response.status).toBe(404);

      const body = await response.json();
      expect(body.error).toBe('NotFound');
    });
  });

  describe('request activity (idle exit)', () => {
    const until = async (condition: () => boolean): Promise<void> => {
      const deadline = Date.now() + 5_000;
      while (!condition() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    };

    it('counts an open request until its response finishes, and settles it exactly once', async () => {
      server = new Server(mockOptions);
      let finishHeldRequest!: () => void;
      const heldRequestMayFinish = new Promise<void>(resolve => { finishHeldRequest = resolve; });
      server.registerRoutes({
        setupRoutes(app) {
          app.get('/test/held', async (_req, res) => {
            res.write('started;');
            await heldRequestMayFinish;
            res.end('done');
          });
        },
      });
      const testPort = await listenOnEphemeralPort(server);
      expect(server.getInFlightRequestCount()).toBe(0);
      expect(server.getLastRequestAt()).toBeNull();

      const response = await fetch(`http://127.0.0.1:${testPort}/test/held`);
      expect(server.getInFlightRequestCount()).toBe(1);
      const startedAt = server.getLastRequestAt();
      expect(startedAt).not.toBeNull();

      finishHeldRequest();
      expect(await response.text()).toBe('started;done');
      await until(() => server.getInFlightRequestCount() === 0);
      // 'finish', then 'close', then the socket's 'close' may all follow: one decrement, never below 0.
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(server.getInFlightRequestCount()).toBe(0);
      expect(server.getLastRequestAt()!).toBeGreaterThanOrEqual(startedAt!);
    });

    it('settles a streaming request when its client disconnects, like a closed viewer tab', async () => {
      server = new Server(mockOptions);
      server.registerRoutes({
        setupRoutes(app) {
          app.get('/test/stream', (_req, res) => {
            res.setHeader('Content-Type', 'text/event-stream');
            res.flushHeaders();
            res.write(': ping\n\n'); // never ends, like the viewer's /stream
          });
        },
      });
      const testPort = await listenOnEphemeralPort(server);
      const controller = new AbortController();
      const response = await fetch(`http://127.0.0.1:${testPort}/test/stream`, { signal: controller.signal });
      expect(response.status).toBe(200);
      expect(server.getInFlightRequestCount()).toBe(1);

      controller.abort();
      await until(() => server.getInFlightRequestCount() === 0);
      expect(server.getInFlightRequestCount()).toBe(0);
    });

    it('settles every request on a reused keep-alive connection', async () => {
      server = new Server(mockOptions);
      const testPort = await listenOnEphemeralPort(server);
      for (let request = 0; request < 3; request++) {
        const response = await fetch(`http://127.0.0.1:${testPort}/api/health`);
        expect(response.status).toBe(200);
        await response.text();
      }
      await until(() => server.getInFlightRequestCount() === 0);
      expect(server.getInFlightRequestCount()).toBe(0);
      expect(server.getLastRequestAt()).not.toBeNull();
    });
  });
});
