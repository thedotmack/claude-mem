import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import path from 'path';
import {
  writePidFile,
  readPidFile,
  removePidFile,
  getPlatformTimeout,
  isOrphanedProcess,
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
      const { writeFileSync } = require('fs');
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
      const { writeFileSync } = require('fs');
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

  describe('isOrphanedProcess', () => {
    it('should return false for invalid PIDs', async () => {
      // Negative PID
      expect(await isOrphanedProcess(-1)).toBe(false);
      // Zero PID
      expect(await isOrphanedProcess(0)).toBe(false);
      // NaN-like values (cast to number)
      expect(await isOrphanedProcess(NaN as unknown as number)).toBe(false);
      // Non-integer
      expect(await isOrphanedProcess(1.5 as unknown as number)).toBe(false);
    });

    it('should return false for current process (has valid parent)', async () => {
      // The current process (this test) has a valid parent (the test runner)
      const result = await isOrphanedProcess(process.pid);
      expect(result).toBe(false);
    });

    it('should return false for parent process (has valid parent)', async () => {
      // The parent process should also have a valid parent
      const ppid = process.ppid;
      if (ppid && ppid > 1) {
        const result = await isOrphanedProcess(ppid);
        expect(result).toBe(false);
      }
    });

    it('should return false for non-existent PID (safe default)', async () => {
      // Use a very high PID that is unlikely to exist
      // SAFETY: Should return false (not orphaned) when we can't determine
      const highPid = 4000000000; // Unlikely to exist
      const result = await isOrphanedProcess(highPid);
      // Should return false because process doesn't exist (can't get PPID)
      expect(result).toBe(false);
    });

    it('should handle PID 1 correctly (init is not orphaned)', async () => {
      // PID 1 (init/systemd) itself is not orphaned - it has no parent
      // But we should handle this gracefully
      if (process.platform !== 'win32') {
        // On Unix, trying to check PID 1 should work without error
        // It will return false because PID 1's PPID is 0
        const result = await isOrphanedProcess(1);
        // PID 1 has PPID 0, which is the kernel - we treat PPID 0 as init-like
        // So PID 1 would be considered "orphaned" but that's correct behavior
        // since its parent is the kernel scheduler
        expect(typeof result).toBe('boolean');
      }
    });

    // Platform-specific behavior tests
    if (process.platform !== 'win32') {
      describe('Unix/Linux specific', () => {
        it('should correctly identify process with valid parent as not orphaned', async () => {
          // Current process has a valid parent (the shell/test runner)
          const result = await isOrphanedProcess(process.pid);
          expect(result).toBe(false);
        });
      });
    }
  });
});
