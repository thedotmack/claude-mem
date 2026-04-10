/**
 * Tests for BranchManager cache-install detection (issue #1497)
 *
 * Mock Justification (~40% mock code):
 * - fs module (existsSync, readdirSync, statSync): Required to simulate
 *   different install layouts without touching the real filesystem.
 * - MARKETPLACE_ROOT and CLAUDE_CONFIG_DIR: Overridden via env to keep
 *   tests hermetic and avoid touching ~/.claude.
 *
 * Value: Prevents regressions in the cache-vs-marketplace detection logic
 * that caused "Update now" to fail with an unhelpful error when the plugin
 * was installed via Claude Code's native cache layout.
 */
import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import path from 'path';

// ---------------------------------------------------------------------------
// Helpers to control findCacheInstallDirectory in isolation
// ---------------------------------------------------------------------------

const FAKE_CACHE_BASE = '/fake/.claude/plugins/cache/thedotmack/claude-mem';
const FAKE_MARKETPLACE = '/fake/.claude/plugins/marketplaces/thedotmack';
const FAKE_CACHE_VERSION = `${FAKE_CACHE_BASE}/10.6.2`;

describe('BranchManager — cache install detection (issue #1497)', () => {
  let existsSyncMock: ReturnType<typeof spyOn>;
  let readdirSyncMock: ReturnType<typeof spyOn>;
  let statSyncMock: ReturnType<typeof spyOn>;

  beforeEach(() => {
    // Reset module cache so re-imports pick up fresh mocks
  });

  afterEach(() => {
    existsSyncMock?.mockRestore();
    readdirSyncMock?.mockRestore();
    statSyncMock?.mockRestore();
  });

  describe('findCacheInstallDirectory', () => {
    it('returns null when no cache base directory exists', async () => {
      const fs = await import('fs');
      existsSyncMock = spyOn(fs, 'existsSync').mockImplementation((p: any) => false);

      // Re-import to get fresh module that uses the mock
      const { findCacheInstallDirectory } = await import('../../src/services/worker/BranchManager.js');
      const result = findCacheInstallDirectory();
      expect(result).toBeNull();
    });

    it('returns null when cache base exists but has no versioned subdirectories', async () => {
      const fs = await import('fs');
      existsSyncMock = spyOn(fs, 'existsSync').mockImplementation((p: any) => true);
      readdirSyncMock = spyOn(fs, 'readdirSync').mockImplementation(() => [] as any);

      const { findCacheInstallDirectory } = await import('../../src/services/worker/BranchManager.js');
      const result = findCacheInstallDirectory();
      expect(result).toBeNull();
    });
  });

  describe('getBranchInfo — cache install layout', () => {
    it('returns isGitRepo=false with cache-specific error when only cache install is present', async () => {
      const fs = await import('fs');

      // Simulate: marketplace dir does NOT exist, cache dir exists with a version
      existsSyncMock = spyOn(fs, 'existsSync').mockImplementation((p: any) => {
        const strPath = String(p);
        // .git inside marketplace — does not exist
        if (strPath.endsWith('.git')) return false;
        // cache base — exists
        if (strPath.includes('cache')) return true;
        return false;
      });

      readdirSyncMock = spyOn(fs, 'readdirSync').mockImplementation((p: any) => {
        return ['10.6.2'] as any;
      });

      statSyncMock = spyOn(fs, 'statSync').mockImplementation((p: any) => {
        return { isDirectory: () => true, mtimeMs: Date.now() } as any;
      });

      const { getBranchInfo } = await import('../../src/services/worker/BranchManager.js');
      const info = getBranchInfo();

      expect(info.isGitRepo).toBe(false);
      expect(info.canSwitch).toBe(false);
      expect(info.error).toContain('cache');
    });

    it('returns isGitRepo=false with generic error when no install is found', async () => {
      const fs = await import('fs');

      existsSyncMock = spyOn(fs, 'existsSync').mockImplementation(() => false);
      readdirSyncMock = spyOn(fs, 'readdirSync').mockImplementation(() => [] as any);

      const { getBranchInfo } = await import('../../src/services/worker/BranchManager.js');
      const info = getBranchInfo();

      expect(info.isGitRepo).toBe(false);
      expect(info.canSwitch).toBe(false);
      // Generic error when no install found at all
      expect(info.error).toBeDefined();
    });
  });

  describe('pullUpdates — cache install layout', () => {
    it('returns a cache-specific error when the plugin is installed via cache', async () => {
      const fs = await import('fs');

      // Simulate cache-only install (no .git, cache dir exists)
      existsSyncMock = spyOn(fs, 'existsSync').mockImplementation((p: any) => {
        const strPath = String(p);
        if (strPath.endsWith('.git')) return false;
        if (strPath.includes('cache')) return true;
        return false;
      });

      readdirSyncMock = spyOn(fs, 'readdirSync').mockImplementation(() => ['10.6.2'] as any);
      statSyncMock = spyOn(fs, 'statSync').mockImplementation(() => {
        return { isDirectory: () => true, mtimeMs: Date.now() } as any;
      });

      const { pullUpdates } = await import('../../src/services/worker/BranchManager.js');
      const result = await pullUpdates();

      expect(result.success).toBe(false);
      // Error should mention cache or how to update
      expect(result.error).toBeDefined();
      expect(result.error).toContain('cache');
    });
  });
});
