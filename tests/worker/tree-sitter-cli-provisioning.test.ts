import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { createHash } from 'crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { provisionTreeSitterCliForPluginRoot } from '../../src/services/worker/tree-sitter-cli-provisioning.js';
import { isTreeSitterCliBinaryUsable, treeSitterCliBinaryPath } from '../../src/services/smart-file-read/tree-sitter-cli-provision.js';

// Claude Code's marketplace install leaves node_modules/tree-sitter-cli with
// its install.js but no executable (lifecycle scripts off), and the Setup hook
// never fires on install or update. The worker provisions its own plugin root.
describe('worker tree-sitter CLI provisioning', () => {
  const TREE_SITTER_BINARY_NAME = process.platform === 'win32' ? 'tree-sitter.exe' : 'tree-sitter';
  const REPO_TREE_SITTER_BINARY = join(import.meta.dir, '..', '..', 'node_modules', 'tree-sitter-cli', TREE_SITTER_BINARY_NAME);
  // The fake download is the repo's own tree-sitter build, so pin its digest.
  const pinRepoBinary = () => createHash('sha256').update(readFileSync(REPO_TREE_SITTER_BINARY)).digest('hex');
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

    expect(await provisionTreeSitterCliForPluginRoot(pluginRoot, pinRepoBinary)).toBe('provisioned');
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

    await expect(provisionTreeSitterCliForPluginRoot(pluginRoot, pinRepoBinary)).rejects.toMatchObject({ code: 1 });
    expect(existsSync(treeSitterCliBinaryPath(pluginRoot))).toBe(false);
  });

  it('re-downloads when the existing executable is corrupt (SHA mismatch)', async () => {
    const cliDir = writeMarketplaceCliPackage(downloadingInstallScript);
    // Garbage bytes: intact check fails on the SHA, so the download path runs.
    writeFileSync(join(cliDir, TREE_SITTER_BINARY_NAME), Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x99]));

    expect(await provisionTreeSitterCliForPluginRoot(pluginRoot, pinRepoBinary)).toBe('provisioned');
    expect(await isTreeSitterCliBinaryUsable(pluginRoot)).toBe(true);
  });

  // #4758: the executable is intact (matches the pinned SHA-256) but the OS
  // cannot run it (e.g. linked against a newer glibc). Downloading the same
  // release asset again cannot help, so provisioning fails fast with the real
  // reason instead of burning a download on every worker start.
  it('fails fast with the reason when the intact executable cannot run (no re-download)', async () => {
    const cliDir = writeMarketplaceCliPackage("throw new Error('install.js must not run');");
    const intactButBroken = readFileSync(REPO_TREE_SITTER_BINARY).subarray(0, 1024);
    const binaryPath = join(cliDir, TREE_SITTER_BINARY_NAME);
    writeFileSync(binaryPath, intactButBroken);
    if (process.platform !== 'win32') chmodSync(binaryPath, 0o755);
    const pinTruncated = () => createHash('sha256').update(intactButBroken).digest('hex');

    await expect(provisionTreeSitterCliForPluginRoot(pluginRoot, pinTruncated))
      .rejects.toThrow(/is intact \(SHA-256 matches the pinned value\) but cannot run on this system/);
    // The binary is untouched: no download was attempted.
    expect(readFileSync(binaryPath).equals(intactButBroken)).toBe(true);
  });

  it('fails fast when the binary is absent but the package version has no pinned SHA', async () => {
    writeMarketplaceCliPackage("throw new Error('install.js must not run');");

    await expect(provisionTreeSitterCliForPluginRoot(pluginRoot, () => undefined))
      .rejects.toThrow(/No SHA-256 is pinned/);
  });

  // Greptile P1 on #4777: a copied/restored binary can lose its executable bit
  // while keeping a matching SHA-256. That is repairable (the download restores
  // 755), so it must fall through to the download, not fail fast. POSIX-only:
  // Windows has no exec bit to lose.
  it.skipIf(process.platform === 'win32')('re-downloads when the intact executable merely lost its executable bit', async () => {
    const cliDir = writeMarketplaceCliPackage(downloadingInstallScript);
    const binaryPath = join(cliDir, TREE_SITTER_BINARY_NAME);
    copyFileSync(REPO_TREE_SITTER_BINARY, binaryPath);
    chmodSync(binaryPath, 0o644);
    const pinIntact = () => createHash('sha256').update(readFileSync(binaryPath)).digest('hex');

    expect(await provisionTreeSitterCliForPluginRoot(pluginRoot, pinIntact)).toBe('provisioned');
    expect(await isTreeSitterCliBinaryUsable(pluginRoot)).toBe(true);
  });
});
