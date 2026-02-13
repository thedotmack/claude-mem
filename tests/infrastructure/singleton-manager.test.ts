import { describe, it, expect, afterEach } from 'bun:test';
import { acquireSpawnLock } from '../../src/services/infrastructure/singleton-manager.js';
import path from 'path';
import os from 'os';
import fs from 'fs';

// Default port lock path — tests use default port 37777
const LOCK_PATH = path.join(os.homedir(), '.claude-mem', 'worker-spawn-37777.lock');

afterEach(() => {
  // Clean up lock file if test fails
  try { fs.unlinkSync(LOCK_PATH); } catch {}
});

describe('singleton-manager', () => {
  it('acquires lock and releases it via callback', async () => {
    const result = await acquireSpawnLock(async () => {
      // Lock should exist while we're inside
      expect(fs.existsSync(LOCK_PATH)).toBe(true);
      return 'spawned';
    });
    expect(result).toBe('spawned');
  });

  it('returns null when lock is already held', async () => {
    // Simulate held lock by acquiring it first
    const lockfile = await import('proper-lockfile');
    const release = await lockfile.default.lock(LOCK_PATH, {
      realpath: false,
      retries: 0
    });

    try {
      const result = await acquireSpawnLock(async () => {
        return 'should-not-reach';
      });
      // Should return null (lock not acquired)
      expect(result).toBeNull();
    } finally {
      await release();
    }
  });

  it('releases lock even if callback throws', async () => {
    try {
      await acquireSpawnLock(async () => {
        throw new Error('boom');
      });
    } catch {}

    // Lock should be released — second acquire should succeed
    const result = await acquireSpawnLock(async () => 'ok');
    expect(result).toBe('ok');
  });
});
