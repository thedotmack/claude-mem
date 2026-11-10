import { describe, it, expect, beforeEach, afterEach, afterAll, mock, spyOn } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import http from 'http';
import type {
  GracefulShutdownConfig,
  ShutdownableService,
  CloseableClient,
  CloseableDatabase,
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
const { getSupervisor } = await import('../../src/supervisor/index.js');

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

      const mockContextReader: CloseableClient = {
        close: mock(async () => { callOrder.push('contextReader.close'); })
      };

      writePidFile({ pid: 12345, port: 37777, startedAt: new Date().toISOString() });
      expect(existsSync(PID_FILE)).toBe(true);

      const config: GracefulShutdownConfig = {
        server: mockServer,
        sessionManager: mockSessionManager,
        mcpClient: mockMcpClient,
        dbManager: mockDbManager,
        contextReader: mockContextReader,
        chromaMcpManager: mockChromaMcpManager
      };

      await performGracefulShutdown(config);

      expect(callOrder).toEqual([
        'closeAllConnections',
        'serverClose',
        'sessionManager.shutdownAll',
        'mcpClient.close',
        'chromaMcpManager.stop',
        'contextReader.close',
        'dbManager.close',
      ]);
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

      expect(mockSessionManager.shutdownAll).toHaveBeenCalledTimes(1);
    });

    it('resolves on ERR_SERVER_NOT_RUNNING from server.close and still runs every remaining step (#3380)', async () => {
      // Node's http.Server.close(cb) reports ERR_SERVER_NOT_RUNNING when the
      // handle is not listening. An already-closed server is the desired end
      // state — teardown (session drain, MCP close, chroma stop, db close,
      // supervisor stop) must still run.
      const mockServer = {
        closeAllConnections: mock(() => {}),
        close: mock((cb: (err?: Error) => void) => {
          cb(Object.assign(new Error('Server is not running.'), { code: 'ERR_SERVER_NOT_RUNNING' }));
        })
      } as unknown as http.Server;

      const mockSessionManager: ShutdownableService = {
        shutdownAll: mock(async () => {})
      };
      const mockMcpClient: CloseableClient = {
        close: mock(async () => {})
      };
      const mockDbManager: CloseableDatabase = {
        close: mock(async () => {})
      };
      const mockChromaMcpManager = {
        stop: mock(async () => {})
      };

      // Same module instance performGracefulShutdown uses — the spy calls
      // through to the real (no-op against the temp registry) cascade.
      const supervisorStopSpy = spyOn(getSupervisor(), 'stop');

      try {
        const config: GracefulShutdownConfig = {
          server: mockServer,
          sessionManager: mockSessionManager,
          mcpClient: mockMcpClient,
          dbManager: mockDbManager,
          chromaMcpManager: mockChromaMcpManager
        };

        await expect(performGracefulShutdown(config)).resolves.toBeUndefined();

        expect(mockSessionManager.shutdownAll).toHaveBeenCalledTimes(1);
        expect(mockMcpClient.close).toHaveBeenCalledTimes(1);
        expect(mockChromaMcpManager.stop).toHaveBeenCalledTimes(1);
        expect(mockDbManager.close).toHaveBeenCalledTimes(1);
        expect(supervisorStopSpy).toHaveBeenCalledTimes(1);
      } finally {
        supervisorStopSpy.mockRestore();
      }
    }, 15000);

    it('still rejects when server.close reports any other error code', async () => {
      const mockServer = {
        closeAllConnections: mock(() => {}),
        close: mock((cb: (err?: Error) => void) => {
          cb(Object.assign(new Error('bad handle'), { code: 'EBADF' }));
        })
      } as unknown as http.Server;

      const mockSessionManager: ShutdownableService = {
        shutdownAll: mock(async () => {})
      };
      const mockDbManager: CloseableDatabase = {
        close: mock(async () => {})
      };

      const config: GracefulShutdownConfig = {
        server: mockServer,
        sessionManager: mockSessionManager,
        dbManager: mockDbManager
      };

      await expect(performGracefulShutdown(config)).rejects.toThrow('bad handle');

      // Only ERR_SERVER_NOT_RUNNING is tolerated — anything else keeps the
      // existing fail-fast propagation.
      expect(mockSessionManager.shutdownAll).not.toHaveBeenCalled();
      expect(mockDbManager.close).not.toHaveBeenCalled();
    });
  });
});
