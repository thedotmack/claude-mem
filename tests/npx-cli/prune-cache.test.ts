import { describe, it, expect, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  planCachePrune,
  planPluginCachePrune,
  prunePluginCache,
  readRegisteredCacheVersions,
  workingCacheVersions,
  DEFAULT_CACHE_RETENTION,
} from '../../src/npx-cli/utils/prune-cache.js';

/**
 * A cache version directory as the installer leaves it: the plugin files with
 * a worker script and a package.json declaring one dependency. `complete`
 * installs that dependency; a fresh copy has none until "Setting up runtime".
 */
function writeCacheVersion(root: string, version: string, complete: boolean): void {
  const versionDir = join(root, version);
  mkdirSync(join(versionDir, 'scripts'), { recursive: true });
  writeFileSync(join(versionDir, 'scripts', 'worker-service.cjs'), '');
  writeFileSync(join(versionDir, 'package.json'), JSON.stringify({ version, dependencies: { 'left-pad': '1.3.0' } }));
  if (complete) {
    mkdirSync(join(versionDir, 'node_modules', 'left-pad'), { recursive: true });
    writeFileSync(join(versionDir, 'node_modules', 'left-pad', 'package.json'), '{"name":"left-pad"}');
  }
}

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

describe('prunePluginCache — never deletes the install that can still start a worker', () => {
  let root: string;
  const originalOverride = process.env.CLAUDE_MEM_WORKER_SCRIPT_PATH;

  afterEach(() => {
    if (originalOverride === undefined) delete process.env.CLAUDE_MEM_WORKER_SCRIPT_PATH;
    else process.env.CLAUDE_MEM_WORKER_SCRIPT_PATH = originalOverride;
    if (root && existsSync(root)) rmSync(root, { recursive: true, force: true });
  });

  it('keeps the only dependency-complete version while the newer copies still lack dependencies', () => {
    // The installer prunes right after copying 13.26.0 and before "Setting up
    // runtime" installs its dependencies; 13.25.0 is a failed earlier install.
    // Keeping just the newest two deleted 13.24.0, the only copy that could run.
    root = mkdtempSync(join(tmpdir(), 'claude-mem-prune-working-'));
    writeCacheVersion(root, '13.26.0', false);
    writeCacheVersion(root, '13.25.0', false);
    writeCacheVersion(root, '13.24.0', true);
    writeCacheVersion(root, '13.23.0', true);

    const result = prunePluginCache({ cacheRoot: root, keepCount: 2 });

    expect(result.removed).toEqual(['13.23.0']);
    expect(existsSync(join(root, '13.24.0', 'scripts', 'worker-service.cjs'))).toBe(true);
  });

  it('keeps the version the worker resolver picks, even outside the newest two', () => {
    root = mkdtempSync(join(tmpdir(), 'claude-mem-prune-resolved-'));
    for (const version of ['13.20.0', '13.24.0', '13.25.0', '13.25.1']) writeCacheVersion(root, version, true);
    // resolveWorkerScript() honors this override first: every launcher spawns it.
    process.env.CLAUDE_MEM_WORKER_SCRIPT_PATH = join(root, '13.20.0', 'scripts', 'worker-service.cjs');

    const result = prunePluginCache({ cacheRoot: root, keepCount: 2 });

    expect(result.removed).toEqual(['13.24.0']);
    expect(existsSync(join(root, '13.20.0'))).toBe(true);
  });

  it('protects nothing extra for a resolver pick outside the cache', () => {
    root = mkdtempSync(join(tmpdir(), 'claude-mem-prune-outside-'));
    writeCacheVersion(root, '13.25.0', false);
    const outside = { scriptPath: join(tmpdir(), 'elsewhere', '13.20.0', 'scripts', 'worker-service.cjs'), version: '13.20.0' };
    // No cache copy is complete, so the newest installed one stands in.
    expect(workingCacheVersions(root, outside)).toEqual(['13.25.0']);
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

describe('readRegisteredCacheVersions', () => {
  let root: string;

  afterEach(() => {
    if (root && existsSync(root)) rmSync(root, { recursive: true, force: true });
  });

  function writeRegistry(contents: string): string {
    root = mkdtempSync(join(tmpdir(), 'claude-mem-prune-registry-'));
    const registryPath = join(root, 'installed_plugins.json');
    writeFileSync(registryPath, contents);
    return registryPath;
  }

  it('returns the cache directory names claude-mem is registered at', () => {
    const registryPath = writeRegistry(JSON.stringify({
      version: 2,
      plugins: {
        'claude-mem@thedotmack': [{ scope: 'user', installPath: '/home/u/.claude/plugins/cache/thedotmack/claude-mem/13.20.0', version: '13.20.0' }],
        'other@someone': [{ installPath: '/home/u/.claude/plugins/cache/someone/other/9.9.9' }],
      },
    }));
    expect(readRegisteredCacheVersions(registryPath)).toEqual(['13.20.0']);
  });

  it('returns nothing when the registry is missing or has no claude-mem entry', () => {
    expect(readRegisteredCacheVersions(join(tmpdir(), 'claude-mem-no-such-registry.json'))).toEqual([]);
    expect(readRegisteredCacheVersions(writeRegistry(JSON.stringify({ version: 2, plugins: {} })))).toEqual([]);
  });

  it('throws on a corrupt registry so nothing is pruned blind', () => {
    const registryPath = writeRegistry('{ not json');
    expect(() => readRegisteredCacheVersions(registryPath)).toThrow(/Corrupt JSON/);
  });

  it('keeps a downgraded registered install that is older than the newest two', () => {
    // Downgrade with the worker stopped: Claude Code loads 13.20.0, which is
    // outside the newest-2 budget. Deleting it would break the registered install.
    const registryPath = writeRegistry(JSON.stringify({
      plugins: { 'claude-mem@thedotmack': [{ installPath: join(root, 'cache', '13.20.0') }] },
    }));
    const cacheRoot = join(root, 'cache');
    for (const version of ['13.20.0', '13.24.0', '13.25.0', '13.25.1']) {
      mkdirSync(join(cacheRoot, version), { recursive: true });
    }

    const result = prunePluginCache({
      cacheRoot,
      keepCount: 2,
      protectedVersions: readRegisteredCacheVersions(registryPath),
    });

    expect(result.removed).toEqual(['13.24.0']);
    expect(existsSync(join(cacheRoot, '13.20.0'))).toBe(true);
  });
});
