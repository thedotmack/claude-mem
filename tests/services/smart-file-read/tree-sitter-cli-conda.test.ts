import { describe, it, expect } from 'bun:test';
import { treeSitterExecutableFromCondaPackage } from '../../../src/services/smart-file-read/tree-sitter-cli-conda.js';
import { fakeCondaPackage, tarOf, zipOf } from '../../helpers/fake-conda-package.js';

// The glibc-compatible tree-sitter build ships as a conda-forge package (#4758).
describe('reading bin/tree-sitter out of a .conda package', () => {
  const executable = Buffer.from('#!/bin/sh\necho "tree-sitter 0.26.9"\n');

  it('returns the executable bytes from pkg-*.tar.zst', () => {
    expect(treeSitterExecutableFromCondaPackage(fakeCondaPackage(executable)).equals(executable)).toBe(true);
  });

  it('finds the executable after other files in the tarball, past their padding', () => {
    const pkg = Buffer.from(Bun.zstdCompressSync(tarOf({
      'info/about.json': Buffer.alloc(700, 0x61),
      'bin/tree-sitter': executable,
    })));
    const archive = zipOf({ 'pkg-tree-sitter-cli-0.26.9-test_0.tar.zst': pkg });

    expect(treeSitterExecutableFromCondaPackage(archive).equals(executable)).toBe(true);
  });

  it('rejects a file that is not a zip', () => {
    expect(() => treeSitterExecutableFromCondaPackage(Buffer.from('<html>not found</html>')))
      .toThrow(/not a zip archive/);
  });

  it('rejects a package without a pkg tarball', () => {
    expect(() => treeSitterExecutableFromCondaPackage(zipOf({ 'metadata.json': Buffer.from('{}') })))
      .toThrow(/no pkg-\*\.tar\.zst entry/);
  });

  it('rejects a deflated pkg entry instead of misreading it', () => {
    const pkg = Buffer.from(Bun.zstdCompressSync(tarOf({ 'bin/tree-sitter': executable })));
    const name = 'pkg-tree-sitter-cli-0.26.9-test_0.tar.zst';

    expect(() => treeSitterExecutableFromCondaPackage(zipOf({ [name]: pkg }, [name])))
      .toThrow(/is compressed \(method 8\), expected stored/);
  });

  it('rejects a pkg tarball without bin/tree-sitter', () => {
    const pkg = Buffer.from(Bun.zstdCompressSync(tarOf({ 'bin/other': executable })));

    expect(() => treeSitterExecutableFromCondaPackage(zipOf({ 'pkg-x.tar.zst': pkg })))
      .toThrow(/no bin\/tree-sitter/);
  });
});
