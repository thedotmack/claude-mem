import { afterEach, describe, expect, it } from 'bun:test';
import { dirname, join } from 'node:path';
import {
  getTreeSitterBin,
  resetTreeSitterBinCacheForTests,
  setTreeSitterBinDepsForTests,
} from '../../../src/services/smart-file-read/parser.js';

describe('tree-sitter binary resolution', () => {
  const fakePackageJsonPath = join('C:', 'repo', 'node_modules', 'tree-sitter-cli', 'package.json');

  afterEach(() => {
    resetTreeSitterBinCacheForTests();
    setTreeSitterBinDepsForTests();
  });

  it('prefers package-local tree-sitter.exe on Windows', () => {
    setTreeSitterBinDepsForTests({
      platform: 'win32',
      resolvePackageJson: (id: string) => {
        if (id === 'tree-sitter-cli/package.json') return fakePackageJsonPath;
        throw new Error(`unexpected resolve: ${id}`);
      },
      fileExists: (candidatePath: string) => {
        return candidatePath === join(dirname(fakePackageJsonPath), 'tree-sitter.exe');
      },
    });

    expect(getTreeSitterBin()).toBe(join(dirname(fakePackageJsonPath), 'tree-sitter.exe'));
  });

  it('falls back to PATH when no package-local binary exists', () => {
    setTreeSitterBinDepsForTests({
      platform: 'win32',
      resolvePackageJson: () => fakePackageJsonPath,
      fileExists: () => false,
    });

    expect(getTreeSitterBin()).toBe('tree-sitter');
  });

  it('uses the bare tree-sitter name on non-Windows platforms', () => {
    const fakeUnixPackageJsonPath = join('/repo', 'node_modules', 'tree-sitter-cli', 'package.json');
    setTreeSitterBinDepsForTests({
      platform: 'linux',
      resolvePackageJson: () => fakeUnixPackageJsonPath,
      fileExists: (candidatePath: string) => {
        expect(candidatePath.endsWith('tree-sitter.exe')).toBe(false);
        return candidatePath === join(dirname(fakeUnixPackageJsonPath), 'tree-sitter');
      },
    });

    expect(getTreeSitterBin()).toBe(join(dirname(fakeUnixPackageJsonPath), 'tree-sitter'));
  });
});
