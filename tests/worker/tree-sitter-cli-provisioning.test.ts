import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { createHash } from 'crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { provisionTreeSitterCliForPluginRoot } from '../../src/services/worker/tree-sitter-cli-provisioning.js';
import { isTreeSitterCliBinaryUsable, treeSitterCliBinaryPath } from '../../src/services/smart-file-read/tree-sitter-cli-provision.js';
import type { GlibcCompatibleFallback } from '../../src/services/smart-file-read/tree-sitter-cli-provision.js';
import { fakeCondaPackage } from '../helpers/fake-conda-package.js';

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

  // #4758: the release asset links against GLIBC_2.39, so Ubuntu 22.04,
  // Debian 12 and RHEL 9 refuse it. Provisioning then installs the conda-forge
  // build of the same version, pinned by digest. Linux-only: the fallback is
  // only for glibc refusals, and the fakes are shell scripts.
  describe.skipIf(process.platform !== 'linux')('glibc-compatible fallback', () => {
    const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
    // What the OS prints when the release asset needs a newer glibc.
    const refusedForGlibc = Buffer.from(
      "#!/bin/sh\necho \"tree-sitter: /lib/x86_64-linux-gnu/libc.so.6: version \\`GLIBC_2.39' not found (required by tree-sitter)\" >&2\nexit 1\n",
    );
    const glibcCompatible = Buffer.from('#!/bin/sh\necho "tree-sitter 0.26.9 (conda-forge)"\n');
    const condaPackage = fakeCondaPackage(glibcCompatible);
    const URL = 'https://conda.example.invalid/tree-sitter-cli-0.26.9-test_0.conda';

    function fallbackServing(archive: Buffer, pins = { archiveSha256: sha256(condaPackage), executableSha256: sha256(glibcCompatible) }) {
      const downloads: string[] = [];
      const fallback: GlibcCompatibleFallback = {
        buildFor: (version) => (version === '0.26.9' ? { url: URL, ...pins } : undefined),
        download: async (url) => {
          downloads.push(url);
          return archive;
        },
      };
      return { fallback, downloads };
    }

    function writeRefusedReleaseAsset(cliDir: string): string {
      const binaryPath = join(cliDir, TREE_SITTER_BINARY_NAME);
      writeFileSync(binaryPath, refusedForGlibc);
      chmodSync(binaryPath, 0o755);
      return binaryPath;
    }

    it('replaces an intact release asset the OS refuses for its glibc', async () => {
      const cliDir = writeMarketplaceCliPackage("throw new Error('install.js must not run');");
      const binaryPath = writeRefusedReleaseAsset(cliDir);
      const { fallback, downloads } = fallbackServing(condaPackage);

      expect(await provisionTreeSitterCliForPluginRoot(pluginRoot, () => sha256(refusedForGlibc), fallback)).toBe('provisioned');
      expect(downloads).toEqual([URL]);
      expect(readFileSync(binaryPath).equals(glibcCompatible)).toBe(true);
      expect(await isTreeSitterCliBinaryUsable(pluginRoot)).toBe(true);
      // The next worker start finds a working CLI and downloads nothing.
      expect(await provisionTreeSitterCliForPluginRoot(pluginRoot, () => sha256(refusedForGlibc), fallback)).toBe('already-usable');
      expect(downloads).toEqual([URL]);
    });

    it('falls back on a fresh install when the downloaded release asset is refused for its glibc', async () => {
      writeMarketplaceCliPackage([
        `const fs = require('fs');`,
        `const target = require('path').join(process.cwd(), ${JSON.stringify(TREE_SITTER_BINARY_NAME)});`,
        `fs.writeFileSync(target, ${JSON.stringify(refusedForGlibc.toString())});`,
        'fs.chmodSync(target, 0o755);',
      ].join('\n'));
      const { fallback, downloads } = fallbackServing(condaPackage);

      expect(await provisionTreeSitterCliForPluginRoot(pluginRoot, () => sha256(refusedForGlibc), fallback)).toBe('provisioned');
      expect(downloads).toEqual([URL]);
      expect(readFileSync(treeSitterCliBinaryPath(pluginRoot)).equals(glibcCompatible)).toBe(true);
    });

    it('never opens a package whose digest is not the pinned one, and keeps the original error', async () => {
      const cliDir = writeMarketplaceCliPackage("throw new Error('install.js must not run');");
      const binaryPath = writeRefusedReleaseAsset(cliDir);
      const tampered = fakeCondaPackage(Buffer.from('#!/bin/sh\necho "tree-sitter 0.26.9"\ntouch /tmp/pwned\n'));
      const { fallback } = fallbackServing(tampered);

      const rejection = expect(provisionTreeSitterCliForPluginRoot(pluginRoot, () => sha256(refusedForGlibc), fallback)).rejects;
      await rejection.toThrow(/is intact \(SHA-256 matches the pinned value\) but cannot run on this system: .*GLIBC_2\.39/);
      await expect(provisionTreeSitterCliForPluginRoot(pluginRoot, () => sha256(refusedForGlibc), fallback))
        .rejects.toThrow(/could not be installed either: .* not the pinned .*; it was not opened/);
      expect(readFileSync(binaryPath).equals(refusedForGlibc)).toBe(true);
    });

    it('never runs an executable whose digest is not the pinned one', async () => {
      const cliDir = writeMarketplaceCliPackage("throw new Error('install.js must not run');");
      const binaryPath = writeRefusedReleaseAsset(cliDir);
      const { fallback } = fallbackServing(condaPackage, { archiveSha256: sha256(condaPackage), executableSha256: '0'.repeat(64) });

      await expect(provisionTreeSitterCliForPluginRoot(pluginRoot, () => sha256(refusedForGlibc), fallback))
        .rejects.toThrow(/bin\/tree-sitter in .* not the pinned 0{64}; it was not run/);
      expect(readFileSync(binaryPath).equals(refusedForGlibc)).toBe(true);
    });

    it('keeps the original binary and its error when the verified fallback does not run either', async () => {
      const cliDir = writeMarketplaceCliPackage("throw new Error('install.js must not run');");
      const binaryPath = writeRefusedReleaseAsset(cliDir);
      const brokenBuild = Buffer.from("#!/bin/sh\necho 'tree-sitter: cannot open shared object file' >&2\nexit 127\n");
      const brokenPackage = fakeCondaPackage(brokenBuild);
      const { fallback, downloads } = fallbackServing(brokenPackage, {
        archiveSha256: sha256(brokenPackage),
        executableSha256: sha256(brokenBuild),
      });

      await expect(provisionTreeSitterCliForPluginRoot(pluginRoot, () => sha256(refusedForGlibc), fallback))
        .rejects.toThrow(/GLIBC_2\.39.* could not be installed either: the glibc-compatible tree-sitter build does not run either: tree-sitter: cannot open shared object file/);
      expect(downloads).toEqual([URL]);
      // The release asset is untouched and no staging directory is left behind.
      expect(readFileSync(binaryPath).equals(refusedForGlibc)).toBe(true);
      expect(readdirSync(cliDir).filter((entry) => entry.startsWith('.provision-'))).toEqual([]);
    });

    it('does not download a fallback when the refusal is not about glibc', async () => {
      const cliDir = writeMarketplaceCliPackage("throw new Error('install.js must not run');");
      const truncated = readFileSync(REPO_TREE_SITTER_BINARY).subarray(0, 1024);
      const binaryPath = join(cliDir, TREE_SITTER_BINARY_NAME);
      writeFileSync(binaryPath, truncated);
      chmodSync(binaryPath, 0o755);
      const { fallback, downloads } = fallbackServing(condaPackage);

      await expect(provisionTreeSitterCliForPluginRoot(pluginRoot, () => sha256(truncated), fallback))
        .rejects.toThrow(/is intact \(SHA-256 matches the pinned value\) but cannot run on this system/);
      expect(downloads).toEqual([]);
    });

    it('keeps the original error when no fallback build is pinned for this version', async () => {
      const cliDir = writeMarketplaceCliPackage("throw new Error('install.js must not run');");
      writeRefusedReleaseAsset(cliDir);
      const fallback: GlibcCompatibleFallback = {
        buildFor: () => undefined,
        download: async () => { throw new Error('must not download'); },
      };

      await expect(provisionTreeSitterCliForPluginRoot(pluginRoot, () => sha256(refusedForGlibc), fallback))
        .rejects.toThrow(/but cannot run on this system: .*GLIBC_2\.39.*File Read Gate stays off\.$/);
    });
  });
});

