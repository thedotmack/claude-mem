import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { logger } from '../../src/utils/logger.js';

// Mock middleware to avoid complex dependencies
vi.mock('../../src/services/worker/http/middleware.js', () => ({
  createMiddleware: () => [],
  requireLocalhost: (_req: unknown, _res: unknown, next: () => void) => { next(); },
  summarizeRequestBody: () => 'test body',
}));

// Import after mocks
import { Server } from '../../src/services/server/Server.js';
import type { RouteHandler, ServerOptions } from '../../src/services/server/Server.js';

/** Type for JSON response body from API endpoints */
interface ApiResponseBody {
  status?: string;
  initialized?: boolean;
  mcpReady?: boolean;
  platform?: string;
  pid?: number;
  version?: string;
  message?: string;
  error?: string;
}

// Spy on logger methods to suppress output during tests
import type { MockInstance } from 'vitest';
let loggerSpies: MockInstance[] = [];

describe('Server', () => {
  let server: Server;
  let mockOptions: ServerOptions;

  beforeEach(() => {
    loggerSpies = [
      vi.spyOn(logger, 'info').mockImplementation(() => {}),
      vi.spyOn(logger, 'debug').mockImplementation(() => {}),
      vi.spyOn(logger, 'warn').mockImplementation(() => {}),
      vi.spyOn(logger, 'error').mockImplementation(() => {}),
    ];

    mockOptions = {
      getInitializationComplete: () => true,
      getMcpReady: () => true,
      onShutdown: vi.fn(() => Promise.resolve()),
      onRestart: vi.fn(() => Promise.resolve()),
    };
  });

  afterEach(async () => {
    for (const spy of loggerSpies) spy.mockRestore();
    // Clean up server if created and still has an active http server
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- defensive: server may not be assigned in every test
    if (server && server.getHttpServer()) {
      try {
        await server.close();
      } catch {
        // Ignore errors on cleanup
      }
    }
    vi.restoreAllMocks();
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

      // App should be accessible
      expect(server.app).toBeDefined();

      // App should be an Express application
      expect(typeof server.app.listen).toBe('function');
    });
  });

  describe('listen', () => {
    it('should start server on specified port', async () => {
      server = new Server(mockOptions);

      // Use a random high port to avoid conflicts
      const testPort = 40000 + Math.floor(Math.random() * 10000);

      await server.listen(testPort, '127.0.0.1');

      // Server should now be listening
      const httpServer = server.getHttpServer();
      expect(httpServer).not.toBeNull();
      expect((httpServer as NonNullable<typeof httpServer>).listening).toBe(true);
    });

    it('should reject if port is already in use', async () => {
      server = new Server(mockOptions);
      const server2 = new Server(mockOptions);

      const testPort = 40000 + Math.floor(Math.random() * 10000);

      // Start first server
      await server.listen(testPort, '127.0.0.1');

      // Second server should fail on same port
      await expect(server2.listen(testPort, '127.0.0.1')).rejects.toThrow();

      // The server object was created but not successfully listening
      const httpServer = server2.getHttpServer();
      if (httpServer) {
        expect(httpServer.listening).toBe(false);
      }
    });
  });

  describe('close', () => {
    it('should stop server from listening after close', async () => {
      server = new Server(mockOptions);
      const testPort = 40000 + Math.floor(Math.random() * 10000);

      await server.listen(testPort, '127.0.0.1');

      // Server should exist and be listening
      const httpServerBefore = server.getHttpServer();
      expect(httpServerBefore).not.toBeNull();
      expect((httpServerBefore as NonNullable<typeof httpServerBefore>).listening).toBe(true);

      // Close the server - may throw ERR_SERVER_NOT_RUNNING on some platforms
      // because closeAllConnections() might immediately close the server
      try {
        await server.close();
      } catch (e: unknown) {
        // ERR_SERVER_NOT_RUNNING is acceptable - closeAllConnections() already closed it
        if ((e as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') {
          throw e;
        }
      }

      // The server should no longer be listening (even if ref is not null due to early throw)
      const httpServerAfter = server.getHttpServer();
      if (httpServerAfter) {
        expect(httpServerAfter.listening).toBe(false);
      }
    });

    it('should handle close when server not started', async () => {
      server = new Server(mockOptions);

      // Should not throw when closing unstarted server
      await expect(server.close()).resolves.toBeUndefined();
    });

    it('should allow starting a new server on same port after close', async () => {
      server = new Server(mockOptions);
      const testPort = 40000 + Math.floor(Math.random() * 10000);

      await server.listen(testPort, '127.0.0.1');

      // Close the server
      try {
        await server.close();
      } catch (e: unknown) {
        // ERR_SERVER_NOT_RUNNING is acceptable
        if ((e as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') {
          throw e;
        }
      }

      // Small delay to ensure port is released
      await new Promise(resolve => setTimeout(resolve, 100));

      // Should be able to listen again on same port with a new server
      const server2 = new Server(mockOptions);
      await server2.listen(testPort, '127.0.0.1');

      const httpServer2 = server2.getHttpServer();
      expect(httpServer2).not.toBeNull();
      expect((httpServer2 as NonNullable<typeof httpServer2>).listening).toBe(true);

      // Clean up server2
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
      const testPort = 40000 + Math.floor(Math.random() * 10000);

      await server.listen(testPort, '127.0.0.1');

      const httpServer = server.getHttpServer();
      expect(httpServer).not.toBeNull();
      expect((httpServer as NonNullable<typeof httpServer>).listening).toBe(true);
    });
  });

  describe('registerRoutes', () => {
    it('should call setupRoutes on route handler', () => {
      server = new Server(mockOptions);

      const setupRoutesMock = vi.fn(() => {});
      const mockRouteHandler: RouteHandler = {
        setupRoutes: setupRoutesMock,
      };

      server.registerRoutes(mockRouteHandler);

      expect(setupRoutesMock).toHaveBeenCalledTimes(1);
      expect(setupRoutesMock).toHaveBeenCalledWith(server.app);
    });

    it('should register multiple route handlers', () => {
      server = new Server(mockOptions);

      const handler1Mock = vi.fn(() => {});
      const handler2Mock = vi.fn(() => {});

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

      expect(() => { server.finalizeRoutes(); }).not.toThrow();
    });
  });

  describe('health endpoint', () => {
    it('should return 200 with status ok', async () => {
      server = new Server(mockOptions);
      const testPort = 40000 + Math.floor(Math.random() * 10000);

      await server.listen(testPort, '127.0.0.1');

      const response = await fetch(`http://127.0.0.1:${String(testPort)}/api/health`);

      expect(response.status).toBe(200);

      const body = await response.json() as ApiResponseBody;
      expect(body.status).toBe('ok');
    });

    it('should include initialization status', async () => {
      server = new Server(mockOptions);
      const testPort = 40000 + Math.floor(Math.random() * 10000);

      await server.listen(testPort, '127.0.0.1');

      const response = await fetch(`http://127.0.0.1:${String(testPort)}/api/health`);
      const body = await response.json() as ApiResponseBody;

      expect(body.initialized).toBe(true);
      expect(body.mcpReady).toBe(true);
    });

    it('should reflect initialization state changes', async () => {
      let isInitialized = false;
      const dynamicOptions: ServerOptions = {
        getInitializationComplete: () => isInitialized,
        getMcpReady: () => true,
        onShutdown: vi.fn(() => Promise.resolve()),
        onRestart: vi.fn(() => Promise.resolve()),
      };

      server = new Server(dynamicOptions);
      const testPort = 40000 + Math.floor(Math.random() * 10000);

      await server.listen(testPort, '127.0.0.1');

      // Check when not initialized
      let response = await fetch(`http://127.0.0.1:${String(testPort)}/api/health`);
      let body = await response.json() as ApiResponseBody;
      expect(body.initialized).toBe(false);

      // Change state
      isInitialized = true;

      // Check when initialized
      response = await fetch(`http://127.0.0.1:${String(testPort)}/api/health`);
      body = await response.json() as ApiResponseBody;
      expect(body.initialized).toBe(true);
    });

    it('should include platform and pid', async () => {
      server = new Server(mockOptions);
      const testPort = 40000 + Math.floor(Math.random() * 10000);

      await server.listen(testPort, '127.0.0.1');

      const response = await fetch(`http://127.0.0.1:${String(testPort)}/api/health`);
      const body = await response.json() as ApiResponseBody;

      expect(body.platform).toBeDefined();
      expect(body.pid).toBeDefined();
      expect(typeof body.pid).toBe('number');
    });
  });

  describe('readiness endpoint', () => {
    it('should return 200 when initialized', async () => {
      server = new Server(mockOptions);
      const testPort = 40000 + Math.floor(Math.random() * 10000);

      await server.listen(testPort, '127.0.0.1');

      const response = await fetch(`http://127.0.0.1:${String(testPort)}/api/readiness`);

      expect(response.status).toBe(200);

      const body = await response.json() as ApiResponseBody;
      expect(body.status).toBe('ready');
    });

    it('should return 503 when not initialized', async () => {
      const uninitializedOptions: ServerOptions = {
        getInitializationComplete: () => false,
        getMcpReady: () => false,
        onShutdown: vi.fn(() => Promise.resolve()),
        onRestart: vi.fn(() => Promise.resolve()),
      };

      server = new Server(uninitializedOptions);
      const testPort = 40000 + Math.floor(Math.random() * 10000);

      await server.listen(testPort, '127.0.0.1');

      const response = await fetch(`http://127.0.0.1:${String(testPort)}/api/readiness`);

      expect(response.status).toBe(503);

      const body = await response.json() as ApiResponseBody;
      expect(body.status).toBe('initializing');
      expect(body.message).toBeDefined();
    });
  });

  describe('version endpoint', () => {
    it('should return 200 with version', async () => {
      server = new Server(mockOptions);
      const testPort = 40000 + Math.floor(Math.random() * 10000);

      await server.listen(testPort, '127.0.0.1');

      const response = await fetch(`http://127.0.0.1:${String(testPort)}/api/version`);

      expect(response.status).toBe(200);

      const body = await response.json() as ApiResponseBody;
      expect(body.version).toBeDefined();
      expect(typeof body.version).toBe('string');
    });
  });

  describe('404 handling', () => {
    it('should return 404 for unknown routes after finalizeRoutes', async () => {
      server = new Server(mockOptions);
      server.finalizeRoutes();

      const testPort = 40000 + Math.floor(Math.random() * 10000);
      await server.listen(testPort, '127.0.0.1');

      const response = await fetch(`http://127.0.0.1:${String(testPort)}/api/nonexistent`);

      expect(response.status).toBe(404);

      const body = await response.json() as ApiResponseBody;
      expect(body.error).toBe('NotFound');
    });
  });
});
