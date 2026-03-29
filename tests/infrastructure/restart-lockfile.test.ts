import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, writeFileSync, unlinkSync, statSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import path from 'path';
import {
  acquireRestartLock,
  releaseRestartLock,
  isRestartLockHeld
} from '../../src/services/infrastructure/index.js';

const DATA_DIR = path.join(homedir(), '.claude-mem');
const LOCK_FILE = path.join(DATA_DIR, '.worker-restart.lock');

describe('Restart Lockfile Coordination', () => {
  beforeEach(() => {
    // Ensure clean state
    if (existsSync(LOCK_FILE)) {
      unlinkSync(LOCK_FILE);
    }
  });

  afterEach(() => {
    // Clean up
    if (existsSync(LOCK_FILE)) {
      unlinkSync(LOCK_FILE);
    }
  });

  describe('acquireRestartLock', () => {
    it('should acquire lock when no lock exists', () => {
      const acquired = acquireRestartLock();
      expect(acquired).toBe(true);
      expect(existsSync(LOCK_FILE)).toBe(true);
    });

    it('should reject acquisition when fresh lock exists', () => {
      // First acquisition succeeds
      const first = acquireRestartLock();
      expect(first).toBe(true);

      // Second acquisition fails (lock is held)
      const second = acquireRestartLock();
      expect(second).toBe(false);
    });

    it('should write PID info to lock file', () => {
      acquireRestartLock();
      const content = JSON.parse(require('fs').readFileSync(LOCK_FILE, 'utf-8'));
      expect(content.pid).toBe(process.pid);
      expect(typeof content.acquiredAt).toBe('number');
    });
  });

  describe('releaseRestartLock', () => {
    it('should remove lock file', () => {
      acquireRestartLock();
      expect(existsSync(LOCK_FILE)).toBe(true);

      releaseRestartLock();
      expect(existsSync(LOCK_FILE)).toBe(false);
    });

    it('should not throw when no lock exists', () => {
      expect(() => releaseRestartLock()).not.toThrow();
    });
  });

  describe('isRestartLockHeld', () => {
    it('should return false when no lock exists', () => {
      expect(isRestartLockHeld()).toBe(false);
    });

    it('should return true when fresh lock exists', () => {
      acquireRestartLock();
      expect(isRestartLockHeld()).toBe(true);
    });

    it('should return false for expired lock (TTL > 30s)', () => {
      // Create a lock file with an old mtime
      mkdirSync(DATA_DIR, { recursive: true });
      writeFileSync(LOCK_FILE, JSON.stringify({ pid: 99999, acquiredAt: Date.now() - 60000 }));
      // Set mtime to 60 seconds ago
      const pastDate = new Date(Date.now() - 60000);
      require('fs').utimesSync(LOCK_FILE, pastDate, pastDate);

      expect(isRestartLockHeld()).toBe(false);
    });
  });

  describe('stale lock override', () => {
    it('should override expired lock on acquisition', () => {
      // Create a stale lock (>30s old)
      mkdirSync(DATA_DIR, { recursive: true });
      writeFileSync(LOCK_FILE, JSON.stringify({ pid: 99999, acquiredAt: Date.now() - 60000 }));
      const pastDate = new Date(Date.now() - 60000);
      require('fs').utimesSync(LOCK_FILE, pastDate, pastDate);

      // Should acquire despite stale lock
      const acquired = acquireRestartLock();
      expect(acquired).toBe(true);

      // Lock should contain our PID
      const content = JSON.parse(require('fs').readFileSync(LOCK_FILE, 'utf-8'));
      expect(content.pid).toBe(process.pid);
    });
  });
});
