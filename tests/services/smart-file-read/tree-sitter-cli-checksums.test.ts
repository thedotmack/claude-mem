import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  GLIBC_COMPATIBLE_TREE_SITTER_BUILDS,
  glibcCompatibleTreeSitterBuild,
  pinnedTreeSitterExecutableSha256,
  TREE_SITTER_EXECUTABLE_SHA256,
  treeSitterReleaseAssetUrl,
} from '../../../src/services/smart-file-read/tree-sitter-cli-checksums.js';

// Installs get the tree-sitter-cli version plugin/bun.lock pins, and provisioning
// refuses an executable without a pinned digest. A lockfile bump without new
// digests would leave every install without smart_outline and the gate dormant.
describe('pinned tree-sitter executable digests', () => {
  const lockfile = readFileSync(join(import.meta.dir, '..', '..', '..', 'plugin', 'bun.lock'), 'utf-8');
  const lockedVersion = /"tree-sitter-cli": \["tree-sitter-cli@([^"]+)"/.exec(lockfile)?.[1];

  it('covers every platform install.js downloads for, at the version plugin/bun.lock installs', () => {
    expect(lockedVersion).toBeDefined();
    const digests = TREE_SITTER_EXECUTABLE_SHA256[lockedVersion!] ?? {};

    expect(Object.keys(digests).sort()).toEqual([
      'darwin-arm64', 'darwin-x64', 'linux-arm', 'linux-arm64', 'linux-ppc64', 'linux-x64', 'win32-arm64', 'win32-ia32', 'win32-x64',
    ]);
    for (const digest of Object.values(digests)) expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });

  // An installer that ignores bun.lock (npm) resolves the manifest's spec, so a
  // range would let it install a newer release that has no pinned digest.
  it('pins tree-sitter-cli to that exact version in the plugin manifest', () => {
    const manifest = JSON.parse(readFileSync(join(import.meta.dir, '..', '..', '..', 'plugin', 'package.json'), 'utf-8'));

    expect(manifest.dependencies['tree-sitter-cli']).toBe(lockedVersion);
  });

  it('looks the digest up by version, platform and arch', () => {
    expect(pinnedTreeSitterExecutableSha256('0.26.9', 'linux', 'x64')).toBe(TREE_SITTER_EXECUTABLE_SHA256['0.26.9']['linux-x64']);
    expect(pinnedTreeSitterExecutableSha256('0.26.9', 'linux', 'ia32')).toBeUndefined();
    expect(pinnedTreeSitterExecutableSha256('0.0.0', 'linux', 'x64')).toBeUndefined();
  });

  // The direct download fetches the asset install.js would. A platform with a
  // pinned digest and no asset URL could never use it.
  it('names the release asset of every platform it pins a digest for', () => {
    for (const [version, digests] of Object.entries(TREE_SITTER_EXECUTABLE_SHA256)) {
      for (const target of Object.keys(digests)) {
        const [platform, arch] = target.split('-') as [NodeJS.Platform, string];
        expect(treeSitterReleaseAssetUrl(version, platform, arch)).toMatch(
          new RegExp(`^https://github\\.com/tree-sitter/tree-sitter/releases/download/v${version.replace(/\./g, '\\.')}/tree-sitter-(macos|linux|windows)-[a-z0-9]+\\.gz$`),
        );
      }
    }
  });

  // The names are install.js's, not Node's: darwin is macos, ppc64 is powerpc64, ia32 is x86.
  it('uses the asset names install.js downloads', () => {
    const assetOf = (platform: NodeJS.Platform, arch: string) => treeSitterReleaseAssetUrl('0.26.9', platform, arch)?.split('/').pop();

    expect(assetOf('darwin', 'arm64')).toBe('tree-sitter-macos-arm64.gz');
    expect(assetOf('linux', 'ppc64')).toBe('tree-sitter-linux-powerpc64.gz');
    expect(assetOf('win32', 'ia32')).toBe('tree-sitter-windows-x86.gz');
    expect(assetOf('linux', 'riscv64')).toBeUndefined();
  });

  // #4758: the fallback for glibc older than the release assets need. Only the
  // glibc Linux targets conda-forge builds, each pinned twice.
  it('pins each glibc-compatible build by package and executable digest, for released versions only', () => {
    for (const [version, builds] of Object.entries(GLIBC_COMPATIBLE_TREE_SITTER_BUILDS)) {
      expect(TREE_SITTER_EXECUTABLE_SHA256[version]).toBeDefined();
      expect(Object.keys(builds).every((target) => ['linux-arm64', 'linux-x64'].includes(target))).toBe(true);
      for (const build of Object.values(builds)) {
        expect(build.url).toMatch(new RegExp(`^https://conda\\.anaconda\\.org/conda-forge/linux-(64|aarch64)/tree-sitter-cli-${version.replace(/\./g, '\\.')}-[a-z0-9]+_\\d+\\.conda$`));
        expect(build.archiveSha256).toMatch(/^[0-9a-f]{64}$/);
        expect(build.executableSha256).toMatch(/^[0-9a-f]{64}$/);
      }
    }
  });

  it('looks the glibc-compatible build up by version, platform and arch', () => {
    expect(glibcCompatibleTreeSitterBuild('0.26.9', 'linux', 'x64')).toBe(GLIBC_COMPATIBLE_TREE_SITTER_BUILDS['0.26.9']['linux-x64']);
    expect(glibcCompatibleTreeSitterBuild('0.26.9', 'darwin', 'arm64')).toBeUndefined();
    expect(glibcCompatibleTreeSitterBuild('0.0.0', 'linux', 'x64')).toBeUndefined();
  });
});

