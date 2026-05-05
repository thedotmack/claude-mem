import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import path from 'path';
import http from 'http';
import {
  performGracefulShutdown,
  writePidFile,
  readPidFile,
  removePidFile,
  type GracefulShutdownConfig,
  type ShutdownableService,
  type CloseableClient,
  type CloseableDatabase,
  type PidInfo
} from '../../src/services/infrastructure/index.js';

const DATA_DIR = path.join(homedir(), '.claude-mem');
const PID_FILE = path.join(DATA_DIR, 'worker.pid');

describe('GracefulShutdown', () => {
  let originalPidContent: string | null = null;
  const originalPlatform = process.platform;

  beforeEach(() => {
    if (existsSync(PID_FILE)) {
      originalPidContent = readFileSync(PID_FILE, 'utf-8');
    }

    Object.defineProperty(process, 'platform', {
      value: 'darwin',
      writable: true,
      configurable: true
    });
  });

  afterEach(() => {
    if (originalPidContent !== null) {
      const { writeFileSync } = require('fs');
      writeFileSync(PID_FILE, originalPidContent);
      originalPidContent = null;
    } else {
      removePidFile();
    }

    Object.defineProperty(process, 'platform', {
      value: originalPlatform,
      writable: true,
      configurable: true
    });
  });

  describe('performGracefulShutdown', () => {
    // Timeout bumped to 15s. performGracefulShutdown calls
    // getSupervisor().stop() which runs runShutdownCascade against the real
    // ~/.claude-mem/supervisor.json registry. If the developer has a live
    // worker + chroma-mcp registered, the cascade SIGTERMs/SIGKILLs them
    // and waits up to ~5–6s for them to exit, which sails past the default
    // 5000ms test timeout. The other shutdown tests below are unaffected
    // because they don't register an mcpClient/dbManager/chromaMcpManager
    // mock that exercises the same path. This is test-infrastructure debt
    // — the test interacts with the production supervisor singleton — not
    // a code regression in the shutdown flow itself.
    it('should call shutdown steps in correct order', async () => {
      const callOrder: string[] = [];

      const mockServer = {
        closeAllConnections: mock(() => {
          callOrder.push('closeAllConnections');
        }),
        close: mock((cb: (err?: Error) => void) => {
          callOrder.push('serverClose');
          cb();
        })
      } as unknown as http.Server;

      const mockSessionManager: ShutdownableService = {
        shutdownAll: mock(async () => {
          callOrder.push('sessionManager.shutdownAll');
        })
      };

      const mockMcpClient: CloseableClient = {
        close: mock(async () => {
          callOrder.push('mcpClient.close');
        })
      };

      const mockDbManager: CloseableDatabase = {
        close: mock(async () => {
          callOrder.push('dbManager.close');
        })
      };

      const mockChromaMcpManager = {
        stop: mock(async () => {
          callOrder.push('chromaMcpManager.stop');
        })
      };

      writePidFile({ pid: 12345, port: 37777, startedAt: new Date().toISOString() });
      expect(existsSync(PID_FILE)).toBe(true);

      const config: GracefulShutdownConfig = {
        server: mockServer,
        sessionManager: mockSessionManager,
        mcpClient: mockMcpClient,
        dbManager: mockDbManager,
        chromaMcpManager: mockChromaMcpManager
      };

      await performGracefulShutdown(config);

      expect(callOrder).toContain('closeAllConnections');
      expect(callOrder).toContain('serverClose');
      expect(callOrder).toContain('sessionManager.shutdownAll');
      expect(callOrder).toContain('mcpClient.close');
      expect(callOrder).toContain('chromaMcpManager.stop');
      expect(callOrder).toContain('dbManager.close');

      expect(callOrder.indexOf('serverClose')).toBeLessThan(callOrder.indexOf('sessionManager.shutdownAll'));

      expect(callOrder.indexOf('sessionManager.shutdownAll')).toBeLessThan(callOrder.indexOf('mcpClient.close'));

      expect(callOrder.indexOf('mcpClient.close')).toBeLessThan(callOrder.indexOf('dbManager.close'));

      expect(callOrder.indexOf('chromaMcpManager.stop')).toBeLessThan(callOrder.indexOf('dbManager.close'));
    }, 15000);

    it('should remove PID file during shutdown', async () => {
      const mockSessionManager: ShutdownableService = {
        shutdownAll: mock(async () => {})
      };

      writePidFile({ pid: 99999, port: 37777, startedAt: new Date().toISOString() });
      expect(existsSync(PID_FILE)).toBe(true);

      const config: GracefulShutdownConfig = {
        server: null,
        sessionManager: mockSessionManager
      };

      await performGracefulShutdown(config);

      expect(existsSync(PID_FILE)).toBe(false);
    });

    it('should handle missing optional services gracefully', async () => {
      const mockSessionManager: ShutdownableService = {
        shutdownAll: mock(async () => {})
      };

      const config: GracefulShutdownConfig = {
        server: null,
        sessionManager: mockSessionManager
        // mcpClient and dbManager are undefined
      };

      await expect(performGracefulShutdown(config)).resolves.toBeUndefined();

      expect(mockSessionManager.shutdownAll).toHaveBeenCalled();
    });

    it('should handle null server gracefully', async () => {
      const mockSessionManager: ShutdownableService = {
        shutdownAll: mock(async () => {})
      };

      const config: GracefulShutdownConfig = {
        server: null,
        sessionManager: mockSessionManager
      };

      await expect(performGracefulShutdown(config)).resolves.toBeUndefined();
    });

    it('should call sessionManager.shutdownAll even without server', async () => {
      const mockSessionManager: ShutdownableService = {
        shutdownAll: mock(async () => {})
      };

      const config: GracefulShutdownConfig = {
        server: null,
        sessionManager: mockSessionManager
      };

      await performGracefulShutdown(config);

      expect(mockSessionManager.shutdownAll).toHaveBeenCalledTimes(1);
    });

    it('should stop chroma server before database close', async () => {
      const callOrder: string[] = [];

      const mockSessionManager: ShutdownableService = {
        shutdownAll: mock(async () => {
          callOrder.push('sessionManager');
        })
      };

      const mockMcpClient: CloseableClient = {
        close: mock(async () => {
          callOrder.push('mcpClient');
        })
      };

      const mockDbManager: CloseableDatabase = {
        close: mock(async () => {
          callOrder.push('dbManager');
        })
      };

      const mockChromaMcpManager = {
        stop: mock(async () => {
          callOrder.push('chromaMcpManager');
        })
      };

      const config: GracefulShutdownConfig = {
        server: null,
        sessionManager: mockSessionManager,
        mcpClient: mockMcpClient,
        dbManager: mockDbManager,
        chromaMcpManager: mockChromaMcpManager
      };

      await performGracefulShutdown(config);

      expect(callOrder).toEqual(['sessionManager', 'mcpClient', 'chromaMcpManager', 'dbManager']);
    });

    it('should handle shutdown when PID file does not exist', async () => {
      removePidFile();
      expect(existsSync(PID_FILE)).toBe(false);

      const mockSessionManager: ShutdownableService = {
        shutdownAll: mock(async () => {})
      };

      const config: GracefulShutdownConfig = {
        server: null,
        sessionManager: mockSessionManager
      };

      await expect(performGracefulShutdown(config)).resolves.toBeUndefined();
    });
  });
});
