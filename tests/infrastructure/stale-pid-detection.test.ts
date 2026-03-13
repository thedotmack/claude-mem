import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import path from 'path';
import {
  writePidFile,
  readPidFile,
  removePidFile,
  isProcessAlive,
  cleanStalePidFile,
  type PidInfo
} from '../../src/services/infrastructure/index.js';
import { isPortInUse } from '../../src/services/infrastructure/HealthMonitor.js';

const DATA_DIR = path.join(homedir(), '.claude-mem');
const PID_FILE = path.join(DATA_DIR, 'worker.pid');

/**
 * Tests for stale PID file detection with health check validation (#1231).
 *
 * Problem: After a worker crash/OOM kill, the PID file persists. If the OS
 * reuses that PID for an unrelated process, isProcessAlive() returns true
 * and the system incorrectly believes the worker is still running.
 *
 * Fix: Both ensureWorkerStarted() and the daemon startup guard now validate
 * PID liveness AND health check. If PID is alive but health check fails,
 * the PID file is treated as stale and removed.
 */
describe('Stale PID Detection with Health Check (#1231)', () => {
  let originalPidContent: string | null = null;
  const originalFetch = global.fetch;

  beforeEach(() => {
    if (existsSync(PID_FILE)) {
      originalPidContent = readFileSync(PID_FILE, 'utf-8');
    }
  });

  afterEach(() => {
    global.fetch = originalFetch;
    if (originalPidContent !== null) {
      writeFileSync(PID_FILE, originalPidContent);
      originalPidContent = null;
    } else {
      removePidFile();
    }
  });

  describe('PID reuse detection pattern', () => {
    it('should detect PID reuse: PID alive but health check fails', async () => {
      // Simulate: worker crashed, OS reused PID for Chrome/etc
      const reusedPidInfo: PidInfo = {
        pid: process.pid,  // Current process is alive but NOT a worker
        port: 39876,       // Port where no worker is listening
        startedAt: '2024-01-01T00:00:00.000Z'
      };
      writePidFile(reusedPidInfo);

      // PID is alive (it's us)
      expect(isProcessAlive(reusedPidInfo.pid)).toBe(true);

      // But health check fails (no worker on that port)
      global.fetch = mock(() => Promise.reject(new Error('ECONNREFUSED')));
      const isHealthy = await isPortInUse(reusedPidInfo.port);
      expect(isHealthy).toBe(false);

      // Combined check: PID alive + health fails = stale PID (reuse detected)
      // This is the pattern used by both daemon guard and ensureWorkerStarted
      const pidInfo = readPidFile();
      expect(pidInfo).not.toBeNull();
      if (pidInfo && isProcessAlive(pidInfo.pid) && !(await isPortInUse(pidInfo.port))) {
        removePidFile();
      }

      expect(existsSync(PID_FILE)).toBe(false);
    });

    it('should keep PID file when both PID alive AND health check pass', async () => {
      const validPidInfo: PidInfo = {
        pid: process.pid,
        port: 37777,
        startedAt: new Date().toISOString()
      };
      writePidFile(validPidInfo);

      // PID alive
      expect(isProcessAlive(validPidInfo.pid)).toBe(true);

      // Health check passes (mock a healthy worker)
      global.fetch = mock(() => Promise.resolve({ ok: true } as Response));
      const isHealthy = await isPortInUse(validPidInfo.port);
      expect(isHealthy).toBe(true);

      // Combined: PID alive + health OK = valid worker, keep PID file
      const pidInfo = readPidFile();
      if (pidInfo && isProcessAlive(pidInfo.pid) && !(await isPortInUse(pidInfo.port))) {
        removePidFile();
      }

      // PID file should still be there
      expect(existsSync(PID_FILE)).toBe(true);
    });

    it('should remove PID file when process is dead (original cleanStalePidFile behavior)', () => {
      const deadPidInfo: PidInfo = {
        pid: 2147483647,  // Very unlikely to be alive
        port: 37777,
        startedAt: '2024-01-01T00:00:00.000Z'
      };
      writePidFile(deadPidInfo);

      // Original cleanStalePidFile handles dead PIDs
      cleanStalePidFile();

      expect(existsSync(PID_FILE)).toBe(false);
    });
  });

  describe('cleanStalePidFile limitations (why health check is needed)', () => {
    it('cleanStalePidFile does NOT detect PID reuse — it only checks liveness', () => {
      // This test documents WHY the fix in worker-service.ts is needed:
      // cleanStalePidFile only checks isProcessAlive, so it can't detect
      // when a PID has been reused by a different process.
      const reusedPidInfo: PidInfo = {
        pid: process.pid,  // Alive but NOT a worker
        port: 39876,
        startedAt: '2024-01-01T00:00:00.000Z'
      };
      writePidFile(reusedPidInfo);

      cleanStalePidFile();

      // PID file is NOT removed because process.pid is alive
      // This is the bug that #1231 addresses — the daemon guard and
      // ensureWorkerStarted now do an additional health check.
      expect(existsSync(PID_FILE)).toBe(true);
    });
  });

  describe('health check as PID ownership validator', () => {
    it('isPortInUse returns false for port with no listener', async () => {
      global.fetch = mock(() => Promise.reject(new Error('ECONNREFUSED')));

      const result = await isPortInUse(39876);
      expect(result).toBe(false);
    });

    it('isPortInUse returns true for port with healthy worker', async () => {
      global.fetch = mock(() => Promise.resolve({ ok: true } as Response));

      const result = await isPortInUse(37777);
      expect(result).toBe(true);
    });

    it('isPortInUse returns false for port returning 503', async () => {
      global.fetch = mock(() => Promise.resolve({ ok: false, status: 503 } as Response));

      const result = await isPortInUse(37777);
      expect(result).toBe(false);
    });
  });
});
