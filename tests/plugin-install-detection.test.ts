import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { isPluginInstalled, marketplaceDirectory } from '../src/npx-cli/utils/paths.js';
import { hasInstallArtifacts } from '../src/npx-cli/commands/uninstall.js';

// A real install lands both the marketplace root manifest and the nested
// plugin.json. Before #3656 the installer shipped only the nested plugin.json,
// so Claude Code cache-missed on plugin load while isPluginInstalled() — and
// therefore install, repair, and doctor — still reported success.
describe('isPluginInstalled marketplace-manifest guard (#3656)', () => {
  let tempDir: string;
  let originalConfigDir: string | undefined;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'claude-mem-install-detection-'));
    originalConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = tempDir;
  });

  afterEach(() => {
    if (originalConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = originalConfigDir;
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  function writeNestedPluginJson(): void {
    const nested = join(marketplaceDirectory(), 'plugin', '.claude-plugin');
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, 'plugin.json'), '{}');
  }

  function writeMarketplaceManifest(): void {
    const root = join(marketplaceDirectory(), '.claude-plugin');
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'marketplace.json'), '{}');
  }

  it('reports not-installed when the marketplace root manifest is missing', () => {
    writeNestedPluginJson();
    expect(isPluginInstalled()).toBe(false);
  });

  it('reports not-installed when the nested plugin.json is missing', () => {
    writeMarketplaceManifest();
    expect(isPluginInstalled()).toBe(false);
  });

  it('reports installed only when both manifests are present', () => {
    writeNestedPluginJson();
    writeMarketplaceManifest();
    expect(isPluginInstalled()).toBe(true);
  });

  // Uninstall must not inherit the stricter health check: a legacy install with
  // only the nested manifest still has artifacts to clean up, so a
  // non-interactive uninstall must not early-exit (#3656).
  it('hasInstallArtifacts stays true for a legacy install the health check rejects', () => {
    writeNestedPluginJson();
    expect(isPluginInstalled()).toBe(false);
    expect(hasInstallArtifacts()).toBe(true);
  });

  it('hasInstallArtifacts is false only when nothing is left behind', () => {
    expect(hasInstallArtifacts()).toBe(false);
  });
});
