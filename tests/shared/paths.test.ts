import { describe, it, expect, afterEach } from 'bun:test';
import { paths, DATA_DIR, resolveDataDir, expandHome } from '../../src/shared/paths.js';
import { homedir } from 'os';
import { join } from 'path';

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
  it('expands a leading ~/ to the home directory', () => {
    expect(expandHome('~/foo/bar')).toBe(join(homedir(), 'foo/bar'));
  });

  it('expands a bare ~ to the home directory', () => {
    expect(expandHome('~')).toBe(homedir());
  });

  it('leaves an absolute path untouched', () => {
    const abs = join(homedir(), '.claude-mem');
    expect(expandHome(abs)).toBe(abs);
  });

  it('leaves a relative path (no ~) untouched', () => {
    expect(expandHome('foo/bar')).toBe('foo/bar');
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
