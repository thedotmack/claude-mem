import { describe, it, expect, beforeEach, afterEach, afterAll, mock, spyOn } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'fs';
import { homedir, tmpdir } from 'os';
import path from 'path';
import http from 'http';
import type {
  GracefulShutdownConfig,
  ShutdownableService,
  CloseableClient,
  CloseableDatabase,
  PidInfo
} from '../../src/services/infrastructure/index.js';

// ── Data-dir isolation (Phase 6, worker-restart plan) ──────────────────────
// performGracefulShutdown writes/deletes the worker PID file and runs the
// supervisor shutdown cascade against paths.supervisorRegistry() — both of
// which must resolve into a temp dir, never the real ~/.claude-mem. paths.ts
// freezes DATA_DIR at first evaluation (env wins), and ESM hoists static
// imports above any env assignment, so the env var is set FIRST and the code
// under test is loaded with dynamic imports below. (`import type` above is
// erased at compile time and loads nothing.)
const TEST_DATA_DIR = mkdtempSync(path.join(tmpdir(), 'claude-mem-shutdown-test-'));
const PREVIOUS_DATA_DIR = process.env.CLAUDE_MEM_DATA_DIR;
process.env.CLAUDE_MEM_DATA_DIR = TEST_DATA_DIR;

const {
  performGracefulShutdown,
  writePidFile,
  readPidFile,
  removePidFile,
} = await import('../../src/services/infrastructure/index.js');
const { paths } = await import('../../src/shared/paths.js');

// If an earlier test file already evaluated paths.ts, the module cache wins
// and DATA_DIR stays frozen on that earlier value — the preload tripwire's
// per-run temp dir (tests/preload.ts), never the real ~/.claude-mem. Derive
// the asserted paths from the SAME frozen module the code under test uses.
const DATA_DIR = paths.dataDir();
const PID_FILE = paths.workerPid();

describe('GracefulShutdown', () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    mkdirSync(DATA_DIR, { recursive: true });
    removePidFile();

    Object.defineProperty(process, 'platform', {
      value: 'darwin',
      writable: true,
      configurable: true
    });
  });

  afterEach(() => {
    removePidFile();

    Object.defineProperty(process, 'platform', {
      value: originalPlatform,
      writable: true,
      configurable: true
    });
  });

  afterAll(() => {
    if (PREVIOUS_DATA_DIR === undefined) {
      delete process.env.CLAUDE_MEM_DATA_DIR;
    } else {
      process.env.CLAUDE_MEM_DATA_DIR = PREVIOUS_DATA_DIR;
    }
    if (DATA_DIR === TEST_DATA_DIR) {
      // paths.ts froze on our per-file dir (this file evaluated it first):
      // empty it but keep the directory alive so later-loaded modules in this
      // process don't point at a deleted path.
      rmSync(TEST_DATA_DIR, { recursive: true, force: true });
      mkdirSync(TEST_DATA_DIR, { recursive: true });
    } else {
      rmSync(TEST_DATA_DIR, { recursive: true, force: true });
    }
  });

  it('resolves the PID file and supervisor registry into a temp dir, never the real ~/.claude-mem', () => {
    const realDataDir = path.join(homedir(), '.claude-mem');
    expect(DATA_DIR).not.toBe(realDataDir);
    expect(PID_FILE.startsWith(realDataDir + path.sep)).toBe(false);
    expect(paths.supervisorRegistry().startsWith(realDataDir + path.sep)).toBe(false);
  });

  describe('performGracefulShutdown', () => {
    // Timeout kept at 15s as headroom. performGracefulShutdown calls
    // getSupervisor().stop() which runs runShutdownCascade against
    // paths.supervisorRegistry() — since the Phase 6 data-dir isolation
    // above, that registry resolves into a temp dir (empty), so the cascade
    // no longer SIGTERMs the developer's real worker/chroma-mcp or waits on
    // their exit. The historic 5s overrun came from the test exercising the
    // REAL ~/.claude-mem/supervisor.json before isolation.
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

    it('should remove its OWN PID file during shutdown (owner guard)', async () => {
      const mockSessionManager: ShutdownableService = {
        shutdownAll: mock(async () => {})
      };

      // Phase 5 (worker-restart plan): the shutdown cascade deletes the PID
      // file only when this process owns it (recorded pid === process.pid).
      writePidFile({ pid: process.pid, port: 37777, startedAt: new Date().toISOString() });
      expect(existsSync(PID_FILE)).toBe(true);

      const config: GracefulShutdownConfig = {
        server: null,
        sessionManager: mockSessionManager
      };

      await performGracefulShutdown(config);

      expect(existsSync(PID_FILE)).toBe(false);
    });

    it('should spare another process\'s PID file during shutdown (restart successor)', async () => {
      const mockSessionManager: ShutdownableService = {
        shutdownAll: mock(async () => {})
      };

      // A restart successor has already written its own PID file by the time
      // the dying worker's cascade runs — the dying worker must not clobber
      // it (Phase 5, worker-restart plan).
      writePidFile({ pid: 99999, port: 37777, startedAt: new Date().toISOString() });
      expect(existsSync(PID_FILE)).toBe(true);

      const config: GracefulShutdownConfig = {
        server: null,
        sessionManager: mockSessionManager
      };

      await performGracefulShutdown(config);

      expect(existsSync(PID_FILE)).toBe(true);
      expect(readPidFile()!.pid).toBe(99999);
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
