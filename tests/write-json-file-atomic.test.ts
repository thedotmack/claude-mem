import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { IS_WINDOWS, writeJsonFileAtomic } from '../src/npx-cli/utils/paths.js';

/**
 * Tests for writeJsonFileAtomic's crash-safe semantics.
 *
 * Per CodeRabbit on PR #2281: the prior implementation was a single
 * writeFileSync call that could leave a truncated/corrupt file on a mid-write
 * crash — relevant because callers include disableClaudeAutoMemory's write to
 * ~/.claude/settings.json (a user-owned global config).
 *
 * The new implementation uses temp file + fsync + rename. These tests verify
 * that contract.
 */

describe('writeJsonFileAtomic', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'claude-mem-atomic-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('writes JSON to the destination path with a trailing newline', () => {
    const target = join(tempDir, 'config.json');
    writeJsonFileAtomic(target, { foo: 'bar', n: 1 });
    const raw = readFileSync(target, 'utf-8');
    expect(raw).toBe('{\n  "foo": "bar",\n  "n": 1\n}\n');
  });

  it('replaces existing content without leaving a temp file behind', () => {
    const target = join(tempDir, 'config.json');
    writeJsonFileAtomic(target, { v: 1 });
    writeJsonFileAtomic(target, { v: 2 });
    expect(JSON.parse(readFileSync(target, 'utf-8'))).toEqual({ v: 2 });

    // No leftover .tmp files should remain in the directory.
    const leftovers = readdirSync(tempDir).filter(name => name.endsWith('.tmp'));
    expect(leftovers).toEqual([]);
  });

  it('creates parent directories when they do not exist', () => {
    const target = join(tempDir, 'nested', 'deeper', 'config.json');
    writeJsonFileAtomic(target, { ok: true });
    expect(JSON.parse(readFileSync(target, 'utf-8'))).toEqual({ ok: true });
  });

  it('preserves the destination file mode when the file already exists', () => {
    const target = join(tempDir, 'restricted.json');
    writeFileSync(target, '{}', { mode: 0o600 });
    chmodSync(target, 0o600); // Force-apply in case umask interfered.

    writeJsonFileAtomic(target, { secret: true });

    const mode = statSync(target).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('writes the temp file in the same directory as the destination', () => {
    // Same-directory rename is what gives the atomic guarantee on POSIX
    // (cross-filesystem rename can fall back to copy+delete, which isn't atomic).
    // We verify by spotting the temp file name pattern during a write — but since
    // the write completes synchronously, we infer this from the absence of any
    // leftover temp file in OTHER directories after a normal write.
    const otherDir = mkdtempSync(join(tmpdir(), 'claude-mem-atomic-other-'));
    try {
      const target = join(tempDir, 'config.json');
      writeJsonFileAtomic(target, { ok: true });

      // No temp file should have been created in tmpdir, otherDir, or anywhere
      // outside the destination directory.
      const otherLeftovers = readdirSync(otherDir).filter(name => name.includes('config.json'));
      expect(otherLeftovers).toEqual([]);
      const tempDirLeftovers = readdirSync(tempDir).filter(name => name.endsWith('.tmp'));
      expect(tempDirLeftovers).toEqual([]);
    } finally {
      rmSync(otherDir, { recursive: true, force: true });
    }
  });

  it('throws on serialization failure without creating a temp file', () => {
    // A circular structure makes JSON.stringify throw before openSync runs,
    // so no temp file should ever appear in the destination directory.
    const target = join(tempDir, 'config.json');
    const circular: any = { a: 1 };
    circular.self = circular;

    expect(() => writeJsonFileAtomic(target, circular)).toThrow();

    const leftovers = readdirSync(tempDir).filter(name => name.endsWith('.tmp'));
    expect(leftovers).toEqual([]);
  });

  it('writes through a symlinked destination instead of replacing the link', () => {
    if (IS_WINDOWS) {
      // Symlink creation requires elevated privileges on Windows; skip there.
      return;
    }
    // Users who keep ~/.claude/settings.json under a dotfiles repo often
    // symlink it. POSIX rename(2) replaces the symlink with the temp file,
    // which would silently break the link — verify we resolve it instead.
    const realDir = mkdtempSync(join(tmpdir(), 'claude-mem-real-'));
    try {
      const realTarget = join(realDir, 'real-config.json');
      writeFileSync(realTarget, '{"v":0}');
      const linkPath = join(tempDir, 'config.json');
      symlinkSync(realTarget, linkPath);

      writeJsonFileAtomic(linkPath, { v: 42 });

      // Underlying file is updated.
      expect(JSON.parse(readFileSync(realTarget, 'utf-8'))).toEqual({ v: 42 });
      // Symlink is preserved (not clobbered into a regular file).
      expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);
      // And it still resolves to the same realpath.
      expect(realpathSync(linkPath)).toBe(realpathSync(realTarget));
      // Temp file landed next to the real target, not at the symlink site.
      const realDirLeftovers = readdirSync(realDir).filter(name => name.endsWith('.tmp'));
      expect(realDirLeftovers).toEqual([]);
      const tempDirLeftovers = readdirSync(tempDir).filter(name => name.endsWith('.tmp'));
      expect(tempDirLeftovers).toEqual([]);
    } finally {
      rmSync(realDir, { recursive: true, force: true });
    }
  });

  it('writes through a dangling symlink destination instead of replacing the link', () => {
    if (IS_WINDOWS) {
      // Symlink creation requires elevated privileges on Windows; skip there.
      return;
    }

    const linkTarget = join('dotfiles', 'settings.json');
    const realTarget = join(tempDir, linkTarget);
    const linkPath = join(tempDir, 'settings.json');
    symlinkSync(linkTarget, linkPath);

    writeJsonFileAtomic(linkPath, { env: { CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' } });

    expect(JSON.parse(readFileSync(realTarget, 'utf-8'))).toEqual({
      env: { CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' },
    });
    expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);
    expect(realpathSync(linkPath)).toBe(realpathSync(realTarget));
    const tempDirLeftovers = readdirSync(tempDir).filter(name => name.endsWith('.tmp'));
    expect(tempDirLeftovers).toEqual([]);
    const realDirLeftovers = readdirSync(join(tempDir, 'dotfiles')).filter(name => name.endsWith('.tmp'));
    expect(realDirLeftovers).toEqual([]);
  });

  it('cleans up the temp file when the rename step fails', () => {
    // Force the catch-block cleanup path: pre-create a directory at the
    // destination so renameSync(tmpPath, filepath) fails (EISDIR/ENOTDIR).
    // By that point the temp file has already been opened, written, fsync'd,
    // and closed — so the catch must unlinkSync the leftover .tmp file.
    const target = join(tempDir, 'config.json');
    mkdirSync(target);

    expect(() => writeJsonFileAtomic(target, { v: 1 })).toThrow();

    const leftovers = readdirSync(tempDir).filter(name => name.endsWith('.tmp'));
    expect(leftovers).toEqual([]);
    // The pre-existing directory should still be there — we didn't clobber it.
    expect(statSync(target).isDirectory()).toBe(true);
  });
});
