import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { provisionScopedAuth } from '../../src/services/worker/CodexAppServerClient.js';

// Codex replaces a credential file by writing a temporary file and renaming it
// over the original. It refuses to do that when the file has more than one hard
// link (`persist_failed: atomic credential replacement does not support
// hard-linked files`), which breaks both `codex login` and token refresh. A
// symlink is the supported way to share the file: Codex follows it and replaces
// the real file.

const AUTH = JSON.stringify({ auth_mode: 'chatgpt', tokens: { account_id: 'acct' } });

function fsError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: simulated`), { code });
}

describe('provisionScopedAuth', () => {
  let root: string;
  let nativeAuth: string;
  let scopedAuth: string;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'codex-scoped-auth-')));
    const nativeHome = join(root, 'native');
    const scopedHome = join(root, 'scoped');
    mkdirSync(nativeHome);
    mkdirSync(scopedHome);
    nativeAuth = join(nativeHome, 'auth.json');
    scopedAuth = join(scopedHome, 'auth.json');
    writeFileSync(nativeAuth, AUTH);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('never leaves the user\'s credential file with a second hard link', () => {
    provisionScopedAuth(nativeAuth, scopedAuth);

    // The exact condition Codex enforces before it will save credentials.
    expect(statSync(nativeAuth).nlink).toBe(1);
    expect(readFileSync(scopedAuth, 'utf8')).toBe(AUTH);
  });

  it.each(['EPERM', 'EACCES', 'ENOTSUP'])(
    'on Windows copies the file when a symlink is not permitted (%s) instead of hard-linking it',
    code => {
      const mode = provisionScopedAuth(nativeAuth, scopedAuth, {
        platform: 'win32',
        symlink: () => { throw fsError(code); },
      });

      expect(mode).toBe('copy');
      expect(readFileSync(scopedAuth, 'utf8')).toBe(AUTH);
      expect(lstatSync(scopedAuth).isSymbolicLink()).toBe(false);
      // Two independent files: neither is a hard link of the other.
      expect(statSync(nativeAuth).nlink).toBe(1);
      expect(statSync(scopedAuth).nlink).toBe(1);
      expect(statSync(scopedAuth).ino).not.toBe(statSync(nativeAuth).ino);
    },
  );

  it('keeps the copy private to the scoped home: writes to it do not reach the user\'s file', () => {
    provisionScopedAuth(nativeAuth, scopedAuth, {
      platform: 'win32',
      symlink: () => { throw fsError('EPERM'); },
    });
    writeFileSync(scopedAuth, '{"auth_mode":"apikey"}');

    expect(readFileSync(nativeAuth, 'utf8')).toBe(AUTH);
  });

  it('uses a symlink to the real file when the platform allows one', () => {
    const calls: unknown[][] = [];
    const mode = provisionScopedAuth(nativeAuth, scopedAuth, {
      platform: 'win32',
      symlink: (...args) => { calls.push(args); },
      copy: () => { throw new Error('must not copy when a symlink worked'); },
    });

    expect(mode).toBe('symlink');
    expect(calls).toEqual([[nativeAuth, scopedAuth, 'file']]);
  });

  it('does not hide other symlink failures behind a copy on Windows', () => {
    expect(() => provisionScopedAuth(nativeAuth, scopedAuth, {
      platform: 'win32',
      symlink: () => { throw fsError('EEXIST'); },
      copy: () => { throw new Error('must not copy on an unrelated error'); },
    })).toThrow('EEXIST');
  });

  it('never replaces the symlink with a copy on other platforms', () => {
    // A copy would silently diverge from the user's login on macOS and Linux,
    // where symlinks are always available. Fail loudly instead.
    expect(() => provisionScopedAuth(nativeAuth, scopedAuth, {
      platform: 'linux',
      symlink: () => { throw fsError('EPERM'); },
      copy: () => { throw new Error('must not copy off Windows'); },
    })).toThrow('EPERM');
  });
});
