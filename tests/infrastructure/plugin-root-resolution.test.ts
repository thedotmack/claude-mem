import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { resolvePluginRoot, type WorkerScriptSearchRoots } from '../../src/shared/worker-utils.js';
import { findMissingPluginDependencies } from '../../src/shared/plugin-dependency-closure.js';
import { marketplaceManifestCheck, pluginRootCheck } from '../../src/npx-cli/commands/doctor.js';

/**
 * The CLI (`start`/`stop`/`status`/`doctor`) resolves the plugin root through
 * the same oracle the worker spawner uses — resolveWorkerScript() — so a
 * cache-only install the hooks run from is never "not installed" (#3534), and
 * doctor names the exact root the worker spawns from. Selection prefers roots
 * whose dependency closure is complete (plan-16 step 1c).
 */
describe('resolvePluginRoot (shared worker-script oracle)', () => {
  let base: string;
  let roots: WorkerScriptSearchRoots;
  const savedOverride = process.env.CLAUDE_MEM_WORKER_SCRIPT_PATH;
  const savedPluginRoot = process.env.CLAUDE_PLUGIN_ROOT;

  /** A plugin root with a worker script; `deps` are declared, `installed` get node_modules entries. */
  function writePluginRoot(root: string, options: { deps?: string[]; installed?: string[] } = {}): string {
    mkdirSync(join(root, 'scripts'), { recursive: true });
    writeFileSync(join(root, 'scripts', 'worker-service.cjs'), '// fake worker\n');
    const deps = options.deps ?? [];
    writeFileSync(join(root, 'package.json'), JSON.stringify({
      name: 'claude-mem-plugin',
      dependencies: Object.fromEntries(deps.map((dep) => [dep, '*'])),
    }));
    for (const dep of options.installed ?? deps) {
      mkdirSync(join(root, 'node_modules', ...dep.split('/')), { recursive: true });
      writeFileSync(join(root, 'node_modules', ...dep.split('/'), 'package.json'), JSON.stringify({ name: dep }));
    }
    return root;
  }

  function cacheVersionDir(version: string): string {
    return join(roots.cacheRoot, version);
  }

  function writeMarketplace(version: string, options: { deps?: string[]; installed?: string[] } = {}): string {
    mkdirSync(roots.marketplaceRoot, { recursive: true });
    writeFileSync(join(roots.marketplaceRoot, 'package.json'), JSON.stringify({ version }));
    return writePluginRoot(join(roots.marketplaceRoot, 'plugin'), options);
  }

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'claude-mem-plugin-root-'));
    roots = {
      cacheRoot: join(base, 'cache', 'thedotmack', 'claude-mem'),
      marketplaceRoot: join(base, 'marketplaces', 'thedotmack'),
      cwd: join(base, 'project'),
    };
    delete process.env.CLAUDE_MEM_WORKER_SCRIPT_PATH;
    delete process.env.CLAUDE_PLUGIN_ROOT;
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
    if (savedOverride === undefined) delete process.env.CLAUDE_MEM_WORKER_SCRIPT_PATH;
    else process.env.CLAUDE_MEM_WORKER_SCRIPT_PATH = savedOverride;
    if (savedPluginRoot === undefined) delete process.env.CLAUDE_PLUGIN_ROOT;
    else process.env.CLAUDE_PLUGIN_ROOT = savedPluginRoot;
  });

  it('returns null when nothing is installed', () => {
    expect(resolvePluginRoot(roots)).toBeNull();
  });

  it('finds a cache-only install with no marketplace copy (#3534)', () => {
    const root = writePluginRoot(cacheVersionDir('13.14.0'), { deps: ['zod-free-dep'] });
    expect(resolvePluginRoot(roots)).toEqual({ root, version: '13.14.0', missingDependencies: [] });
  });

  it('ranks by version across cache and marketplace, like the worker spawner', () => {
    writePluginRoot(cacheVersionDir('13.14.0'));
    const marketplaceRoot = writeMarketplace('13.15.0');
    expect(resolvePluginRoot(roots)?.root).toBe(marketplaceRoot);
  });

  it('skips an orphaned cache directory', () => {
    writeFileSync(join(writePluginRoot(cacheVersionDir('13.14.0')), '.orphaned_at'), '2026-08-10T00:00:00Z');
    const older = writePluginRoot(cacheVersionDir('13.13.0'));
    expect(resolvePluginRoot(roots)?.root).toBe(older);
  });

  it('prefers a complete older root over a newer one missing modules (#3604)', () => {
    // A GitHub re-clone bumps the marketplace version, but its plugin/ has no
    // node_modules: spawning from it dies on `Cannot find module`.
    writeMarketplace('13.30.0', { deps: ['better-sqlite-ish', 'yaml'], installed: [] });
    const complete = writePluginRoot(cacheVersionDir('13.29.0'), { deps: ['better-sqlite-ish', 'yaml'] });
    expect(resolvePluginRoot(roots)).toEqual({ root: complete, version: '13.29.0', missingDependencies: [] });
  });

  it('falls back to the highest root when none is complete, and names what is missing', () => {
    const newest = writePluginRoot(cacheVersionDir('13.29.0'), { deps: ['a', 'b'], installed: ['a'] });
    writePluginRoot(cacheVersionDir('13.28.0'), { deps: ['a', 'b'], installed: [] });
    expect(resolvePluginRoot(roots)).toEqual({ root: newest, version: '13.29.0', missingDependencies: ['b'] });
  });

  it('does not rank $CLAUDE_PLUGIN_ROOT: every process gets the one oracle answer', () => {
    const cache = writePluginRoot(cacheVersionDir('13.14.0'));
    process.env.CLAUDE_PLUGIN_ROOT = writePluginRoot(join(base, 'host-injected-root'));
    expect(resolvePluginRoot(roots)?.root).toBe(cache);
  });

  it('honors the CLAUDE_MEM_WORKER_SCRIPT_PATH override', () => {
    writePluginRoot(cacheVersionDir('13.14.0'));
    const devRoot = writePluginRoot(join(base, 'dev', 'plugin'));
    process.env.CLAUDE_MEM_WORKER_SCRIPT_PATH = join(devRoot, 'scripts', 'worker-service.cjs');
    expect(resolvePluginRoot(roots)).toEqual({ root: devRoot, version: null, missingDependencies: [] });
  });
});

