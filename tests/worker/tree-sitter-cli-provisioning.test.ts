import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { provisionTreeSitterCliForPluginRoot } from '../../src/services/worker/tree-sitter-cli-provisioning.js';
import { treeSitterCliBinaryPath } from '../../src/services/smart-file-read/tree-sitter-cli-provision.js';

// Claude Code's marketplace install leaves node_modules/tree-sitter-cli with
// its install.js but no executable (lifecycle scripts off), and the Setup hook
// never fires on install or update. The worker provisions its own plugin root.
describe('worker tree-sitter CLI provisioning', () => {
  const TREE_SITTER_BINARY_NAME = process.platform === 'win32' ? 'tree-sitter.exe' : 'tree-sitter';
  const REPO_TREE_SITTER_BINARY = join(import.meta.dir, '..', '..', 'node_modules', 'tree-sitter-cli', TREE_SITTER_BINARY_NAME);
  let pluginRoot: string;

  beforeEach(() => {
    pluginRoot = mkdtempSync(join(tmpdir(), 'worker-tree-sitter-'));
  });

  afterEach(() => {
    rmSync(pluginRoot, { recursive: true, force: true });
  });

  /** The package as Claude Code's marketplace install leaves it: install.js, no executable. */
  function writeMarketplaceCliPackage(installScript: string): string {
    const cliDir = join(pluginRoot, 'node_modules', 'tree-sitter-cli');
    mkdirSync(cliDir, { recursive: true });
    writeFileSync(join(cliDir, 'package.json'), JSON.stringify({ name: 'tree-sitter-cli', version: '0.26.9' }));
    writeFileSync(join(cliDir, 'install.js'), installScript);
    return cliDir;
  }

  // Like the real install.js: writes the executable into its working directory.
  const downloadingInstallScript = [
    `const fs = require('fs');`,
    `const target = require('path').join(process.cwd(), ${JSON.stringify(TREE_SITTER_BINARY_NAME)});`,
    `fs.copyFileSync(${JSON.stringify(REPO_TREE_SITTER_BINARY)}, target);`,
    process.platform === 'win32' ? '' : 'fs.chmodSync(target, 0o755);',
  ].join('\n');

  it('downloads the executable a marketplace install left out', async () => {
    writeMarketplaceCliPackage(downloadingInstallScript);

    expect(await provisionTreeSitterCliForPluginRoot(pluginRoot)).toBe('provisioned');
    expect(existsSync(treeSitterCliBinaryPath(pluginRoot))).toBe(true);
  });

  it('leaves a working executable alone', async () => {
    const cliDir = writeMarketplaceCliPackage("throw new Error('install.js must not run');");
    copyFileSync(REPO_TREE_SITTER_BINARY, join(cliDir, TREE_SITTER_BINARY_NAME));
    if (process.platform !== 'win32') chmodSync(join(cliDir, TREE_SITTER_BINARY_NAME), 0o755);

    expect(await provisionTreeSitterCliForPluginRoot(pluginRoot)).toBe('already-usable');
  });

  it('has nothing to provision without the tree-sitter-cli package', async () => {
    expect(await provisionTreeSitterCliForPluginRoot(pluginRoot)).toBe('no-package');
  });

  it('rejects when the download fails, so the worker logs it and the next start retries', async () => {
    writeMarketplaceCliPackage("console.error('release asset unavailable'); process.exitCode = 1;");

    await expect(provisionTreeSitterCliForPluginRoot(pluginRoot)).rejects.toMatchObject({ code: 1 });
    expect(existsSync(treeSitterCliBinaryPath(pluginRoot))).toBe(false);
  });
});
