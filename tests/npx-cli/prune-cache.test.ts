import { describe, it, expect, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  planCachePrune,
  planPluginCachePrune,
  prunePluginCache,
  DEFAULT_CACHE_RETENTION,
} from '../../src/npx-cli/utils/prune-cache.js';

describe('planCachePrune', () => {
  it('keeps the newest two versions by default and prunes the rest', () => {
    const { keep, prune } = planCachePrune(
      ['13.24.0', '13.25.0', '13.25.1', '13.20.0'],
      DEFAULT_CACHE_RETENTION,
    );
    expect(keep).toEqual(['13.25.1', '13.25.0']);
    expect(prune).toEqual(['13.24.0', '13.20.0']);
  });

  it('protects the live worker version even when it is older than N-1', () => {
    const { keep, prune } = planCachePrune(
      ['13.25.1', '13.25.0', '13.20.0'],
      2,
      { protectedVersions: ['13.20.0'] },
    );
    expect(keep).toContain('13.20.0');
    expect(prune).not.toContain('13.20.0');
  });

  it('ignores names that are not version directories', () => {
    const { keep, prune } = planCachePrune(
      ['13.25.1', '13.25.0', '13.24.0', '.tmp', 'node_modules'],
      2,
    );
    expect(keep).not.toContain('.tmp');
    expect(prune).not.toContain('.tmp');
    expect(prune).toContain('13.24.0');
  });

  it('ranks release ahead of prerelease at the same base', () => {
    const { keep } = planCachePrune(
      ['13.25.1', '13.25.1-beta.1', '13.24.0'],
      2,
    );
    expect(keep).toEqual(['13.25.1', '13.25.1-beta.1']);
  });

  it('prunes nothing when the version count is within the keep budget', () => {
    const { prune } = planCachePrune(['13.25.1', '13.25.0'], 2);
    expect(prune).toEqual([]);
  });

  it('does not let an orphaned newest directory consume a retention slot', () => {
    // 13.26.0 is orphaned: the resolver ignores it, so it must not displace a
    // usable rollback version. Keep the two newest usable ones and prune the orphan.
    const { keep, prune } = planCachePrune(
      ['13.26.0', '13.25.0', '13.24.0'],
      2,
      { orphanedVersions: ['13.26.0'] },
    );
    expect(keep).toEqual(['13.25.0', '13.24.0']);
    expect(prune).toEqual(['13.26.0']);
  });
});

describe('prunePluginCache', () => {
  let root: string;

  afterEach(() => {
    if (root && existsSync(root)) rmSync(root, { recursive: true, force: true });
  });

  it('removes superseded version directories on disk and keeps the newest', () => {
    root = mkdtempSync(join(tmpdir(), 'claude-mem-prune-'));
    for (const version of ['13.20.0', '13.24.0', '13.25.0', '13.25.1']) {
      mkdirSync(join(root, version));
    }

    const result = prunePluginCache({ cacheRoot: root, keepCount: 2 });

    expect(result.removed.sort()).toEqual(['13.20.0', '13.24.0']);
    expect(existsSync(join(root, '13.25.1'))).toBe(true);
    expect(existsSync(join(root, '13.25.0'))).toBe(true);
    expect(existsSync(join(root, '13.24.0'))).toBe(false);
    expect(existsSync(join(root, '13.20.0'))).toBe(false);
  });

  it('returns an empty result when the cache root does not exist', () => {
    root = join(tmpdir(), 'claude-mem-prune-missing-does-not-exist');
    const result = prunePluginCache({ cacheRoot: root, keepCount: 2 });
    expect(result.removed).toEqual([]);
    expect(result.kept).toEqual([]);
  });

  it('prunes an orphaned newest directory and keeps usable rollback versions', () => {
    root = mkdtempSync(join(tmpdir(), 'claude-mem-prune-orphan-'));
    for (const version of ['13.24.0', '13.25.0', '13.26.0']) {
      mkdirSync(join(root, version));
    }
    // Claude Code stamps the superseded newest directory as orphaned.
    writeFileSync(join(root, '13.26.0', '.orphaned_at'), '');

    const result = prunePluginCache({ cacheRoot: root, keepCount: 2 });

    expect(result.removed).toEqual(['13.26.0']);
    expect(existsSync(join(root, '13.26.0'))).toBe(false);
    expect(existsSync(join(root, '13.25.0'))).toBe(true);
    expect(existsSync(join(root, '13.24.0'))).toBe(true);
  });
});

describe('planPluginCachePrune', () => {
  let root: string;

  afterEach(() => {
    if (root && existsSync(root)) rmSync(root, { recursive: true, force: true });
  });

  it('reads .orphaned_at markers from disk and previews the same removals', () => {
    root = mkdtempSync(join(tmpdir(), 'claude-mem-prune-plan-'));
    for (const version of ['13.24.0', '13.25.0', '13.26.0']) {
      mkdirSync(join(root, version));
    }
    writeFileSync(join(root, '13.26.0', '.orphaned_at'), '');

    const { keep, prune } = planPluginCachePrune(root, 2);
    expect(prune).toEqual(['13.26.0']);
    expect(keep).toEqual(['13.25.0', '13.24.0']);
    // Preview only — nothing deleted.
    expect(existsSync(join(root, '13.26.0'))).toBe(true);
  });
});
