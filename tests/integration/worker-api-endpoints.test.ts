
import { describe, it, expect, beforeEach, afterEach, afterAll, spyOn, mock } from 'bun:test';
import { logger } from '../../src/utils/logger.js';

// Capture the real middleware module before mock.module mutates the live
// namespace, then re-register the snapshot in afterAll. bun's mock.module is
// process-global and mock.restore() does NOT undo it, so without this the stub
// createMiddleware leaks into later files (e.g. CORS + v1-routes server tests).
import * as realMiddleware from '../../src/services/worker/http/middleware.js';
const realMiddlewareSnapshot = { ...realMiddleware };

mock.module('../../src/services/worker/http/middleware.js', () => ({
  createMiddleware: () => [],
  requireLocalhost: (_req: any, _res: any, next: any) => next(),
  summarizeRequestBody: () => 'test body',
}));

import { Server } from '../../src/services/server/Server.js';
import type { ServerOptions } from '../../src/services/server/Server.js';
import { WorkerService } from '../../src/services/worker-service.js';
import {
  recordDependencyStatus,
  resetDependencyStatusesForTesting,
} from '../../src/shared/dependency-health.js';
import { listenOnEphemeralPort } from '../helpers/ephemeral-port.js';

let loggerSpies: ReturnType<typeof spyOn>[] = [];
const serialIt = it.serial;

