import { describe, expect, it } from 'bun:test';
import { sanitizeEnv } from '../../src/supervisor/env-sanitizer.js';

const KEPT = [
  ['PATH', '/usr/bin'],
  ['CLAUDE_CODE_OAUTH_TOKEN', 'token'],
  ['CLAUDE_CODE_SKIP_BEDROCK_AUTH', '1'],
  ['CLAUDE_CODE_SKIP_VERTEX_AUTH', '1'],
  ['HOME', '/home/user'],
  ['NODE_PATH', '/usr/local/lib'],
  ['PATH', '/usr/bin:/usr/local/bin'],
  ['NODE_PATH', '/usr/local/lib/node_modules'],
  ['SHELL', '/bin/zsh'],
  ['USER', 'developer'],
  ['LANG', 'en_US.UTF-8'],
  ['KEEP', 'yes'],
  ['DEFINED', 'value'],
  ['CLAUDE_CODE_OAUTH_TOKEN', 'oauth-token'],
  ['KEEP_ME', 'yes'],
  ['CLAUDE_CODE_GIT_BASH_PATH', 'C:\\Program Files\\Git\\bin\\bash.exe'],
  ['CLAUDE_CODE_TMPDIR', '/home/user/.cache/claude-tmp'],
  ['CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS', '1'],
  ['CLAUDE_CODE_PATH', 'C:\\Users\\me\\.local\\bin\\claude.exe'],
  ['CLAUDE_CODE_USE_FOUNDRY', '1'],
  ['CLAUDE_CODE_SKIP_FOUNDRY_AUTH', '1'],
  ['HTTP_PROXY', 'http://corp-proxy:1234'],
  ['HTTPS_PROXY', 'http://corp-proxy:1234'],
  ['ALL_PROXY', 'socks5://corp-proxy:1080'],
  ['NO_PROXY', 'localhost,127.0.0.1'],
  ['http_proxy', 'http://corp-proxy:1234'],
  ['https_proxy', 'http://corp-proxy:1234'],
  ['all_proxy', 'socks5://corp-proxy:1080'],
  ['no_proxy', 'localhost,127.0.0.1'],
  ['npm_config_proxy', 'http://corp-proxy:1234'],
  ['npm_config_https_proxy', 'http://corp-proxy:1234'],
  ['npm_config_noproxy', 'localhost,127.0.0.1'],
  ['NODE_USE_ENV_PROXY', '1'],
  ['node_use_env_proxy', '1'],
  ['CLAUDE_CODE_OAUTH_TOKEN', 'my-oauth-token'],
  ['CLAUDE_CODE_GIT_BASH_PATH', '/usr/bin/bash'],
  ['CLAUDE_CODE_USE_BEDROCK', '1'],
  ['CLAUDE_CODE_USE_VERTEX', '1'],
] as const;

const STRIPPED = [
  ['CLAUDECODE_FOO', 'bar'],
  ['CLAUDECODE_SOMETHING', 'value'],
  ['CLAUDE_CODE_BAR', 'baz'],
  ['CLAUDECODE', '1'],
  ['CLAUDE_CODE_SESSION', 'session-123'],
  ['CLAUDE_CODE_ENTRYPOINT', 'hook'],
  ['MCP_SESSION_ID', 'mcp-abc'],
  ['CLAUDE_CODE_SESSION', 'session'],
  ['CLAUDE_CODE_ENTRYPOINT', 'entry'],
  ['MCP_SESSION_ID', 'mcp'],
  ['CLAUDE_CODE_EFFORT_LEVEL', 'high'],
  ['CLAUDE_CODE_RANDOM_OTHER', 'should-be-stripped'],
  ['CLAUDE_CODE_ENTRYPOINT', 'cli'],
  ['CLAUDE_CODE_ALWAYS_ENABLE_EFFORT', '1'],
  ['CLAUDE_CODE_INTERNAL_FLAG', 'should-be-stripped'],
] as const;

describe('sanitizeEnv', () => {
  it('preserves auth, proxy and user variables while removing session variables', () => {
    for (const [key, value] of KEPT) {
      expect(sanitizeEnv({ [key]: value })).toEqual({ [key]: value });
    }
    for (const [key, value] of STRIPPED) {
      expect(sanitizeEnv({ [key]: value })).toEqual({});
    }
    const onlyKept = Object.fromEntries(KEPT);
    expect(sanitizeEnv({ ...onlyKept, ...Object.fromEntries(STRIPPED) })).toEqual(onlyKept);
  });

  it('returns a new object without mutating the input and omits undefined values', () => {
    const original: NodeJS.ProcessEnv = { PATH: '/usr/bin', CLAUDECODE_FOO: 'bar', UNDEFINED_KEY: undefined };
    const originalCopy = { ...original };
    const result = sanitizeEnv(original);

    expect(result).not.toBe(original);
    expect(original).toEqual(originalCopy);
    expect(result).toEqual({ PATH: '/usr/bin' });
  });

  it('handles an empty env', () => {
    expect(sanitizeEnv({})).toEqual({});
  });
});
