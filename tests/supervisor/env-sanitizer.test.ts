import { describe, expect, it } from 'bun:test';
import { sanitizeEnv } from '../../src/supervisor/env-sanitizer.js';

describe('sanitizeEnv', () => {
  it('strips variables with CLAUDECODE_ prefix', () => {
    const result = sanitizeEnv({
      CLAUDECODE_FOO: 'bar',
      CLAUDECODE_SOMETHING: 'value',
      PATH: '/usr/bin'
    });

    expect(result.CLAUDECODE_FOO).toBeUndefined();
    expect(result.CLAUDECODE_SOMETHING).toBeUndefined();
    expect(result.PATH).toBe('/usr/bin');
  });

  it('strips variables with CLAUDE_CODE_ prefix but preserves allowed ones', () => {
    const result = sanitizeEnv({
      CLAUDE_CODE_BAR: 'baz',
      CLAUDE_CODE_OAUTH_TOKEN: 'token',
      HOME: '/home/user'
    });

    expect(result.CLAUDE_CODE_BAR).toBeUndefined();
    expect(result.CLAUDE_CODE_OAUTH_TOKEN).toBe('token');
    expect(result.HOME).toBe('/home/user');
  });

  it('strips exact-match variables (CLAUDECODE, CLAUDE_CODE_SESSION, CLAUDE_CODE_ENTRYPOINT, MCP_SESSION_ID)', () => {
    const result = sanitizeEnv({
      CLAUDECODE: '1',
      CLAUDE_CODE_SESSION: 'session-123',
      CLAUDE_CODE_ENTRYPOINT: 'hook',
      MCP_SESSION_ID: 'mcp-abc',
      NODE_PATH: '/usr/local/lib'
    });

    expect(result.CLAUDECODE).toBeUndefined();
    expect(result.CLAUDE_CODE_SESSION).toBeUndefined();
    expect(result.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
    expect(result.MCP_SESSION_ID).toBeUndefined();
    expect(result.NODE_PATH).toBe('/usr/local/lib');
  });

  it('preserves allowed variables like PATH, HOME, NODE_PATH', () => {
    const result = sanitizeEnv({
      PATH: '/usr/bin:/usr/local/bin',
      HOME: '/home/user',
      NODE_PATH: '/usr/local/lib/node_modules',
      SHELL: '/bin/zsh',
      USER: 'developer',
      LANG: 'en_US.UTF-8'
    });

    expect(result.PATH).toBe('/usr/bin:/usr/local/bin');
    expect(result.HOME).toBe('/home/user');
    expect(result.NODE_PATH).toBe('/usr/local/lib/node_modules');
    expect(result.SHELL).toBe('/bin/zsh');
    expect(result.USER).toBe('developer');
    expect(result.LANG).toBe('en_US.UTF-8');
  });

  it('returns a new object and does not mutate the original', () => {
    const original: NodeJS.ProcessEnv = {
      PATH: '/usr/bin',
      CLAUDECODE_FOO: 'bar',
      KEEP: 'yes'
    };
    const originalCopy = { ...original };

    const result = sanitizeEnv(original);

    // Result should be a different object
    expect(result).not.toBe(original);

    // Original should be unchanged
    expect(original).toEqual(originalCopy);

    // Result should not contain stripped vars
    expect(result.CLAUDECODE_FOO).toBeUndefined();
    expect(result.PATH).toBe('/usr/bin');
  });

  it('handles empty env gracefully', () => {
    const result = sanitizeEnv({});
    expect(result).toEqual({});
  });

  it('skips entries with undefined values', () => {
    const env: NodeJS.ProcessEnv = {
      DEFINED: 'value',
      UNDEFINED_KEY: undefined
    };

    const result = sanitizeEnv(env);
    expect(result.DEFINED).toBe('value');
    expect('UNDEFINED_KEY' in result).toBe(false);
  });

  it('combines prefix and exact match removal in a single pass', () => {
    const result = sanitizeEnv({
      PATH: '/usr/bin',
      CLAUDECODE: '1',
      CLAUDECODE_FOO: 'bar',
      CLAUDE_CODE_BAR: 'baz',
      CLAUDE_CODE_OAUTH_TOKEN: 'oauth-token',
      CLAUDE_CODE_SESSION: 'session',
      CLAUDE_CODE_ENTRYPOINT: 'entry',
      MCP_SESSION_ID: 'mcp',
      KEEP_ME: 'yes'
    });

    expect(result.PATH).toBe('/usr/bin');
    expect(result.KEEP_ME).toBe('yes');
    expect(result.CLAUDECODE).toBeUndefined();
    expect(result.CLAUDECODE_FOO).toBeUndefined();
    expect(result.CLAUDE_CODE_BAR).toBeUndefined();
    expect(result.CLAUDE_CODE_OAUTH_TOKEN).toBe('oauth-token');
    expect(result.CLAUDE_CODE_SESSION).toBeUndefined();
    expect(result.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
    expect(result.MCP_SESSION_ID).toBeUndefined();
  });

  it('preserves CLAUDE_CODE_GIT_BASH_PATH through sanitization', () => {
    const result = sanitizeEnv({
      CLAUDE_CODE_GIT_BASH_PATH: 'C:\\Program Files\\Git\\bin\\bash.exe',
      PATH: '/usr/bin',
      HOME: '/home/user'
    });

    expect(result.CLAUDE_CODE_GIT_BASH_PATH).toBe('C:\\Program Files\\Git\\bin\\bash.exe');
    expect(result.PATH).toBe('/usr/bin');
    expect(result.HOME).toBe('/home/user');
  });

  it('selectively preserves only allowed CLAUDE_CODE_* vars while stripping others', () => {
    const result = sanitizeEnv({
      CLAUDE_CODE_OAUTH_TOKEN: 'my-oauth-token',
      CLAUDE_CODE_GIT_BASH_PATH: '/usr/bin/bash',
      CLAUDE_CODE_RANDOM_OTHER: 'should-be-stripped',
      CLAUDE_CODE_INTERNAL_FLAG: 'should-be-stripped',
      PATH: '/usr/bin'
    });

    // Preserved: explicitly allowed CLAUDE_CODE_* vars
    expect(result.CLAUDE_CODE_OAUTH_TOKEN).toBe('my-oauth-token');
    expect(result.CLAUDE_CODE_GIT_BASH_PATH).toBe('/usr/bin/bash');

    // Stripped: all other CLAUDE_CODE_* vars
    expect(result.CLAUDE_CODE_RANDOM_OTHER).toBeUndefined();
    expect(result.CLAUDE_CODE_INTERNAL_FLAG).toBeUndefined();

    // Preserved: normal env vars
    expect(result.PATH).toBe('/usr/bin');
  });
});
