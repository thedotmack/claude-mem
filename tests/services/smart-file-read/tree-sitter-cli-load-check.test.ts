import { describe, expect, it, afterAll } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import { resolveDataDir } from '../../../src/shared/paths.js';
import { treeSitterBinaryName } from '../../../src/services/smart-file-read/tree-sitter-bin-name.js';
import { checkTreeSitterCliLoadable, pickTreeSitterBinPath, treeSitterCliUnavailableMessage } from '../../../src/services/smart-file-read/tree-sitter-bin-path.js';

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

  it.each(['0.24.4', '0.25.10'])('rejects tree-sitter %s, which lacks required query options', (version) => {
    const binPath = writeExecutable(join(scratchRoot, `old-${version}`), binaryName, `echo "tree-sitter ${version}"`);
    const check = checkTreeSitterCliLoadable(binPath);
    expect(check.present).toBe(true);
    expect(check.loadable).toBe(false);
    expect(check.reason).toContain('0.26.0');
  });

  it('accepts the minimum compatible tree-sitter version', () => {
    const binPath = writeExecutable(join(scratchRoot, 'minimum-version'), binaryName, 'echo "tree-sitter 0.26.0"');
    expect(checkTreeSitterCliLoadable(binPath).loadable).toBe(true);
  });

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

  it('re-probes after chmod +x repairs the executable bit (mode-keyed cache)', () => {
    const dir = join(scratchRoot, 'chmod-repair');
    mkdirSync(dir, { recursive: true });
    const binPath = join(dir, binaryName);
    writeFileSync(binPath, '#!/bin/sh\necho "tree-sitter 0.26.9"\n');
    chmodSync(binPath, 0o644);

    const before = checkTreeSitterCliLoadable(binPath);
    expect(before.present).toBe(true);
    expect(before.loadable).toBe(false);

    chmodSync(binPath, 0o755);
    const after = checkTreeSitterCliLoadable(binPath);
    expect(after.loadable).toBe(true);
    expect(after.reason).toBeUndefined();
  });

  it('skips a non-executable file shadowing a working executable on PATH', () => {
    const shadowDir = join(scratchRoot, 'shadow-bin');
    const workingDir = join(scratchRoot, 'working-bin');
    mkdirSync(shadowDir, { recursive: true });
    // A non-executable regular file with the binary name comes first on PATH;
    // the OS's own lookup would skip it, so the check must too.
    writeFileSync(join(shadowDir, binaryName), 'not executable');
    chmodSync(join(shadowDir, binaryName), 0o644);
    writeExecutable(workingDir, binaryName, 'echo "tree-sitter 0.26.9"');

    const check = checkTreeSitterCliLoadable(
      binaryName,
      [shadowDir, workingDir].join(delimiter),
    );
    expect(check.present).toBe(true);
    expect(check.loadable).toBe(true);
  });
});

