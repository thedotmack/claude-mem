import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveUvBuildsDir, sweepStaleUvBuildDirs } from '../../../src/shared/uv-cache.js';

// #3540 — orphaned uv build scratch dirs under <uv-cache>/builds-v0/.

describe('resolveUvBuildsDir', () => {
  it('uses %LOCALAPPDATA%\\uv\\cache on Windows', () => {
    const dir = resolveUvBuildsDir({
      platform: 'win32',
      env: { LOCALAPPDATA: 'C:\\Users\\t\\AppData\\Local' },
    });
    expect(dir).toBe(path.join('C:\\Users\\t\\AppData\\Local', 'uv', 'cache', 'builds-v0'));
  });

  it('returns null on Windows when LOCALAPPDATA is unset', () => {
    expect(resolveUvBuildsDir({ platform: 'win32', env: {} })).toBeNull();
  });

  it('honours UV_CACHE_DIR on every platform', () => {
    const dir = resolveUvBuildsDir({ platform: 'win32', env: { UV_CACHE_DIR: 'D:\\uvcache' } });
    expect(dir).toBe(path.join('D:\\uvcache', 'builds-v0'));
  });

  it('uses $XDG_CACHE_HOME/uv when set on POSIX', () => {
    const dir = resolveUvBuildsDir({ platform: 'linux', env: { XDG_CACHE_HOME: '/x/cache' } });
    expect(dir).toBe(path.join('/x/cache', 'uv', 'builds-v0'));
  });

  it('falls back to ~/.cache/uv on POSIX', () => {
    const dir = resolveUvBuildsDir({ platform: 'linux', env: {}, homedir: () => '/home/t' });
    expect(dir).toBe(path.join('/home/t', '.cache', 'uv', 'builds-v0'));
  });
});

describe('sweepStaleUvBuildDirs', () => {
  let cacheDir: string;
  let buildsDir: string;

  beforeEach(() => {
    cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uv-cache-test-'));
    buildsDir = path.join(cacheDir, 'builds-v0');
    fs.mkdirSync(buildsDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  });

  const makeDir = (name: string, ageMs: number) => {
    const dir = path.join(buildsDir, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'file'), 'x');
    const when = new Date(Date.now() - ageMs);
    fs.utimesSync(dir, when, when);
    return dir;
  };

  it('removes stale .tmp dirs, keeps recent ones and non-.tmp entries', async () => {
    const stale = makeDir('.tmpAAAAAA', 2 * 60 * 60 * 1000);
    const recent = makeDir('.tmpBBBBBB', 5 * 60 * 1000);
    const other = makeDir('cache-entry', 2 * 60 * 60 * 1000);

    const removed = await sweepStaleUvBuildDirs({
      env: { UV_CACHE_DIR: cacheDir },
      minAgeMs: 60 * 60 * 1000,
    });

    expect(removed).toBe(1);
    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(recent)).toBe(true);
    expect(fs.existsSync(other)).toBe(true);
  });

  it('returns 0 when the builds dir does not exist', async () => {
    fs.rmSync(buildsDir, { recursive: true, force: true });
    const removed = await sweepStaleUvBuildDirs({ env: { UV_CACHE_DIR: cacheDir } });
    expect(removed).toBe(0);
  });
});
