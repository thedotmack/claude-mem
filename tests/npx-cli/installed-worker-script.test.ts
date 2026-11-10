import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { installedWorkerScriptPath } from '../../src/npx-cli/commands/install.js';

/**
 * #5601: the installer started the worker from the marketplace clone whenever
 * it existed, but `bun install` runs only in the plugin cache copy. A worker
 * started from the clone had no node_modules, so Bun auto-installed sharp's
 * wasm build and the worker froze on its first image.
 */
describe('installedWorkerScriptPath', () => {
  const made: string[] = [];
  afterEach(() => { for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true }); });

  const layout = (withCacheScript: boolean, withMarketplaceScript: boolean) => {
    const root = mkdtempSync(join(tmpdir(), 'cmem-installed-worker-'));
    made.push(root);
    const cacheDirectory = join(root, 'cache', 'thedotmack', 'claude-mem', '15.13.1');
    const marketplaceDirectory = join(root, 'marketplaces', 'thedotmack');
    const cacheScript = join(cacheDirectory, 'scripts', 'worker-service.cjs');
    const marketplaceScript = join(marketplaceDirectory, 'plugin', 'scripts', 'worker-service.cjs');
    for (const [present, script] of [[withCacheScript, cacheScript], [withMarketplaceScript, marketplaceScript]] as const) {
      if (!present) continue;
      mkdirSync(join(script, '..'), { recursive: true });
      writeFileSync(script, '');
    }
    return { locations: { cacheDirectory, marketplaceDirectory }, cacheScript, marketplaceScript };
  };

  it('starts the cache copy, where the installer ran bun install, even when the marketplace clone exists', () => {
    const { locations, cacheScript } = layout(true, true);
    expect(installedWorkerScriptPath('15.13.1', locations)).toBe(cacheScript);
  });

  it('falls back to the marketplace copy only when the cache has no worker', () => {
    const { locations, marketplaceScript } = layout(false, true);
    expect(installedWorkerScriptPath('15.13.1', locations)).toBe(marketplaceScript);
  });
});