// #4758 follow-up: a package-local binary the OS cannot run must not shadow a
// working tree-sitter on PATH (e.g. a conda-forge build linked against an
// older glibc), or the smart tools stay broken even though a fix is installed.
describe.skipIf(process.platform === 'win32')('pickTreeSitterBinPath', () => {
  function writeExecutable(dir: string, script: string): string {
    mkdirSync(dir, { recursive: true });
    const binPath = join(dir, binaryName);
    writeFileSync(binPath, `#!/bin/sh\n${script}\n`);
    chmodSync(binPath, 0o755);
    return binPath;
  }
  const working = 'echo "tree-sitter 0.26.9"';
  const glibcFailure = "echo 'tree-sitter: version GLIBC_2.39 not found' >&2\nexit 1";

  it('keeps the package-local binary when it runs, even if PATH has another', () => {
    const local = writeExecutable(join(scratchRoot, 'pick-1', 'pkg'), working);
    const pathDir = join(scratchRoot, 'pick-1', 'path');
    writeExecutable(pathDir, working);

    expect(pickTreeSitterBinPath(local, binaryName, pathDir)).toBe(local);
  });

  it('falls back to a working binary on PATH when the package-local one cannot run', () => {
    const local = writeExecutable(join(scratchRoot, 'pick-2', 'pkg'), glibcFailure);
    const pathDir = join(scratchRoot, 'pick-2', 'path');
    const onPath = writeExecutable(pathDir, working);

    const picked = pickTreeSitterBinPath(local, binaryName, pathDir);
    expect(picked).toBe(onPath);
    expect(checkTreeSitterCliLoadable(picked).loadable).toBe(true);
  });

  it('keeps the package-local binary (and its reason) when nothing runs', () => {
    const local = writeExecutable(join(scratchRoot, 'pick-3', 'pkg'), glibcFailure);
    const pathDir = join(scratchRoot, 'pick-3', 'path');
    writeExecutable(pathDir, glibcFailure);

    const picked = pickTreeSitterBinPath(local, binaryName, pathDir);
    expect(picked).toBe(local);
    expect(checkTreeSitterCliLoadable(picked).reason).toContain('GLIBC_2.39');
  });

  it('returns an absolute path when the working binary comes from a relative PATH entry', () => {
    const local = writeExecutable(join(scratchRoot, 'pick-rel', 'pkg'), glibcFailure);
    writeExecutable(join(scratchRoot, 'pick-rel', 'bin'), working);
    const originalCwd = process.cwd();
    process.chdir(join(scratchRoot, 'pick-rel'));
    try {
      const picked = pickTreeSitterBinPath(local, binaryName, 'bin');
      expect(isAbsolute(picked)).toBe(true);
      // Callers re-check the picked path with no PATH help: it must still load.
      expect(checkTreeSitterCliLoadable(picked, '').loadable).toBe(true);
    } finally {
      process.chdir(originalCwd);
    }
  });

  it('keeps the package-local binary when PATH has no tree-sitter', () => {
    const local = writeExecutable(join(scratchRoot, 'pick-4', 'pkg'), glibcFailure);

    expect(pickTreeSitterBinPath(local, binaryName, join(scratchRoot, 'pick-4', 'empty'))).toBe(local);
  });

  it('switches back to the package-local binary once it is replaced by one that runs', () => {
    const local = writeExecutable(join(scratchRoot, 'pick-5', 'pkg'), glibcFailure);
    const pathDir = join(scratchRoot, 'pick-5', 'path');
    const onPath = writeExecutable(pathDir, working);
    expect(pickTreeSitterBinPath(local, binaryName, pathDir)).toBe(onPath);

    writeFileSync(local, `#!/bin/sh\n${working}\n`);
    const mtime = new Date(Date.now() + 5000);
    utimesSync(local, mtime, mtime);
    expect(pickTreeSitterBinPath(local, binaryName, pathDir)).toBe(local);
  });
});

// #4858: on musl the release executable never lands, so the CLI is missing,
// not broken. The smart tools must still say so instead of "unsupported language".
describe('treeSitterCliUnavailableMessage', () => {
  it('is null when the CLI runs', () => {
    expect(treeSitterCliUnavailableMessage({ present: true, loadable: true })).toBeNull();
  });

  it('reports a missing CLI as missing, with the repair and PATH fixes', () => {
    const message = treeSitterCliUnavailableMessage(
      checkTreeSitterCliLoadable(binaryName, join(scratchRoot, 'no-such-path')),
    );
    expect(message).toContain('not installed');
    expect(message).toContain('not an unsupported language');
    expect(message).toContain('npx claude-mem repair');
    expect(message).toContain('on PATH');
  });

  it('reports a present CLI that cannot run with its reason', () => {
    const message = treeSitterCliUnavailableMessage({ present: true, loadable: false, reason: 'GLIBC_2.39 not found' });
    expect(message).toContain('cannot run on this system (GLIBC_2.39 not found)');
    expect(message).toContain('not an unsupported language');
  });
});
