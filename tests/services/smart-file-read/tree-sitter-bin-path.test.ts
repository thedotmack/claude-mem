import { afterAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { resolveDataDir } from '../../../src/shared/paths.js';
import { treeSitterBinaryName } from '../../../src/services/smart-file-read/tree-sitter-bin-name.js';
import { isTreeSitterCliAvailable } from '../../../src/services/smart-file-read/tree-sitter-bin-path.js';

// The File Read Gate denies a whole-file Read only where smart_outline can
// parse (plan D9). resolveTreeSitterBinPath answers an absolute path when
// tree-sitter-cli's downloaded binary exists, and the bare binary name when it
// does not (package missing, or installed without its binary), which the
// parser then runs from PATH.
//
// tests/preload.ts pins CLAUDE_MEM_DATA_DIR to a per-run temp dir; the fake
// install and PATH directories live under it.
mkdirSync(resolveDataDir(), { recursive: true });
const scratchRoot = mkdtempSync(join(resolveDataDir(), 'tree-sitter-bin-path-'));
const binaryName = treeSitterBinaryName();

afterAll(() => {
  rmSync(scratchRoot, { recursive: true, force: true });
});

describe('isTreeSitterCliAvailable', () => {
  it('is true for a resolved absolute path that exists', () => {
    const packageDir = join(scratchRoot, 'node_modules', 'tree-sitter-cli');
    mkdirSync(packageDir, { recursive: true });
    const binaryPath = join(packageDir, binaryName);
    writeFileSync(binaryPath, '');

    expect(isTreeSitterCliAvailable(binaryPath, '')).toBe(true);
  });

  it('is false for a resolved absolute path that does not exist', () => {
    expect(isTreeSitterCliAvailable(join(scratchRoot, 'missing-package', binaryName), '')).toBe(false);
  });

  it('is false when the package is missing (bare name) and PATH is empty', () => {
    expect(isTreeSitterCliAvailable(binaryName, '')).toBe(false);
  });

  it('is false when no PATH directory holds the bare name', () => {
    const emptyBinDir = join(scratchRoot, 'empty-bin');
    mkdirSync(emptyBinDir, { recursive: true });

    expect(isTreeSitterCliAvailable(binaryName, [emptyBinDir, join(scratchRoot, 'no-such-dir')].join(delimiter))).toBe(false);
  });

  it('is true when a PATH directory holds the bare name', () => {
    const pathBinDir = join(scratchRoot, 'path-bin');
    mkdirSync(pathBinDir, { recursive: true });
    writeFileSync(join(pathBinDir, binaryName), '');

    expect(isTreeSitterCliAvailable(binaryName, [join(scratchRoot, 'no-such-dir'), pathBinDir].join(delimiter))).toBe(true);
  });
});
