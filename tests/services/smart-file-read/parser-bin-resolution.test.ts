import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { selectTreeSitterBinary } from '../../../src/shared/tree-sitter-binary';

describe('tree-sitter package-local binary selection', () => {
  let pkgDir: string;

  beforeEach(() => {
    pkgDir = join(tmpdir(), `tree-sitter-bin-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(pkgDir, { recursive: true });
  });

  afterEach(() => rmSync(pkgDir, { recursive: true, force: true }));

  it('selects the existing Windows executable', () => {
    const exe = join(pkgDir, 'tree-sitter.exe');
    writeFileSync(exe, '');
    expect(selectTreeSitterBinary(pkgDir, 'win32')).toBe(exe);
    expect(existsSync(selectTreeSitterBinary(pkgDir, 'win32')!)).toBe(true);
  });

  it('keeps the extensionless Windows workaround', () => {
    const binary = join(pkgDir, 'tree-sitter');
    writeFileSync(binary, '');
    expect(selectTreeSitterBinary(pkgDir, 'win32')).toBe(binary);
  });

  it('selects only the extensionless binary off Windows', () => {
    writeFileSync(join(pkgDir, 'tree-sitter.exe'), '');
    expect(selectTreeSitterBinary(pkgDir, 'linux')).toBeNull();
    writeFileSync(join(pkgDir, 'tree-sitter'), '');
    expect(selectTreeSitterBinary(pkgDir, 'linux')).toBe(join(pkgDir, 'tree-sitter'));
  });

  it('ignores candidate paths that are directories', () => {
    mkdirSync(join(pkgDir, 'tree-sitter.exe'));
    mkdirSync(join(pkgDir, 'tree-sitter'));
    expect(selectTreeSitterBinary(pkgDir, 'win32')).toBeNull();
    expect(selectTreeSitterBinary(pkgDir, 'linux')).toBeNull();
  });
});
