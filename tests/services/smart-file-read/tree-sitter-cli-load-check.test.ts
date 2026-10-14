import { describe, expect, it, afterAll } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { resolveDataDir } from '../../../src/shared/paths.js';
import { treeSitterBinaryName } from '../../../src/services/smart-file-read/tree-sitter-bin-name.js';
import { checkTreeSitterCliLoadable } from '../../../src/services/smart-file-read/tree-sitter-bin-path.js';

// #4758: existsSync is not enough — a tree-sitter CLI binary can be present
// yet unable to run (e.g. linked against GLIBC_2.39 on Ubuntu 22.04's glibc
// 2.35). checkTreeSitterCliLoadable answers whether the binary actually
// executes; the File Read Gate and the MCP smart_* handlers use it to report
// the real cause instead of the misleading "unsupported language" fallbacks.
//
// tests/preload.ts pins CLAUDE_MEM_DATA_DIR to a per-run temp dir; the fake
// install and PATH directories live under it.
mkdirSync(resolveDataDir(), { recursive: true });
const scratchRoot = mkdtempSync(join(resolveDataDir(), 'tree-sitter-load-check-'));
const binaryName = treeSitterBinaryName();

afterAll(() => {
  rmSync(scratchRoot, { recursive: true, force: true });
});

describe('checkTreeSitterCliLoadable', () => {
  it('is not present for a path that does not exist', () => {
    const check = checkTreeSitterCliLoadable(join(scratchRoot, 'nope', binaryName));
    expect(check.present).toBe(false);
    expect(check.loadable).toBe(false);
    expect(typeof check.reason).toBe("string");
  });

  it('is present but not loadable when the binary runs yet is not tree-sitter', () => {
    // process.execPath answers --version, just not as tree-sitter: the
    // cross-platform "runs but wrong" fake.
    const check = checkTreeSitterCliLoadable(process.execPath);
    expect(check.present).toBe(true);
    expect(check.loadable).toBe(false);
    expect(check.reason).toContain('did not answer --version');
  });

  it('is present but not loadable for garbage bytes', () => {
    const binPath = join(scratchRoot, 'garbage', binaryName);
    mkdirSync(join(scratchRoot, 'garbage'), { recursive: true });
    writeFileSync(binPath, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x99, 0x88]));

    const check = checkTreeSitterCliLoadable(binPath);
    expect(check.present).toBe(true);
    expect(check.loadable).toBe(false);
    expect(typeof check.reason).toBe("string");
  });

  it('is not present when a bare name is on no PATH directory', () => {
    const check = checkTreeSitterCliLoadable('definitely-not-a-real-binary-4758', join(scratchRoot, 'empty'));
    expect(check.present).toBe(false);
    expect(check.loadable).toBe(false);
  });

  it('caches the probe per binary (same object on repeat calls)', () => {
    const check1 = checkTreeSitterCliLoadable(process.execPath);
    const check2 = checkTreeSitterCliLoadable(process.execPath);
    expect(check2).toBe(check1);
  });

  it('re-probes when the binary is replaced (mtime change)', () => {
    const dir = join(scratchRoot, 'replaced');
    mkdirSync(dir, { recursive: true });
    const binPath = join(dir, binaryName);
    writeFileSync(binPath, 'first');

    const before = checkTreeSitterCliLoadable(binPath);
    writeFileSync(binPath, 'second');
    // Force a distinct mtime: same-millisecond rewrites must not look cached.
    const mtime = new Date(Date.now() + 5000);
    utimesSync(binPath, mtime, mtime);

    const after = checkTreeSitterCliLoadable(binPath);
    expect(after).not.toBe(before);
  });
});

// Executable fakes need a POSIX shell; the garbage-bytes and execPath cases
// above already cover present-but-broken cross-platform.
describe.skipIf(process.platform === 'win32')('checkTreeSitterCliLoadable with executable fakes', () => {
  function writeExecutable(dir: string, name: string, script: string): string {
    mkdirSync(dir, { recursive: true });
    const binPath = join(dir, name);
    writeFileSync(binPath, `#!/bin/sh\n${script}\n`);
    chmodSync(binPath, 0o755);
    return binPath;
  }

  it('is loadable for a binary that answers --version as tree-sitter', () => {
    const binPath = writeExecutable(join(scratchRoot, 'working'), binaryName, 'echo "tree-sitter 0.26.9"');

    const check = checkTreeSitterCliLoadable(binPath);
    expect(check.present).toBe(true);
    expect(check.loadable).toBe(true);
    expect(check.reason).toBeUndefined();
  });

  it('is present but not loadable when --version fails, and the reason carries stderr', () => {
    const binPath = writeExecutable(
      join(scratchRoot, 'broken'),
      binaryName,
      'echo \'tree-sitter: /lib/x86_64-linux-gnu/libc.so.6: version GLIBC_2.39 not found (required by tree-sitter)\' >&2\nexit 1',
    );

    const check = checkTreeSitterCliLoadable(binPath);
    expect(check.present).toBe(true);
    expect(check.loadable).toBe(false);
    expect(check.reason).toContain('GLIBC_2.39');
    expect(check.reason).toContain('could not be executed');
  });

  it('resolves a bare name through PATH and probes the found binary', () => {
    const pathBinDir = join(scratchRoot, 'path-bin');
    writeExecutable(pathBinDir, binaryName, 'echo "tree-sitter 0.26.9"');

    const check = checkTreeSitterCliLoadable(
      binaryName,
      [join(scratchRoot, 'no-such-dir'), pathBinDir].join(delimiter),
    );
    expect(check.present).toBe(true);
    expect(check.loadable).toBe(true);
  });
});
