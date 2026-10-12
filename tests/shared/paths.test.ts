import { describe, it, expect, afterEach } from 'bun:test';
import {
  paths,
  DATA_DIR,
  resolveDataDir,
  ensureObserverSessionsDir,
  expandHome,
} from '../../src/shared/paths.js';
import { homedir, tmpdir } from 'os';
import { join } from 'path';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';

describe('paths namespace', () => {
  it('exposes at least the known core accessors', () => {
    const keys = Object.keys(paths);
    const required = [
      'dataDir',
      'workerPid',
      'settings',
      'database',
      'chroma',
      'transcriptsConfig',
    ];
    for (const key of required) {
      expect(keys).toContain(key);
    }
  });

  it('every accessor returns a string starting with DATA_DIR', () => {
    for (const key of Object.keys(paths) as Array<keyof typeof paths>) {
      const value = paths[key]();
      expect(typeof value).toBe('string');
      expect(value.startsWith(DATA_DIR)).toBe(true);
    }
  });

  it('every accessor is a callable function', () => {
    for (const key of Object.keys(paths) as Array<keyof typeof paths>) {
      expect(typeof paths[key]).toBe('function');
    }
  });
});

describe('expandHome', () => {
  it('expands a leading ~/ on POSIX and Windows', () => {
    expect(expandHome('~/x', 'linux')).toBe(join(homedir(), 'x'));
    expect(expandHome('~/x', 'win32')).toBe(join(homedir(), 'x'));
  });

  it('expands a leading ~\\ on Windows', () => {
    expect(expandHome('~\\x', 'win32')).toBe(join(homedir(), 'x'));
  });

  it('leaves a leading ~\\ untouched on POSIX', () => {
    expect(expandHome('~\\x', 'linux')).toBe('~\\x');
  });

  it('expands a bare ~ on POSIX and Windows', () => {
    expect(expandHome('~', 'linux')).toBe(homedir());
    expect(expandHome('~', 'win32')).toBe(homedir());
  });

  it('leaves an absolute path untouched', () => {
    const abs = join(homedir(), '.claude-mem');
    expect(expandHome(abs)).toBe(abs);
  });

  it('leaves a path with no tilde untouched on POSIX and Windows', () => {
    expect(expandHome('foo/bar', 'linux')).toBe('foo/bar');
    expect(expandHome('foo\\bar', 'win32')).toBe('foo\\bar');
  });

  it('does not expand ~ not at position 0', () => {
    // a tilde mid-path is a literal character, not a home reference
    expect(expandHome('foo/~bar')).toBe('foo/~bar');
  });

  it('does not touch a ~user/ form (out of scope)', () => {
    expect(expandHome('~someone/data')).toBe('~someone/data');
  });
});

describe('resolveDataDir tilde expansion', () => {
  // resolveDataDir consults process.env.CLAUDE_MEM_DATA_DIR first, so we can
  // exercise the expansion without touching the real settings.json on disk.
  const sentinel = '/__claude_mem_test_no_real_dir__';
  const origEnv = process.env.CLAUDE_MEM_DATA_DIR;

  afterEach(() => {
    if (origEnv === undefined) delete process.env.CLAUDE_MEM_DATA_DIR;
    else process.env.CLAUDE_MEM_DATA_DIR = origEnv;
  });

  it('returns an absolute path when the env var is a literal ~ (no stray ~ dir)', () => {
    process.env.CLAUDE_MEM_DATA_DIR = '~/.claude-mem';
    const resolved = resolveDataDir();
    expect(resolved).toBe(join(homedir(), '.claude-mem'));
    // the regression: a non-absolute, ~-prefixed value used to slip through and
    // become a cwd-relative path → a literal `~` directory on disk.
    expect(resolved.startsWith('~')).toBe(false);
    expect(join(resolved, 'logs')).toBe(join(homedir(), '.claude-mem', 'logs'));
  });

  it('returns the home dir when the env var is a bare ~', () => {
    process.env.CLAUDE_MEM_DATA_DIR = '~';
    expect(resolveDataDir()).toBe(homedir());
  });

  it('still returns a real env-var value when it is already absolute', () => {
    process.env.CLAUDE_MEM_DATA_DIR = sentinel;
    expect(resolveDataDir()).toBe(sentinel);
  });
});

describe('ensureObserverSessionsDir', () => {
  const created: string[] = [];

  afterEach(() => {
    for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function makeTempBase(): string {
    const base = mkdtempSync(join(tmpdir(), 'cmem-obs-'));
    created.push(base);
    return base;
  }

  it('creates the directory and returns it', () => {
    const dir = join(makeTempBase(), 'observer-sessions');
    expect(ensureObserverSessionsDir(dir)).toBe(dir);
    expect(existsSync(dir)).toBe(true);
  });

  it('turns a permanent mkdir failure (data dir is a file) into the setup message', () => {
    const asFile = join(makeTempBase(), 'data-is-a-file');
    writeFileSync(asFile, 'x');
    // observer-sessions would sit under a file, so mkdir throws ENOTDIR.
    expect(() => ensureObserverSessionsDir(join(asFile, 'observer-sessions')))
      .toThrow(/^Observer working directory could not be prepared: .* \(ENOTDIR\)/);
  });

  it('rethrows a transient mkdir failure unchanged so it is retried, not parked', () => {
    for (const code of ['EMFILE', 'ENFILE', 'EIO', 'ENOSPC']) {
      const transient = Object.assign(new Error(`${code}: simulated`), { code });
      let caught: unknown;
      try {
        ensureObserverSessionsDir('/unused', () => { throw transient; });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBe(transient);
    }
  });
});
