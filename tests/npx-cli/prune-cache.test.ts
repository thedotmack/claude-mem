import { describe, it, expect, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync, symlinkSync, readFileSync, utimesSync } from 'fs';
import { tmpdir } from 'os';
import path, { join } from 'path';
import { spawnSync } from 'node:child_process';
import {
  planCachePrune,
  planPluginCachePrune,
  prunePluginCache,
  pruneSupersededPluginCache,
  readRegisteredCacheVersions,
  readUserScopeRegisteredCacheVersions,
  workingCacheVersions,
  isDirectChildPath,
  DEFAULT_CACHE_RETENTION,
  ORPHANED_CACHE_RETENTION_MS,
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

describe('prunePluginCacheSafely protects the running worker', () => {
  it.each([
    ['old live version', { version: '13.20.0' }, false, false, []],
    ['missing version', {}, false, true, []],
    ['invalid version', { version: 123 }, false, true, []],
    ['invalid JSON', 'invalid-json', false, true, []],
    ['health timeout', 'timeout', false, true, []],
    ['silent port with owned worker', 'refused', true, true, []],
    ['no worker', 'refused', false, false, ['13.20.0']],
  ])('%s', (_name, health, owned, retainAll, removed) => {
    const root = mkdtempSync(join(tmpdir(), 'claude-mem-prune-live-'));
    try {
      for (const version of ['13.20.0', '13.24.0', '13.25.0']) mkdirSync(join(root, version));
      const script = `
        import { mock } from 'bun:test';
        const paths = await import(${JSON.stringify(join(import.meta.dir, '../../src/npx-cli/utils/paths.ts'))});
        const registry = await import(${JSON.stringify(join(import.meta.dir, '../../src/supervisor/process-registry.ts'))});
        mock.module(${JSON.stringify(join(import.meta.dir, '../../src/npx-cli/utils/paths.ts'))}, () => ({
          ...paths, installedPluginsPath: () => ${JSON.stringify(join(root, 'missing-registry.json'))},
        }));
        mock.module(${JSON.stringify(join(import.meta.dir, '../../src/supervisor/process-registry.ts'))}, () => ({
          ...registry, readOwnedWorkerPidInfo: () => ${owned ? '{ pid: 123 }' : 'null'},
        }));
        const health = ${JSON.stringify(health)};
        let requests = 0;
        globalThis.fetch = async (url) => {
          if (!String(url).endsWith('/api/health')) throw new Error('unexpected URL: ' + url);
          requests++;
          if (health === 'timeout') throw new Error('request timed out');
          if (health === 'refused') throw new Error('ECONNREFUSED');
          return new Response(health === 'invalid-json' ? '{' : JSON.stringify(health));
        };
        const { prunePluginCacheSafely } = await import(${JSON.stringify(join(import.meta.dir, '../../src/npx-cli/utils/prune-cache.ts'))});
        const result = await prunePluginCacheSafely({ cacheRoot: ${JSON.stringify(root)}, keepCount: 2 });
        console.log(JSON.stringify({ result, requests }));
      `;
      const child = spawnSync(process.execPath, ['--eval', script], {
        env: { ...process.env, CLAUDE_MEM_DATA_DIR: join(root, 'data'), CLAUDE_CONFIG_DIR: join(root, 'claude') },
        encoding: 'utf8', timeout: 10_000,
      });
      expect(child.status, child.stderr).toBe(0);
      const { result, requests } = JSON.parse(child.stdout.trim().split('\n').at(-1)!);
      expect(requests).toBe(1);
      expect(result.retainedForLiveWorker).toBe(retainAll);
      expect(result.removed).toEqual(removed);
      expect(result.failed).toEqual([]);
      for (const version of ['13.20.0', '13.24.0', '13.25.0']) {
        expect(existsSync(join(root, version))).toBe(!removed.includes(version));
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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

  it('prunes an orphaned directory once its retention has passed', () => {
    root = mkdtempSync(join(tmpdir(), 'claude-mem-prune-orphan-'));
    for (const version of ['13.24.0', '13.25.0', '13.26.0']) {
      mkdirSync(join(root, version));
    }
    // The auto-updater stamps the replaced directory with the epoch ms it was
    // superseded at; this one is older than the retention window.
    writeFileSync(join(root, '13.26.0', '.orphaned_at'), String(Date.now() - ORPHANED_CACHE_RETENTION_MS - 60_000));

    const result = prunePluginCache({ cacheRoot: root, keepCount: 2 });

    expect(result.removed).toEqual(['13.26.0']);
    expect(existsSync(join(root, '13.26.0'))).toBe(false);
    expect(existsSync(join(root, '13.25.0'))).toBe(true);
    expect(existsSync(join(root, '13.24.0'))).toBe(true);
  });

  it('keeps a directory orphaned by the update while a session may still load it (#5970)', () => {
    // A session that started on 13.26.0 keeps running its hooks from that folder
    // after the update. Pruning it five minutes later made every hook in that
    // session fail silently.
    root = mkdtempSync(join(tmpdir(), 'claude-mem-prune-orphan-fresh-'));
    for (const version of ['13.24.0', '13.25.0', '13.26.0']) {
      mkdirSync(join(root, version));
    }
    writeFileSync(join(root, '13.26.0', '.orphaned_at'), String(Date.now()));

    const result = prunePluginCache({ cacheRoot: root, keepCount: 2 });

    expect(result.removed).toEqual([]);
    expect(existsSync(join(root, '13.26.0'))).toBe(true);
  });

  it('accepts a seconds-precision orphan time', () => {
    root = mkdtempSync(join(tmpdir(), 'claude-mem-prune-orphan-seconds-'));
    for (const version of ['13.24.0', '13.25.0', '13.26.0']) {
      mkdirSync(join(root, version));
    }
    writeFileSync(join(root, '13.26.0', '.orphaned_at'), String(Math.floor(Date.now() / 1000)));

    const result = prunePluginCache({ cacheRoot: root, keepCount: 2 });

    expect(result.removed).toEqual([]);
    expect(existsSync(join(root, '13.26.0'))).toBe(true);
  });

  it('treats a marker far in the future as unreadable and falls back to its mtime', () => {
    root = mkdtempSync(join(tmpdir(), 'claude-mem-prune-orphan-future-'));
    for (const version of ['13.24.0', '13.25.0', '13.26.0']) {
      mkdirSync(join(root, version));
    }
    const marker = join(root, '13.26.0', '.orphaned_at');
    writeFileSync(marker, String(Date.now() + 1e15));
    const old = new Date(Date.now() - ORPHANED_CACHE_RETENTION_MS - 60_000);
    utimesSync(marker, old, old);

    const result = prunePluginCache({ cacheRoot: root, keepCount: 2 });

    expect(result.removed).toEqual(['13.26.0']);
  });

  it('keeps an orphaned directory whose marker carries no time', () => {
    // Claude Code writes its own marker, which may be empty; the marker's mtime
    // is the only orphan time then, and it is recent, so the folder stays.
    root = mkdtempSync(join(tmpdir(), 'claude-mem-prune-orphan-untimed-'));
    for (const version of ['13.24.0', '13.25.0', '13.26.0']) {
      mkdirSync(join(root, version));
    }
    writeFileSync(join(root, '13.26.0', '.orphaned_at'), '');

    const result = prunePluginCache({ cacheRoot: root, keepCount: 2 });

    expect(result.removed).toEqual([]);
    expect(existsSync(join(root, '13.26.0'))).toBe(true);
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
    writeFileSync(join(root, '13.26.0', '.orphaned_at'), String(Date.now() - ORPHANED_CACHE_RETENTION_MS - 60_000));

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

  it('protects every scope\'s registered version, while the auto-updater reads only the user-scope entry the npx installer writes', () => {
    // Project-local scratch (gitignored), never the system temp folder.
    const scratchRoot = join(import.meta.dir, '..', '..', '.scratch', 'test-runs');
    mkdirSync(scratchRoot, { recursive: true });
    const scratch = mkdtempSync(join(scratchRoot, 'prune-registry-scopes-'));
    try {
      const registryPath = join(scratch, 'installed_plugins.json');
      const entry = (scope: string, version: string) => ({ scope, installPath: join(scratch, 'cache', version), version, ...(scope === 'user' ? {} : { projectPath: '/work/p' }) });
      writeFileSync(registryPath, JSON.stringify({ version: 2, plugins: { 'claude-mem@thedotmack': [entry('project', '13.19.0'), entry('user', '13.20.0'), entry('local', '13.18.0')] } }));
      expect(readRegisteredCacheVersions(registryPath)).toEqual(['13.19.0', '13.20.0', '13.18.0']);
      expect(readUserScopeRegisteredCacheVersions(registryPath)).toEqual(['13.20.0']);

      writeFileSync(registryPath, JSON.stringify({ version: 2, plugins: { 'claude-mem@thedotmack': [entry('project', '13.19.0')] } }));
      expect(readUserScopeRegisteredCacheVersions(registryPath)).toEqual([]);

      writeFileSync(registryPath, '{ not json');
      expect(() => readUserScopeRegisteredCacheVersions(registryPath)).toThrow(/Corrupt JSON/);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
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

describe('isDirectChildPath', () => {
  it('accepts one version segment on Windows and POSIX paths and rejects an escape', () => {
    const winRoot = 'C:\\Users\\Ada\\.claude\\plugins\\cache\\thedotmack\\claude-mem';
    expect(isDirectChildPath(winRoot, `${winRoot}\\15.15.1`, path.win32)).toBe(true);
    expect(isDirectChildPath(winRoot, 'C:\\Users\\Ada\\.claude\\plugins\\cache\\someone\\other\\15.15.1', path.win32)).toBe(false);
    expect(isDirectChildPath(winRoot, 'C:\\Windows\\System32', path.win32)).toBe(false);

    const posixRoot = '/home/ada/.claude/plugins/cache/thedotmack/claude-mem';
    expect(isDirectChildPath(posixRoot, `${posixRoot}/15.15.1`, path.posix)).toBe(true);
    expect(isDirectChildPath(posixRoot, '/home/ada/.claude/plugins/cache/someone/other', path.posix)).toBe(false);
    expect(isDirectChildPath(posixRoot, `${posixRoot}/15.15.1/scripts`, path.posix)).toBe(false);
  });
});

function writeWorkerScript(root: string, version: string): string {
  const script = join(root, version, 'scripts', 'worker-service.cjs');
  mkdirSync(join(root, version, 'scripts'), { recursive: true });
  writeFileSync(script, '');
  return script;
}

describe('pruneSupersededPluginCache', () => {
  let scratch: string;

  afterEach(() => {
    if (scratch && existsSync(scratch)) rmSync(scratch, { recursive: true, force: true });
  });

  it('keeps the running version and the newest two, and leaves everything else outside the cache', async () => {
    scratch = mkdtempSync(join(tmpdir(), 'claude-mem prune '));
    const root = join(scratch, 'cache');
    const running = writeWorkerScript(root, '15.5.0');
    writeWorkerScript(root, '15.14.0');
    writeWorkerScript(root, '15.15.0');
    writeWorkerScript(root, '15.15.1');
    mkdirSync(join(root, 'notes'));
    writeFileSync(join(root, 'notes', 'keep.txt'), 'notes');
    const neighbor = join(scratch, 'other-plugin', '15.0.0');
    mkdirSync(neighbor, { recursive: true });
    writeFileSync(join(neighbor, 'keep.txt'), 'neighbor');

    const result = await pruneSupersededPluginCache({
      cacheRoot: root,
      keepCount: 2,
      runningScriptPath: running,
      registryPath: join(scratch, 'no-registry.json'),
    });

    expect(result.removed).toEqual(['15.14.0']);
    expect(existsSync(join(root, '15.5.0', 'scripts', 'worker-service.cjs'))).toBe(true);
    expect(existsSync(join(root, '15.15.1'))).toBe(true);
    expect(existsSync(join(root, '15.15.0'))).toBe(true);
    expect(existsSync(join(root, '15.14.0'))).toBe(false);
    expect(readFileSync(join(root, 'notes', 'keep.txt'), 'utf-8')).toBe('notes');
    expect(readFileSync(join(neighbor, 'keep.txt'), 'utf-8')).toBe('neighbor');
  });

  it('never removes the folder the worker runs from when that version is a symlink out of the cache', async () => {
    // Running from the link's target: the script is outside the cache root, so only the
    // resolved-path check stands between the sweep and the live worker's own folder.
    scratch = mkdtempSync(join(tmpdir(), 'claude-mem-prune-running-link-'));
    const root = join(scratch, 'cache');
    const elsewhere = join(scratch, 'dev-checkout');
    const running = writeWorkerScript(elsewhere, '15.4.0');
    mkdirSync(root);
    symlinkSync(join(elsewhere, '15.4.0'), join(root, '15.4.0'));
    writeWorkerScript(root, '15.15.0');
    writeWorkerScript(root, '15.15.1');

    const result = await pruneSupersededPluginCache({
      cacheRoot: root,
      keepCount: 2,
      runningScriptPath: join(elsewhere, '15.4.0', 'scripts'),
      registryPath: join(scratch, 'no-registry.json'),
    });

    expect(result.removed).toEqual([]);
    expect(result.failed.map(failure => failure.version)).toEqual(['15.4.0']);
    expect(existsSync(join(root, '15.4.0', 'scripts', 'worker-service.cjs'))).toBe(true);
    expect(existsSync(running)).toBe(true);
  });

  it("keeps the worker's own package version even when it is older than the newest two", async () => {
    scratch = mkdtempSync(join(tmpdir(), 'claude-mem-prune-package-version-'));
    const root = join(scratch, 'cache');
    for (const version of ['15.5.0', '15.14.0', '15.15.0', '15.15.1']) writeWorkerScript(root, version);

    const result = await pruneSupersededPluginCache({
      cacheRoot: root,
      keepCount: 2,
      additionalProtectedVersions: ['15.5.0'],
      registryPath: join(scratch, 'no-registry.json'),
    });

    expect(result.removed).toEqual(['15.14.0']);
    expect(existsSync(join(root, '15.5.0', 'scripts', 'worker-service.cjs'))).toBe(true);
  });

  it('removes an old version when nothing is running from it', async () => {
    scratch = mkdtempSync(join(tmpdir(), 'claude-mem-prune-unprotected-'));
    const root = join(scratch, 'cache');
    for (const version of ['15.5.0', '15.15.0', '15.15.1']) writeWorkerScript(root, version);

    const result = await pruneSupersededPluginCache({
      cacheRoot: root,
      keepCount: 2,
      registryPath: join(scratch, 'no-registry.json'),
    });

    expect(result.removed).toEqual(['15.5.0']);
    expect(existsSync(join(root, '15.5.0'))).toBe(false);
  });

  it('does not follow a symlink version or a symlink inside a removed version', async () => {
    scratch = mkdtempSync(join(tmpdir(), 'claude-mem-prune-symlink-'));
    const root = join(scratch, 'cache');
    const preciousDir = join(scratch, 'precious');
    mkdirSync(preciousDir);
    writeFileSync(join(preciousDir, 'keep.txt'), 'keep');
    mkdirSync(root);
    symlinkSync(preciousDir, join(root, '15.4.0'));
    const inside = join(root, '15.4.1');
    mkdirSync(inside);
    const preciousFile = join(scratch, 'precious.txt');
    writeFileSync(preciousFile, 'file');
    symlinkSync(preciousFile, join(inside, 'link'));
    writeWorkerScript(root, '15.15.0');
    writeWorkerScript(root, '15.15.1');

    const result = await pruneSupersededPluginCache({
      cacheRoot: root,
      keepCount: 2,
      registryPath: join(scratch, 'no-registry.json'),
    });

    expect(result.removed.sort()).toEqual(['15.4.0', '15.4.1']);
    expect(readFileSync(join(preciousDir, 'keep.txt'), 'utf-8')).toBe('keep');
    expect(readFileSync(preciousFile, 'utf-8')).toBe('file');
    expect(existsSync(join(root, '15.15.1'))).toBe(true);
  });

  it('returns an empty removal when the cache root does not exist', async () => {
    scratch = join(tmpdir(), 'claude-mem-prune-absent-root');
    const result = await pruneSupersededPluginCache({
      cacheRoot: join(scratch, 'missing'),
      registryPath: join(scratch, 'no-registry.json'),
    });
    expect(result.removed).toEqual([]);
    expect(result.kept).toEqual([]);
  });

  it('throws on a corrupt registry before deleting anything', async () => {
    scratch = mkdtempSync(join(tmpdir(), 'claude-mem-prune-corrupt-'));
    const root = join(scratch, 'cache');
    writeWorkerScript(root, '15.5.0');
    writeWorkerScript(root, '15.15.0');
    writeWorkerScript(root, '15.15.1');
    const registryPath = join(scratch, 'installed_plugins.json');
    writeFileSync(registryPath, '{ not json');

    await expect(pruneSupersededPluginCache({ cacheRoot: root, registryPath })).rejects.toThrow(/Corrupt JSON/);
    expect(existsSync(join(root, '15.5.0'))).toBe(true);
  });

  it('keeps the version installed_plugins.json registers even when it is older than the newest two', async () => {
    scratch = mkdtempSync(join(tmpdir(), 'claude-mem-prune-registered-'));
    const root = join(scratch, 'cache');
    for (const version of ['15.5.0', '15.14.0', '15.15.0', '15.15.1']) writeWorkerScript(root, version);
    const registryPath = join(scratch, 'installed_plugins.json');
    writeFileSync(registryPath, JSON.stringify({
      plugins: { 'claude-mem@thedotmack': [{ scope: 'user', installPath: join(root, '15.5.0') }] },
    }));

    const result = await pruneSupersededPluginCache({ cacheRoot: root, keepCount: 2, registryPath });

    expect(result.removed).toEqual(['15.14.0']);
    expect(existsSync(join(root, '15.5.0'))).toBe(true);
  });
});
