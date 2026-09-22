import { describe, expect, it } from 'bun:test';
import {
  buildOpenCodeSafetyConfig,
  buildOpenCodeSafetyEnv,
  classifyOpenCodeError,
  parseOpenCodeJsonOutput,
  validateOpenCodeModel,
} from '../../src/services/worker/OpenCodeProvider.js';

describe('OpenCodeProvider', () => {
  it('builds a deny-all, non-sharing safety config', () => {
    const config = buildOpenCodeSafetyConfig() as any;
    expect(config.share).toBe('disabled');
    expect(config.plugin).toEqual([]);
    expect(config.mcp).toEqual({});
    expect(config.permission['*']['*']).toBe('deny');
    expect(config.agent['claude-mem-summarizer'].permission['*']['*']).toBe('deny');
    // Zen free tier 403s when tools are stripped from the request: no bare deny, no tools map.
    expect(config.permission['*']).not.toBe('deny');
    expect(config.tools).toBeUndefined();
    expect(config.agent['claude-mem-summarizer'].tools).toBeUndefined();
  });

  it('isolates OpenCode config and disables ambient integrations', () => {
    const env = buildOpenCodeSafetyEnv({
      HOME: '/tmp/home',
      CLAUDE_CODE_OAUTH_TOKEN: 'secret-main-session-token',
      ANTHROPIC_API_KEY: 'secret-api-key',
      OPENCODE_CONFIG: '/tmp/unsafe-user-config.json',
      OPENCODE_PERMISSION: JSON.stringify({ '*': 'allow' }),
    });
    expect(env.HOME).toBe('/tmp/home');
    expect(env.XDG_CONFIG_HOME).toContain('opencode-summarizer');
    expect(env.XDG_DATA_HOME).toContain('opencode-summarizer');
    expect(env.XDG_STATE_HOME).toContain('opencode-summarizer');
    expect(env.XDG_CACHE_HOME).toContain('opencode-summarizer');
    expect(env.OPENCODE_DISABLE_PROJECT_CONFIG).toBe('true');
    expect(env.OPENCODE_DISABLE_DEFAULT_PLUGINS).toBe('true');
    expect(env.OPENCODE_DISABLE_CLAUDE_CODE).toBe('true');
    expect(env.OPENCODE_AUTO_SHARE).toBe('false');
    expect(env.OPENCODE_DISABLE_SHARE).toBe('true');
    expect(env.OPENCODE_PURE).toBe('true');
    expect(env.OPENCODE_CONFIG).toBeUndefined();
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(JSON.parse(env.OPENCODE_PERMISSION! )['*']['*']).toBe('deny');
  });

  it('never passes through an inherited XDG_DATA_HOME (or state/cache)', () => {
    const env = buildOpenCodeSafetyEnv({
      HOME: '/tmp/home',
      XDG_DATA_HOME: '/home/user/.local/share',
      XDG_STATE_HOME: '/home/user/.local/state',
      XDG_CACHE_HOME: '/home/user/.cache',
    });
    expect(env.XDG_DATA_HOME).not.toBe('/home/user/.local/share');
    expect(env.XDG_STATE_HOME).not.toBe('/home/user/.local/state');
    expect(env.XDG_CACHE_HOME).not.toBe('/home/user/.cache');
    expect(env.XDG_DATA_HOME).toContain('opencode-summarizer');
    expect(env.XDG_STATE_HOME).toContain('opencode-summarizer');
    expect(env.XDG_CACHE_HOME).toContain('opencode-summarizer');
  });

  it('isolates Kilo (the OpenCode-fork CLI CLAUDE_MEM_OPENCODE_PATH may point at) identically', () => {
    const env = buildOpenCodeSafetyEnv({
      HOME: '/tmp/home',
      KILO_CONFIG: '/tmp/unsafe-kilo-config.jsonc',
      KILO_PERMISSION: JSON.stringify({ '*': 'allow' }),
    });
    expect(env.KILO_DISABLE_PROJECT_CONFIG).toBe('true');
    expect(env.KILO_DISABLE_DEFAULT_PLUGINS).toBe('true');
    expect(env.KILO_DISABLE_CLAUDE_CODE).toBe('true');
    expect(env.KILO_AUTO_SHARE).toBe('false');
    expect(env.KILO_DISABLE_SHARE).toBe('true');
    expect(env.KILO_PURE).toBe('true');
    expect(env.KILO_CONFIG).toBeUndefined();
    expect(JSON.parse(env.KILO_PERMISSION!)['*']['*']).toBe('deny');
    expect(JSON.parse(env.KILO_CONFIG_CONTENT!)).toEqual(JSON.parse(env.OPENCODE_CONFIG_CONTENT!));
  });

  it('parses text and final token usage from OpenCode JSONL', () => {
    const output = [
      JSON.stringify({ type: 'text', part: { text: 'hello ' } }),
      JSON.stringify({ type: 'text', part: { text: 'world' } }),
      JSON.stringify({ type: 'step_finish', part: { tokens: { input: 12, output: 4 } } }),
    ].join('\n');

    expect(parseOpenCodeJsonOutput(output)).toEqual({
      content: 'hello world',
      tokensUsed: 16,
      inputTokens: 12,
      outputTokens: 4,
    });
  });

  it('classifies a missing OpenCode executable as setup_required', () => {
    const error = Object.assign(new Error('spawn opencode ENOENT'), { code: 'ENOENT' });
    expect(classifyOpenCodeError({ cause: error }).kind).toBe('setup_required');
  });

  it('keeps the underlying reason in transient error messages', () => {
    const error = classifyOpenCodeError({ exitCode: 1, stderr: "OpenCode's free tier can only be used from within OpenCode", cause: new Error('x') });
    expect(error.kind).toBe('transient');
    expect(error.message).toContain('free tier');
    expect(classifyOpenCodeError({ cause: new Error('exceeded the 30000ms inference deadline') }).message)
      .toContain('deadline');
  });

  it('rejects model values that look like CLI flags', () => {
    expect(() => validateOpenCodeModel('--help')).toThrow();
    expect(validateOpenCodeModel('opencode/free-model')).toBe('opencode/free-model');
    expect(validateOpenCodeModel('')).toBe('');
  });
});
