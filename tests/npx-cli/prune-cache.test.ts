import { describe, it, expect, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  planCachePrune,
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
      ['13.20.0'],
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
});
