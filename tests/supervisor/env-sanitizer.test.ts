import { describe, expect, it } from 'bun:test';
import { sanitizeEnv } from '../../src/supervisor/env-sanitizer.js';

describe('sanitizeEnv', () => {
  it('removes Claude Code session variables by prefix and exact match', () => {
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
    expect(result.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(result.CLAUDE_CODE_SESSION).toBeUndefined();
    expect(result.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
    expect(result.MCP_SESSION_ID).toBeUndefined();
  });
});
