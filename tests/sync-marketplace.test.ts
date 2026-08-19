import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';

function repoPath(...parts: string[]): string {
  return join(__dirname, '..', ...parts);
}

describe('sync-marketplace install markers', () => {
  it('rewrites marketplace and cache install markers after sync deletes unmanaged files', () => {
    const home = mkdtempSync(join(tmpdir(), 'claude-mem-sync-home-'));
    const pluginJson = JSON.parse(
      readFileSync(repoPath('plugin', '.claude-plugin', 'plugin.json'), 'utf-8'),
    ) as { version: string };
    const marketplaceRoot = join(home, '.claude', 'plugins', 'marketplaces', 'thedotmack');
    const marketplacePlugin = join(marketplaceRoot, 'plugin');
    const cacheDir = join(home, '.claude', 'plugins', 'cache', 'thedotmack', 'claude-mem', pluginJson.version);

    try {
      mkdirSync(marketplacePlugin, { recursive: true });
      mkdirSync(cacheDir, { recursive: true });
      writeFileSync(join(marketplacePlugin, '.install-version'), '{"version":"0.0.0"}\n');
      writeFileSync(join(cacheDir, '.install-version'), '{"version":"0.0.0"}\n');

      const result = spawnSync(process.execPath, [repoPath('scripts', 'sync-marketplace.cjs')], {
        cwd: repoPath(),
        env: {
          ...process.env,
          HOME: home,
          CLAUDE_MEM_SYNC_SKIP_INSTALL: '1',
        },
        encoding: 'utf-8',
      });

      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);

      const marketplaceMarker = JSON.parse(readFileSync(join(marketplacePlugin, '.install-version'), 'utf-8'));
      const cacheMarker = JSON.parse(readFileSync(join(cacheDir, '.install-version'), 'utf-8'));

      for (const marker of [marketplaceMarker, cacheMarker]) {
        expect(marker.version).toBe(pluginJson.version);
        expect(typeof marker.bun).toBe('string');
        expect(typeof marker.uv).toBe('string');
        expect(() => new Date(marker.installedAt).toISOString()).not.toThrow();
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
