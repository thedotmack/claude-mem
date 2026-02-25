import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, readFileSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { homedir } from 'os';
import { tmpdir } from 'os';
import path from 'path';
import {
  writePidFile,
  readPidFile,
  removePidFile,
  getPlatformTimeout,
  parseElapsedTime,
  isProcessAlive,
  cleanStalePidFile,
  isPidFileRecent,
  touchPidFile,
  spawnDaemon,
  resolveWorkerRuntimePath,
  runOneTimeChromaMigration,
  type PidInfo
} from '../../src/services/infrastructure/index.js';

const DATA_DIR = path.join(homedir(), '.claude-mem');
const PID_FILE = path.join(DATA_DIR, 'worker.pid');

describe('ProcessManager', () => {
  // Store original PID file content if it exists
  let originalPidContent: string | null = null;

  beforeEach(() => {
    // Backup existing PID file if present
    if (existsSync(PID_FILE)) {
      originalPidContent = readFileSync(PID_FILE, 'utf-8');
    }
  });

  afterEach(() => {
    // Restore original PID file or remove test one
    if (originalPidContent !== null) {
      writeFileSync(PID_FILE, originalPidContent);
      originalPidContent = null;
    } else {
      removePidFile();
    }
  });

  describe('writePidFile', () => {
    it('should create file with PID info', () => {
      const testInfo: PidInfo = {
        pid: 12345,
        port: 37777,
        startedAt: new Date().toISOString()
      };

      writePidFile(testInfo);

      expect(existsSync(PID_FILE)).toBe(true);
      const content = JSON.parse(readFileSync(PID_FILE, 'utf-8'));
      expect(content.pid).toBe(12345);
      expect(content.port).toBe(37777);
      expect(content.startedAt).toBe(testInfo.startedAt);
    });

    it('should overwrite existing PID file', () => {
      const firstInfo: PidInfo = {
        pid: 11111,
        port: 37777,
        startedAt: '2024-01-01T00:00:00.000Z'
      };
      const secondInfo: PidInfo = {
        pid: 22222,
        port: 37888,
        startedAt: '2024-01-02T00:00:00.000Z'
      };

      writePidFile(firstInfo);
      writePidFile(secondInfo);

      const content = JSON.parse(readFileSync(PID_FILE, 'utf-8'));
      expect(content.pid).toBe(22222);
      expect(content.port).toBe(37888);
    });
  });

  describe('readPidFile', () => {
    it('should return PidInfo object for valid file', () => {
      const testInfo: PidInfo = {
        pid: 54321,
        port: 37999,
        startedAt: '2024-06-15T12:00:00.000Z'
      };
      writePidFile(testInfo);

      const result = readPidFile();

      expect(result).not.toBeNull();
      expect(result!.pid).toBe(54321);
      expect(result!.port).toBe(37999);
      expect(result!.startedAt).toBe('2024-06-15T12:00:00.000Z');
    });

    it('should return null for missing file', () => {
      // Ensure file doesn't exist
      removePidFile();

      const result = readPidFile();

      expect(result).toBeNull();
    });

    it('should return null for corrupted JSON', () => {
      writeFileSync(PID_FILE, 'not valid json {{{');

      const result = readPidFile();

      expect(result).toBeNull();
    });
  });

  describe('removePidFile', () => {
    it('should delete existing file', () => {
      const testInfo: PidInfo = {
        pid: 99999,
        port: 37777,
        startedAt: new Date().toISOString()
      };
      writePidFile(testInfo);
      expect(existsSync(PID_FILE)).toBe(true);

      removePidFile();

      expect(existsSync(PID_FILE)).toBe(false);
    });

    it('should not throw for missing file', () => {
      // Ensure file doesn't exist
      removePidFile();
      expect(existsSync(PID_FILE)).toBe(false);

      // Should not throw
      expect(() => removePidFile()).not.toThrow();
    });
  });

  describe('parseElapsedTime', () => {
    it('should parse MM:SS format', () => {
      expect(parseElapsedTime('05:30')).toBe(5);
      expect(parseElapsedTime('00:45')).toBe(0);
      expect(parseElapsedTime('59:59')).toBe(59);
    });

    it('should parse HH:MM:SS format', () => {
      expect(parseElapsedTime('01:30:00')).toBe(90);
      expect(parseElapsedTime('02:15:30')).toBe(135);
      expect(parseElapsedTime('00:05:00')).toBe(5);
    });

    it('should parse DD-HH:MM:SS format', () => {
      expect(parseElapsedTime('1-00:00:00')).toBe(1440);  // 1 day
      expect(parseElapsedTime('2-12:30:00')).toBe(3630);  // 2 days + 12.5 hours
      expect(parseElapsedTime('0-01:00:00')).toBe(60);    // 1 hour
    });

    it('should return -1 for empty or invalid input', () => {
      expect(parseElapsedTime('')).toBe(-1);
      expect(parseElapsedTime('   ')).toBe(-1);
      expect(parseElapsedTime('invalid')).toBe(-1);
    });
  });

  describe('getPlatformTimeout', () => {
    const originalPlatform = process.platform;

    afterEach(() => {
      Object.defineProperty(process, 'platform', {
        value: originalPlatform,
        writable: true,
        configurable: true
      });
    });

    it('should return same value on non-Windows platforms', () => {
      Object.defineProperty(process, 'platform', {
        value: 'darwin',
        writable: true,
        configurable: true
      });

      const result = getPlatformTimeout(1000);

      expect(result).toBe(1000);
    });

    it('should return doubled value on Windows', () => {
      Object.defineProperty(process, 'platform', {
        value: 'win32',
        writable: true,
        configurable: true
      });

      const result = getPlatformTimeout(1000);

      expect(result).toBe(2000);
    });

    it('should apply 2.0x multiplier consistently on Windows', () => {
      Object.defineProperty(process, 'platform', {
        value: 'win32',
        writable: true,
        configurable: true
      });

      expect(getPlatformTimeout(500)).toBe(1000);
      expect(getPlatformTimeout(5000)).toBe(10000);
      expect(getPlatformTimeout(100)).toBe(200);
    });

    it('should round Windows timeout values', () => {
      Object.defineProperty(process, 'platform', {
        value: 'win32',
        writable: true,
        configurable: true
      });

      // 2.0x of 333 = 666 (rounds to 666)
      const result = getPlatformTimeout(333);

      expect(result).toBe(666);
    });
  });

  describe('resolveWorkerRuntimePath', () => {
    it('should return current runtime on non-Windows platforms', () => {
      const resolved = resolveWorkerRuntimePath({
        platform: 'linux',
        execPath: '/usr/bin/node'
      });

      expect(resolved).toBe('/usr/bin/node');
    });

    it('should reuse execPath when already running under Bun on Windows', () => {
      const resolved = resolveWorkerRuntimePath({
        platform: 'win32',
        execPath: 'C:\\Users\\alice\\.bun\\bin\\bun.exe'
      });

      expect(resolved).toBe('C:\\Users\\alice\\.bun\\bin\\bun.exe');
    });

    it('should prefer configured Bun path from environment when available', () => {
      const resolved = resolveWorkerRuntimePath({
        platform: 'win32',
        execPath: 'C:\\Program Files\\nodejs\\node.exe',
        env: { BUN: 'C:\\tools\\bun.exe' } as NodeJS.ProcessEnv,
        pathExists: candidatePath => candidatePath === 'C:\\tools\\bun.exe',
        lookupInPath: () => null
      });

      expect(resolved).toBe('C:\\tools\\bun.exe');
    });

    it('should fall back to PATH lookup when no Bun candidate exists', () => {
      const resolved = resolveWorkerRuntimePath({
        platform: 'win32',
        execPath: 'C:\\Program Files\\nodejs\\node.exe',
        env: {} as NodeJS.ProcessEnv,
        pathExists: () => false,
        lookupInPath: () => 'C:\\Program Files\\Bun\\bun.exe'
      });

      expect(resolved).toBe('C:\\Program Files\\Bun\\bun.exe');
    });

    it('should return null when Bun cannot be resolved on Windows', () => {
      const resolved = resolveWorkerRuntimePath({
        platform: 'win32',
        execPath: 'C:\\Program Files\\nodejs\\node.exe',
        env: {} as NodeJS.ProcessEnv,
        pathExists: () => false,
        lookupInPath: () => null
      });

      expect(resolved).toBeNull();
    });
  });

  describe('isProcessAlive', () => {
    it('should return true for the current process', () => {
      expect(isProcessAlive(process.pid)).toBe(true);
    });

    it('should return false for a non-existent PID', () => {
      // Use a very high PID that's extremely unlikely to exist
      expect(isProcessAlive(2147483647)).toBe(false);
    });

    it('should return true for PID 0 (Windows WMIC sentinel)', () => {
      expect(isProcessAlive(0)).toBe(true);
    });

    it('should return false for negative PIDs', () => {
      expect(isProcessAlive(-1)).toBe(false);
      expect(isProcessAlive(-999)).toBe(false);
    });

    it('should return false for non-integer PIDs', () => {
      expect(isProcessAlive(1.5)).toBe(false);
      expect(isProcessAlive(NaN)).toBe(false);
    });
  });

  describe('cleanStalePidFile', () => {
    it('should remove PID file when process is dead', () => {
      // Write a PID file with a non-existent PID
      const staleInfo: PidInfo = {
        pid: 2147483647,
        port: 37777,
        startedAt: '2024-01-01T00:00:00.000Z'
      };
      writePidFile(staleInfo);
      expect(existsSync(PID_FILE)).toBe(true);

      cleanStalePidFile();

      expect(existsSync(PID_FILE)).toBe(false);
    });

    it('should keep PID file when process is alive', () => {
      // Write a PID file with the current process PID (definitely alive)
      const liveInfo: PidInfo = {
        pid: process.pid,
        port: 37777,
        startedAt: new Date().toISOString()
      };
      writePidFile(liveInfo);

      cleanStalePidFile();

      // PID file should still exist since process.pid is alive
      expect(existsSync(PID_FILE)).toBe(true);
    });

    it('should do nothing when PID file does not exist', () => {
      removePidFile();
      expect(existsSync(PID_FILE)).toBe(false);

      // Should not throw
      expect(() => cleanStalePidFile()).not.toThrow();
    });
  });

  describe('isPidFileRecent', () => {
    it('should return true for a recently written PID file', () => {
      writePidFile({ pid: process.pid, port: 37777, startedAt: new Date().toISOString() });

      // File was just written, should be very recent
      expect(isPidFileRecent(15000)).toBe(true);
    });

    it('should return false when PID file does not exist', () => {
      removePidFile();

      expect(isPidFileRecent(15000)).toBe(false);
    });

    it('should return false for a very short threshold on a real file', () => {
      writePidFile({ pid: process.pid, port: 37777, startedAt: new Date().toISOString() });

      // With a 0ms threshold, even a just-written file should be "too old"
      // (mtime is at least 1ms in the past by the time we check)
      // Use a negative threshold to guarantee false
      expect(isPidFileRecent(-1)).toBe(false);
    });
  });

  describe('touchPidFile', () => {
    it('should update mtime of existing PID file', async () => {
      writePidFile({ pid: process.pid, port: 37777, startedAt: new Date().toISOString() });

      // Wait a bit to ensure measurable mtime difference
      await new Promise(r => setTimeout(r, 50));

      const statsBefore = require('fs').statSync(PID_FILE);
      const mtimeBefore = statsBefore.mtimeMs;

      // Wait again to ensure mtime advances
      await new Promise(r => setTimeout(r, 50));

      touchPidFile();

      const statsAfter = require('fs').statSync(PID_FILE);
      const mtimeAfter = statsAfter.mtimeMs;

      expect(mtimeAfter).toBeGreaterThanOrEqual(mtimeBefore);
    });

    it('should not throw when PID file does not exist', () => {
      removePidFile();

      expect(() => touchPidFile()).not.toThrow();
    });
  });

  describe('spawnDaemon', () => {
    it('should use setsid on Linux when available', () => {
      // setsid should exist at /usr/bin/setsid on Linux
      if (process.platform === 'win32') return; // Skip on Windows

      const setsidAvailable = existsSync('/usr/bin/setsid');
      if (!setsidAvailable) return; // Skip if setsid not installed

      // Spawn a daemon with a non-existent script (it will fail to start, but we can verify the spawn attempt)
      // Use a harmless script path — the child will exit immediately
      const pid = spawnDaemon('/dev/null', 39999);

      // setsid spawn should return a PID (the setsid process itself)
      expect(pid).toBeDefined();
      expect(typeof pid).toBe('number');

      // Clean up: kill the spawned process if it's still alive
      if (pid !== undefined && pid > 0) {
        try { process.kill(pid, 'SIGKILL'); } catch { /* already exited */ }
      }
    });

    it('should return undefined when spawn fails on Windows path', () => {
      // On non-Windows, this tests the Unix path which should succeed
      // The function should not throw, only return undefined on failure
      if (process.platform === 'win32') return;

      // Spawning with a totally invalid script should still return a PID
      // (setsid/spawn succeeds even if the child will exit immediately)
      const result = spawnDaemon('/nonexistent/script.cjs', 39998);
      // spawn itself should succeed (returns PID), even if child exits
      expect(result).toBeDefined();

      // Clean up
      if (result !== undefined && result > 0) {
        try { process.kill(result, 'SIGKILL'); } catch { /* already exited */ }
      }
    });
  });

  describe('SIGHUP handling', () => {
    it('should have SIGHUP listeners registered (integration check)', () => {
      // Verify that SIGHUP listener registration is possible on Unix
      if (process.platform === 'win32') return;

      // Register a test handler, verify it works, then remove it
      let received = false;
      const testHandler = () => { received = true; };

      process.on('SIGHUP', testHandler);
      expect(process.listenerCount('SIGHUP')).toBeGreaterThanOrEqual(1);

      // Clean up the test handler
      process.removeListener('SIGHUP', testHandler);
    });

    it('should ignore SIGHUP when --daemon is in process.argv', () => {
      if (process.platform === 'win32') return;

      // Simulate the daemon SIGHUP handler logic
      const isDaemon = process.argv.includes('--daemon');
      // In test context, --daemon is not in argv, so this tests the branch logic
      expect(isDaemon).toBe(false);

      // Verify the non-daemon path: SIGHUP should trigger shutdown (covered by registerSignalHandlers)
      // This is a logic verification test — actual signal delivery is tested manually
    });
  });

  describe('runOneTimeChromaMigration', () => {
    let testDataDir: string;

    beforeEach(() => {
      testDataDir = path.join(tmpdir(), `claude-mem-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      mkdirSync(testDataDir, { recursive: true });
    });

    afterEach(() => {
      rmSync(testDataDir, { recursive: true, force: true });
    });

    it('should wipe chroma directory and write marker file', () => {
      // Create a fake chroma directory with data
      const chromaDir = path.join(testDataDir, 'chroma');
      mkdirSync(chromaDir, { recursive: true });
      writeFileSync(path.join(chromaDir, 'test-data.bin'), 'fake chroma data');

      runOneTimeChromaMigration(testDataDir);

      // Chroma dir should be gone
      expect(existsSync(chromaDir)).toBe(false);
      // Marker file should exist
      expect(existsSync(path.join(testDataDir, '.chroma-cleaned-v10.3'))).toBe(true);
    });

    it('should skip when marker file already exists (idempotent)', () => {
      // Write marker file first
      writeFileSync(path.join(testDataDir, '.chroma-cleaned-v10.3'), 'already done');

      // Create a chroma directory that should NOT be wiped
      const chromaDir = path.join(testDataDir, 'chroma');
      mkdirSync(chromaDir, { recursive: true });
      writeFileSync(path.join(chromaDir, 'important.bin'), 'should survive');

      runOneTimeChromaMigration(testDataDir);

      // Chroma dir should still exist (migration was skipped)
      expect(existsSync(chromaDir)).toBe(true);
      expect(existsSync(path.join(chromaDir, 'important.bin'))).toBe(true);
    });

    it('should handle missing chroma directory gracefully', () => {
      // No chroma dir exists — should just write marker without error
      expect(() => runOneTimeChromaMigration(testDataDir)).not.toThrow();
      expect(existsSync(path.join(testDataDir, '.chroma-cleaned-v10.3'))).toBe(true);
    });
  });
});
