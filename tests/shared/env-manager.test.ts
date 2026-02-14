import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';

const MOCK_HOME = '/tmp/claude-mem-env-test-home';
let envFileExists = false;
let envFileContent = '';
let credentialsFileContent: string | null = null;
let credentialsReadThrows = false;

mock.module('os', () => ({
  homedir: () => MOCK_HOME,
}));

mock.module('fs', () => ({
  existsSync: (path: string) => {
    if (path.endsWith('/.claude-mem/.env')) return envFileExists;
    return false;
  },
  readFileSync: (path: string) => {
    if (path.endsWith('/.claude-mem/.env')) {
      if (!envFileExists) throw new Error('ENOENT');
      return envFileContent;
    }
    if (path.endsWith('/.claude/.credentials.json')) {
      if (credentialsReadThrows || !credentialsFileContent) throw new Error('ENOENT');
      return credentialsFileContent;
    }
    throw new Error('ENOENT');
  },
  writeFileSync: () => {},
  mkdirSync: () => {},
}));

import { buildIsolatedEnv, getAuthMethodDescription } from '../../src/shared/EnvManager.js';

describe('EnvManager OAuth token resolution', () => {
  const originalOauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  const originalAnthropicKey = process.env.ANTHROPIC_API_KEY;

  beforeEach(() => {
    envFileExists = false;
    envFileContent = '';
    credentialsFileContent = null;
    credentialsReadThrows = false;

    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  });

  afterEach(() => {
    if (originalOauthToken === undefined) {
      delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    } else {
      process.env.CLAUDE_CODE_OAUTH_TOKEN = originalOauthToken;
    }

    if (originalAnthropicKey === undefined) {
      delete process.env.ANTHROPIC_API_KEY;
    } else {
      process.env.ANTHROPIC_API_KEY = originalAnthropicKey;
    }
  });

  it('should prefer fresh token from credentials.json over stale env var', () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'stale-token';
    credentialsFileContent = JSON.stringify({
      claudeAiOauth: { accessToken: 'fresh-token' },
    });

    const isolatedEnv = buildIsolatedEnv();

    expect(isolatedEnv.CLAUDE_CODE_OAUTH_TOKEN).toBe('fresh-token');
  });

  it('should fall back to env var when credentials.json is unavailable', () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'fallback-token';
    credentialsReadThrows = true;

    const isolatedEnv = buildIsolatedEnv();

    expect(isolatedEnv.CLAUDE_CODE_OAUTH_TOKEN).toBe('fallback-token');
  });

  it('should strip OAuth token when ANTHROPIC_API_KEY is configured', () => {
    envFileExists = true;
    envFileContent = 'ANTHROPIC_API_KEY=sk-ant-api-key\n';
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'oauth-token';
    credentialsFileContent = JSON.stringify({
      claudeAiOauth: { accessToken: 'fresh-token' },
    });

    const isolatedEnv = buildIsolatedEnv();

    expect(isolatedEnv.ANTHROPIC_API_KEY).toBe('sk-ant-api-key');
    expect(isolatedEnv.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });

  it('should describe auth method as credentials.json token when available', () => {
    credentialsFileContent = JSON.stringify({
      claudeAiOauth: { accessToken: 'fresh-token' },
    });
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'stale-token';

    expect(getAuthMethodDescription()).toBe(
      'Claude Code OAuth token (from ~/.claude/.credentials.json)'
    );
  });
});
