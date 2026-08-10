import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { isPluginInstalled, resolvePluginRoot } from '../../src/npx-cli/utils/paths.js';

/**
 * `resolvePluginRoot()` must match how the runtime hooks resolve the plugin
 * (plugin/hooks/hooks.json): $CLAUDE_PLUGIN_ROOT first, then the newest
 * non-orphaned versioned cache directory, then the marketplace copy. A cache
 * install the hooks run from must not read as "not installed" (#3534).
 */
describe('resolvePluginRoot', () => {
  let configDir: string;
  const savedConfig = process.env.CLAUDE_CONFIG_DIR;
  const savedPluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
  const savedPluginRootAlt = process.env.PLUGIN_ROOT;

  function writePluginJson(root: string): string {
    mkdirSync(join(root, '.claude-plugin'), { recursive: true });
    writeFileSync(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'claude-mem' }));
    return root;
  }

  function cacheVersionDir(version: string): string {
    return join(configDir, 'plugins', 'cache', 'thedotmack', 'claude-mem', version);
  }

  function marketplacePluginDir(): string {
    return join(configDir, 'plugins', 'marketplaces', 'thedotmack', 'plugin');
  }

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), 'claude-mem-paths-'));
    process.env.CLAUDE_CONFIG_DIR = configDir;
    delete process.env.CLAUDE_PLUGIN_ROOT;
    delete process.env.PLUGIN_ROOT;
  });

  afterEach(() => {
    rmSync(configDir, { recursive: true, force: true });
    if (savedConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = savedConfig;
    if (savedPluginRoot === undefined) delete process.env.CLAUDE_PLUGIN_ROOT;
    else process.env.CLAUDE_PLUGIN_ROOT = savedPluginRoot;
    if (savedPluginRootAlt === undefined) delete process.env.PLUGIN_ROOT;
    else process.env.PLUGIN_ROOT = savedPluginRootAlt;
  });

  it('returns null and reports not installed when nothing is present', () => {
    expect(resolvePluginRoot()).toBeNull();
    expect(isPluginInstalled()).toBe(false);
  });

  it('finds the marketplace copy when only it is present', () => {
    const root = writePluginJson(marketplacePluginDir());
    expect(resolvePluginRoot()).toBe(root);
    expect(isPluginInstalled()).toBe(true);
  });

  it('finds a cache install with no marketplace copy', () => {
    const root = writePluginJson(cacheVersionDir('13.14.0'));
    expect(resolvePluginRoot()).toBe(root);
    expect(isPluginInstalled()).toBe(true);
  });

  it('prefers the cache install over the marketplace copy', () => {
    writePluginJson(marketplacePluginDir());
    const cacheRoot = writePluginJson(cacheVersionDir('13.14.0'));
    expect(resolvePluginRoot()).toBe(cacheRoot);
  });

  it('prefers the newest version and stable over pre-release', () => {
    writePluginJson(cacheVersionDir('13.13.0'));
    writePluginJson(cacheVersionDir('13.14.0-beta.1'));
    const newest = writePluginJson(cacheVersionDir('13.14.0'));
    expect(resolvePluginRoot()).toBe(newest);
  });

  it('skips an orphaned cache directory', () => {
    const orphaned = writePluginJson(cacheVersionDir('13.14.0'));
    writeFileSync(join(orphaned, '.orphaned_at'), '2026-08-10T00:00:00Z');
    const older = writePluginJson(cacheVersionDir('13.13.0'));
    expect(resolvePluginRoot()).toBe(older);
  });

  it('honors $CLAUDE_PLUGIN_ROOT ahead of cache and marketplace', () => {
    writePluginJson(cacheVersionDir('13.14.0'));
    writePluginJson(marketplacePluginDir());
    const envRoot = writePluginJson(join(configDir, 'custom-root'));
    process.env.CLAUDE_PLUGIN_ROOT = envRoot;
    expect(resolvePluginRoot()).toBe(envRoot);
  });
});
