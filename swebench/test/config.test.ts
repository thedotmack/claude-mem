import { afterEach, describe, expect, test } from 'bun:test';
import { defaultWorkerPort, resolveChatCompletionsUrl, resolveOpenRouterConfig, resolveWorkerConfig, resetConfigCache } from '../src/config.ts';

const SAVED = { ...process.env };
afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in SAVED)) delete process.env[k];
  Object.assign(process.env, SAVED);
  resetConfigCache();
});

describe('resolveChatCompletionsUrl', () => {
  test('empty → default OpenRouter endpoint', () => {
    expect(resolveChatCompletionsUrl('')).toBe('https://openrouter.ai/api/v1/chat/completions');
  });
  test('/v1 base gets /chat/completions appended', () => {
    expect(resolveChatCompletionsUrl('https://gateway.local/v1')).toBe('https://gateway.local/v1/chat/completions');
  });
  test('already-full url passes through (trailing slash trimmed)', () => {
    expect(resolveChatCompletionsUrl('https://x/y/chat/completions/')).toBe('https://x/y/chat/completions');
  });
});

describe('defaultWorkerPort', () => {
  test('is in the claude-mem range 37700..37799', () => {
    const p = defaultWorkerPort();
    expect(p).toBeGreaterThanOrEqual(37700);
    expect(p).toBeLessThanOrEqual(37799);
  });
});

describe('resolveOpenRouterConfig', () => {
  test('env key + SWEBENCH_MODEL take precedence', () => {
    process.env.CLAUDE_MEM_DATA_DIR = '/nonexistent-dir-xyz';
    process.env.OPENROUTER_API_KEY = 'sk-env';
    process.env.SWEBENCH_MODEL = 'openai/gpt-x';
    resetConfigCache();
    const cfg = resolveOpenRouterConfig();
    expect(cfg.apiKey).toBe('sk-env');
    expect(cfg.model).toBe('openai/gpt-x');
    expect(cfg.apiUrl).toContain('/chat/completions');
  });
  test('explicit overrides beat env', () => {
    process.env.OPENROUTER_API_KEY = 'sk-env';
    resetConfigCache();
    expect(resolveOpenRouterConfig({ apiKey: 'sk-override' }).apiKey).toBe('sk-override');
  });
});

describe('resolveWorkerConfig', () => {
  test('honors explicit host + port', () => {
    process.env.CLAUDE_MEM_DATA_DIR = '/nonexistent-dir-xyz';
    process.env.CLAUDE_MEM_WORKER_HOST = '127.0.0.1';
    process.env.CLAUDE_MEM_WORKER_PORT = '40000';
    resetConfigCache();
    expect(resolveWorkerConfig().baseUrl).toBe('http://127.0.0.1:40000');
  });
});
