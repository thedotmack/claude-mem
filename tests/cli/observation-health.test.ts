import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'fs';
import path from 'path';
import { homedir } from 'os';

import {
  recordObservationFailure,
  recordObservationSuccess,
  readAndClearObservationHealth
} from '../../src/cli/observation-health.js';

const DATA_DIR = path.join(homedir(), '.magic-claude-mem');
const HEALTH_FILE = path.join(DATA_DIR, '.obs-health');

describe('observation-health', () => {
  let originalContent: string | null = null;

  beforeEach(() => {
    mkdirSync(DATA_DIR, { recursive: true });
    if (existsSync(HEALTH_FILE)) {
      originalContent = readFileSync(HEALTH_FILE, 'utf-8');
    }
    // Start clean
    try { unlinkSync(HEALTH_FILE); } catch { /* ignore */ }
  });

  afterEach(() => {
    // Restore original state
    try { unlinkSync(HEALTH_FILE); } catch { /* ignore */ }
    if (originalContent !== null) {
      writeFileSync(HEALTH_FILE, originalContent);
      originalContent = null;
    }
  });

  describe('recordObservationFailure', () => {
    it('should create health file on first failure', () => {
      recordObservationFailure('connection refused');

      expect(existsSync(HEALTH_FILE)).toBe(true);
      const health = JSON.parse(readFileSync(HEALTH_FILE, 'utf-8'));
      expect(health.failures).toBe(1);
      expect(health.lastError).toBe('connection refused');
      expect(health.since).toBeDefined();
      expect(health.version).toBeDefined();
    });

    it('should increment failure count on subsequent failures', () => {
      recordObservationFailure('first error');
      recordObservationFailure('second error');
      recordObservationFailure('third error');

      const health = JSON.parse(readFileSync(HEALTH_FILE, 'utf-8'));
      expect(health.failures).toBe(3);
      expect(health.lastError).toBe('third error');
    });

    it('should preserve original since timestamp across failures', () => {
      recordObservationFailure('first error');
      const firstHealth = JSON.parse(readFileSync(HEALTH_FILE, 'utf-8'));
      const originalSince = firstHealth.since;

      recordObservationFailure('second error');
      const secondHealth = JSON.parse(readFileSync(HEALTH_FILE, 'utf-8'));

      expect(secondHealth.since).toBe(originalSince);
    });
  });

  describe('recordObservationSuccess', () => {
    it('should delete health file when it exists', () => {
      recordObservationFailure('some error');
      expect(existsSync(HEALTH_FILE)).toBe(true);

      recordObservationSuccess();

      expect(existsSync(HEALTH_FILE)).toBe(false);
    });

    it('should not throw when health file does not exist', () => {
      expect(existsSync(HEALTH_FILE)).toBe(false);
      expect(() => { recordObservationSuccess(); }).not.toThrow();
    });
  });

  describe('readAndClearObservationHealth', () => {
    it('should return null when no health file exists', () => {
      const result = readAndClearObservationHealth();
      expect(result).toBeNull();
    });

    it('should return health data and delete the file', () => {
      recordObservationFailure('test error');
      recordObservationFailure('test error 2');

      const result = readAndClearObservationHealth();

      expect(result).not.toBeNull();
      expect(result!.failures).toBe(2);
      expect(result!.lastError).toBe('test error 2');
      expect(result!.since).toBeDefined();
      expect(result!.version).toBeDefined();
      // File should be deleted after read
      expect(existsSync(HEALTH_FILE)).toBe(false);
    });

    it('should return null on second call (atomic read-and-clear)', () => {
      recordObservationFailure('error');

      const first = readAndClearObservationHealth();
      const second = readAndClearObservationHealth();

      expect(first).not.toBeNull();
      expect(second).toBeNull();
    });
  });

  describe('self-healing cycle', () => {
    it('should clear failures after a single success', () => {
      recordObservationFailure('error 1');
      recordObservationFailure('error 2');
      recordObservationFailure('error 3');

      recordObservationSuccess();

      const result = readAndClearObservationHealth();
      expect(result).toBeNull();
    });

    it('should track new failures after a success reset', () => {
      recordObservationFailure('old error');
      recordObservationSuccess();
      recordObservationFailure('new error');

      const result = readAndClearObservationHealth();
      expect(result).not.toBeNull();
      expect(result!.failures).toBe(1);
      expect(result!.lastError).toBe('new error');
    });
  });
});
