import { describe, it, expect } from 'bun:test';
import { createHash } from 'crypto';
import { join } from 'path';
import { keychainServiceNames } from '../../src/shared/oauth-token.js';

/**
 * Claude Code scopes its credential entry by config directory, so with a non-default
 * `CLAUDE_CONFIG_DIR` the live token is not under the plain service name. Reading only the
 * plain name found whatever stale entry sat there, called it expired, and warned
 * "re-login via Claude Desktop" on every session start about a token that is not the one
 * in use — re-logging in could not fix it (#3718).
 */

const PLAIN = 'Claude Code-credentials';
const HOME = '/home/tester';

function scopedFor(dir: string): string {
  return `${PLAIN}-${createHash('sha256').update(dir).digest('hex').slice(0, 8)}`;
}

describe('keychainServiceNames (#3718)', () => {
  it('reads only the plain name when CLAUDE_CONFIG_DIR is unset', () => {
    expect(keychainServiceNames({}, HOME)).toEqual([PLAIN]);
  });

  it('treats the default config dir as unscoped', () => {
    // Claude Code does not hash the default directory, so scoping it would send the
    // reader looking for an entry that never exists.
    expect(keychainServiceNames({ CLAUDE_CONFIG_DIR: join(HOME, '.claude') }, HOME)).toEqual([
      PLAIN,
    ]);
  });

  it('tries the config-scoped name first, then the plain one', () => {
    const dir = '/home/tester/.claude_b';
    expect(keychainServiceNames({ CLAUDE_CONFIG_DIR: dir }, HOME)).toEqual([
      scopedFor(dir),
      PLAIN,
    ]);
  });

  it('keeps the plain name as a fallback, so an unscoped entry is still found', () => {
    const names = keychainServiceNames({ CLAUDE_CONFIG_DIR: '/tmp/elsewhere' }, HOME);
    expect(names).toHaveLength(2);
    expect(names[names.length - 1]).toBe(PLAIN);
  });

  it('derives the suffix from the configured string, not from the resolved path', () => {
    // Two directories that differ only by trailing content must not collide.
    const a = keychainServiceNames({ CLAUDE_CONFIG_DIR: '/tmp/a' }, HOME)[0];
    const b = keychainServiceNames({ CLAUDE_CONFIG_DIR: '/tmp/b' }, HOME)[0];
    expect(a).not.toBe(b);
    expect(a).toBe(scopedFor('/tmp/a'));
  });

  it('ignores whitespace-only values', () => {
    expect(keychainServiceNames({ CLAUDE_CONFIG_DIR: '   ' }, HOME)).toEqual([PLAIN]);
  });
});
