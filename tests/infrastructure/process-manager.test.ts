import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import path from 'path';
import {
  writePidFile,
  readPidFile,
  removePidFile,
  getPlatformTimeout,
  parseElapsedTime,
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
});