describe('Worker API Endpoints Integration', () => {
  let server: Server;
  let testPort: number;
  let mockOptions: ServerOptions;

  beforeEach(() => {
    resetDependencyStatusesForTesting();
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
      getChromaCrashState: () => ({
        count: 1,
        lastExit: { timestamp: '2026-07-23T12:00:00.000Z', code: null, signal: 'SIGSEGV' },
        chromaMcpVersion: '0.2.6',
        dependencyOverrides: ['onnxruntime>=1.20', 'protobuf<7', 'chromadb==1.5.9'],
        prewarm: { consecutiveFailures: 0, state: 'ok' },
      }),
    };

    testPort = 0;
  });

  afterEach(async () => {
    resetDependencyStatusesForTesting();
    loggerSpies.forEach(spy => spy.mockRestore());

    if (server && server.getHttpServer()) {
      try {
        await server.close();
      } catch {
        // Ignore cleanup errors
      }
    }
    mock.restore();
  });

  afterAll(() => {
    mock.module('../../src/services/worker/http/middleware.js', () => realMiddlewareSnapshot);
  });

  describe('Health/Readiness/Version Endpoints', () => {
    describe('GET /api/health', () => {
      serialIt('should reflect uninitialized state', async () => {
        const uninitOptions: ServerOptions = {
          getInitializationComplete: () => false,
          getMcpReady: () => false,
          onShutdown: mock(() => Promise.resolve()),
          onRestart: mock(() => Promise.resolve()),
          workerPath: '/test/worker-service.cjs',
          getAiStatus: () => ({ provider: 'claude', authMethod: 'cli', lastInteraction: null }),
        };

        server = new Server(uninitOptions);
        testPort = await listenOnEphemeralPort(server);

        const response = await fetch(`http://127.0.0.1:${testPort}/api/health`);
        const body = await response.json();

        expect(body.status).toBe('ok'); 
        expect(body.initialized).toBe(false);
        expect(body.mcpReady).toBe(false);
      });

      serialIt('includes dependency health and stays HTTP 200 for dependency-only degradation', async () => {
        recordDependencyStatus(
          'uvx',
          'vector_search_unavailable',
          'uvx executable not found on effective PATH for vector search',
          'Install uv and restart claude-mem',
        );

        server = new Server(mockOptions);
        testPort = await listenOnEphemeralPort(server);

        const response = await fetch(`http://127.0.0.1:${testPort}/api/health`);
        expect(response.status).toBe(200);

        const body = await response.json();
        expect(body.status).toBe('ok');
        expect(body.dependencies).toMatchObject({
          degraded: true,
          statuses: [
            {
              dependency: 'uvx',
              kind: 'vector_search_unavailable',
              message: 'uvx executable not found on effective PATH for vector search',
              remediation: 'Install uv and restart claude-mem',
            },
          ],
        });
      });
    });

    describe('GET /api/settings/dependency-health', () => {
      serialIt('passes through WorkerService initialization guard while initialization is incomplete', async () => {
        recordDependencyStatus(
          'claude_cli',
          'setup_required',
          'Claude executable not found',
          'Install Claude Code CLI',
        );

        const worker = new WorkerService();
        expect((worker as any).initializationCompleteFlag).toBe(false);
        server = (worker as unknown as { server: Server }).server;
        testPort = await listenOnEphemeralPort(server);

        const guardedResponse = await fetch(`http://127.0.0.1:${testPort}/api/settings`);
        expect(guardedResponse.status).toBe(503);

        const response = await fetch(`http://127.0.0.1:${testPort}/api/settings/dependency-health`);
        expect(response.status).toBe(200);

        const body = await response.json();
        expect(body).toMatchObject({
          degraded: true,
          statuses: [
            {
              dependency: 'claude_cli',
              kind: 'setup_required',
              message: 'Claude executable not found',
              remediation: 'Install Claude Code CLI',
            },
          ],
        });
      });
    });
  });

  describe('Error Handling', () => {
    serialIt('includes dependency health in admin doctor output', async () => {
      recordDependencyStatus(
        'claude_cli',
        'setup_required',
        'Claude executable not found',
        'Install Claude Code CLI',
      );

      server = new Server(mockOptions);
      testPort = await listenOnEphemeralPort(server);

      const response = await fetch(`http://127.0.0.1:${testPort}/api/admin/doctor`);
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body.health.dependencies).toMatchObject({
        degraded: true,
        statuses: [
          {
            dependency: 'claude_cli',
            kind: 'setup_required',
            message: 'Claude executable not found',
            remediation: 'Install Claude Code CLI',
          },
        ],
      });
      expect(body.health.chroma).toEqual({
        count: 1,
        lastExit: { timestamp: '2026-07-23T12:00:00.000Z', code: null, signal: 'SIGSEGV' },
        chromaMcpVersion: '0.2.6',
        dependencyOverrides: ['onnxruntime>=1.20', 'protobuf<7', 'chromadb==1.5.9'],
        prewarm: { consecutiveFailures: 0, state: 'ok' },
      });
    });

    describe('404 Not Found', () => {
      serialIt('should return 404 for unknown POST routes', async () => {
        server = new Server(mockOptions);
        server.finalizeRoutes();
        testPort = await listenOnEphemeralPort(server);

        const response = await fetch(`http://127.0.0.1:${testPort}/api/unknown-endpoint`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ test: 'data' })
        });
        expect(response.status).toBe(404);
      });

      serialIt('should return 404 for nested unknown routes', async () => {
        server = new Server(mockOptions);
        server.finalizeRoutes();
        testPort = await listenOnEphemeralPort(server);

        const response = await fetch(`http://127.0.0.1:${testPort}/api/search/nonexistent/nested`);
        expect(response.status).toBe(404);
      });
    });

    describe('Method handling', () => {
      serialIt('should handle OPTIONS requests', async () => {
        server = new Server(mockOptions);
        testPort = await listenOnEphemeralPort(server);

        const response = await fetch(`http://127.0.0.1:${testPort}/api/health`, {
          method: 'OPTIONS'
        });
        expect([200, 204]).toContain(response.status);
      });
    });
  });

  describe('Content-Type Handling', () => {
    serialIt('should accept application/json content type', async () => {
      server = new Server(mockOptions);
      server.finalizeRoutes();
      testPort = await listenOnEphemeralPort(server);

      const response = await fetch(`http://127.0.0.1:${testPort}/api/nonexistent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'value' })
      });

      expect(response.status).toBe(404);
    });

    serialIt('should return JSON responses with correct content type', async () => {
      server = new Server(mockOptions);
      testPort = await listenOnEphemeralPort(server);

      const response = await fetch(`http://127.0.0.1:${testPort}/api/health`);
      const contentType = response.headers.get('content-type');

      expect(contentType).toContain('application/json');
    });
  });

  describe('Server State Management', () => {
    serialIt('should track initialization state dynamically', async () => {
      let initialized = false;
      const dynamicOptions: ServerOptions = {
        getInitializationComplete: () => initialized,
        getMcpReady: () => true,
        onShutdown: mock(() => Promise.resolve()),
        onRestart: mock(() => Promise.resolve()),
        workerPath: '/test/worker-service.cjs',
        getAiStatus: () => ({ provider: 'claude', authMethod: 'cli', lastInteraction: null }),
      };

      server = new Server(dynamicOptions);
      testPort = await listenOnEphemeralPort(server);

      let response = await fetch(`http://127.0.0.1:${testPort}/api/readiness`);
      expect(response.status).toBe(503);

      initialized = true;

      response = await fetch(`http://127.0.0.1:${testPort}/api/readiness`);
      expect(response.status).toBe(200);
    });

    serialIt('should track MCP ready state dynamically', async () => {
      let mcpReady = false;
      const dynamicOptions: ServerOptions = {
        getInitializationComplete: () => true,
        getMcpReady: () => mcpReady,
        onShutdown: mock(() => Promise.resolve()),
        onRestart: mock(() => Promise.resolve()),
        workerPath: '/test/worker-service.cjs',
        getAiStatus: () => ({ provider: 'claude', authMethod: 'cli', lastInteraction: null }),
      };

      server = new Server(dynamicOptions);
      testPort = await listenOnEphemeralPort(server);

      let response = await fetch(`http://127.0.0.1:${testPort}/api/health`);
      let body = await response.json();
      expect(body.mcpReady).toBe(false);

      mcpReady = true;

      response = await fetch(`http://127.0.0.1:${testPort}/api/health`);
      body = await response.json();
      expect(body.mcpReady).toBe(true);
    });
  });

  describe('Server Lifecycle', () => {
    serialIt('should close gracefully', async () => {
      server = new Server(mockOptions);
      testPort = await listenOnEphemeralPort(server);

      const response = await fetch(`http://127.0.0.1:${testPort}/api/health`);
      expect(response.status).toBe(200);

      try {
        await server.close();
      } catch (e: any) {
        if (e.code !== 'ERR_SERVER_NOT_RUNNING') throw e;
      }

      const httpServer = server.getHttpServer();
      if (httpServer) {
        expect(httpServer.listening).toBe(false);
      }
    });
  });

  describe('Route Registration', () => {
    serialIt('should register route handlers', () => {
      server = new Server(mockOptions);

      const setupRoutesMock = mock(() => {});
      const mockRouteHandler = {
        setupRoutes: setupRoutesMock,
      };

      server.registerRoutes(mockRouteHandler);

      expect(setupRoutesMock).toHaveBeenCalledTimes(1);
      expect(setupRoutesMock).toHaveBeenCalledWith(server.app);
    });

    serialIt('should register multiple route handlers', () => {
      server = new Server(mockOptions);

      const handler1Mock = mock(() => {});
      const handler2Mock = mock(() => {});

      server.registerRoutes({ setupRoutes: handler1Mock });
      server.registerRoutes({ setupRoutes: handler2Mock });

      expect(handler1Mock).toHaveBeenCalledTimes(1);
      expect(handler2Mock).toHaveBeenCalledTimes(1);
    });
  });
});