describe('findMissingPluginDependencies', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'claude-mem-closure-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function writeZod(subpaths: string[], pluginRoot: string = root): void {
    const zodDir = join(pluginRoot, 'node_modules', 'zod');
    mkdirSync(zodDir, { recursive: true });
    const exportsMap: Record<string, string> = {};
    for (const subpath of subpaths) {
      exportsMap[`./${subpath}`] = `./${subpath}.js`;
      writeFileSync(join(zodDir, `${subpath}.js`), 'module.exports = {};\n');
    }
    writeFileSync(join(zodDir, 'package.json'), JSON.stringify({ name: 'zod', exports: exportsMap }));
  }

  it('treats a root without a readable manifest or declared deps as complete', () => {
    expect(findMissingPluginDependencies(root)).toEqual([]);
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'x' }));
    expect(findMissingPluginDependencies(root)).toEqual([]);
  });

  it('reports scoped and plain dependencies that this tree does not provide', () => {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { '@scope/pkg': '1', plain: '1' } }));
    expect(findMissingPluginDependencies(root)).toEqual(['@scope/pkg', 'plain']);
  });

  it('requires the zod subpaths the worker imports, not just the zod directory', () => {
    // Separate roots: bun caches a failed module lookup for the whole process.
    const broken = join(root, 'broken');
    const healthy = join(root, 'healthy');
    for (const pluginRoot of [broken, healthy]) {
      mkdirSync(pluginRoot, { recursive: true });
      writeFileSync(join(pluginRoot, 'package.json'), JSON.stringify({ dependencies: { zod: '^3' } }));
    }
    writeZod(['v4', 'v4-mini'], broken);
    writeZod(['v3', 'v4', 'v4-mini'], healthy);

    expect(findMissingPluginDependencies(broken)).toEqual(['zod/v3']);
    expect(findMissingPluginDependencies(healthy)).toEqual([]);
  });
});

describe('doctor plugin rows', () => {
  it('names the root and version the worker spawns from', () => {
    expect(pluginRootCheck({ root: '/x/cache/13.29.0', version: '13.29.0', missingDependencies: [] })).toEqual({
      name: 'Plugin installed',
      status: 'ok',
      detail: '/x/cache/13.29.0 (v13.29.0)',
      required: true,
    });
  });

  it('fails an incomplete root and points at repair', () => {
    const row = pluginRootCheck({ root: '/x', version: '1.0.0', missingDependencies: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] });
    expect(row.status).toBe('fail');
    expect(row.detail).toContain('missing a, b, c, d, e, +2 more');
    expect(row.detail).toContain('npx claude-mem repair');
  });

  it('fails with the install hint when nothing is installed', () => {
    expect(pluginRootCheck(null)).toMatchObject({ status: 'fail', detail: 'run `npx claude-mem install`' });
  });

  it('warns, without failing doctor, when the marketplace manifest is missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-mem-manifest-'));
    try {
      expect(marketplaceManifestCheck(dir)).toMatchObject({ status: 'warn', required: false });
      mkdirSync(join(dir, '.claude-plugin'), { recursive: true });
      writeFileSync(join(dir, '.claude-plugin', 'marketplace.json'), '{}');
      expect(marketplaceManifestCheck(dir)).toMatchObject({ status: 'ok' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
