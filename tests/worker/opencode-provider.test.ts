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
    expect(config.permission['*']).toBe('deny');
    expect(config.tools['*']).toBe(false);
    expect(config.agent['claude-mem-summarizer'].permission['*']).toBe('deny');
    expect(config.agent['claude-mem-summarizer'].tools['*']).toBe(false);
  });

  it('isolates OpenCode config and disables ambient integrations', () => {
    const env = buildOpenCodeSafetyEnv({
      HOME: '/tmp/home',
      CLAUDE_CODE_OAUTH_TOKEN: 'secret-main-session-token',
      OPENCODE_CONFIG: '/tmp/unsafe-user-config.json',
      OPENCODE_PERMISSION: JSON.stringify({ '*': 'allow' }),
    });
    expect(env.HOME).toBe('/tmp/home');
    expect(env.XDG_CONFIG_HOME).toContain('opencode-summarizer');
    expect(env.OPENCODE_DISABLE_PROJECT_CONFIG).toBe('true');
    expect(env.OPENCODE_DISABLE_DEFAULT_PLUGINS).toBe('true');
    expect(env.OPENCODE_DISABLE_CLAUDE_CODE).toBe('true');
    expect(env.OPENCODE_AUTO_SHARE).toBe('false');
    expect(env.OPENCODE_DISABLE_SHARE).toBe('true');
    expect(env.OPENCODE_PURE).toBe('true');
    expect(env.OPENCODE_CONFIG).toBeUndefined();
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(JSON.parse(env.OPENCODE_PERMISSION! )['*']).toBe('deny');
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

  it('rejects model values that look like CLI flags', () => {
    expect(() => validateOpenCodeModel('--help')).toThrow();
    expect(validateOpenCodeModel('opencode/free-model')).toBe('opencode/free-model');
    expect(validateOpenCodeModel('')).toBe('');
  });
});
