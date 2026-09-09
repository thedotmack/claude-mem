import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { resolveOpenRouterConfig, isOpenRouterAvailable, openRouterKeyPoolSize } from '../../src/services/worker/OpenRouterProvider.js';
import { isGeminiAvailable } from '../../src/services/worker/GeminiProvider.js';

const CMEM_GATEWAY_BASE = 'https://cmem.ai/api/inference/v1';

const ENV_KEYS = [
  'CLAUDE_MEM_PROVIDER',
  'CLAUDE_MEM_OPENROUTER_API_KEY',
  'CLAUDE_MEM_OPENROUTER_API_KEYS',
  'CLAUDE_MEM_OPENROUTER_BASE_URL',
  'CLAUDE_MEM_OPENROUTER_MODEL',
  'CLAUDE_MEM_GEMINI_API_KEY',
  'CLAUDE_MEM_GEMINI_API_KEYS',
  'OPENROUTER_BASE_URL',
] as const;

describe('key pool wiring', () => {
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = {};
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    process.env.CLAUDE_MEM_OPENROUTER_API_KEYS = '';
    process.env.CLAUDE_MEM_GEMINI_API_KEYS = '';
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  describe('OpenRouter', () => {
    it('is a single-entry pool when only the legacy key is set', () => {
      process.env.CLAUDE_MEM_OPENROUTER_API_KEY = 'sk-or-one';
      process.env.CLAUDE_MEM_OPENROUTER_BASE_URL = '';

      const config = resolveOpenRouterConfig();
      expect(config.apiKey).toBe('sk-or-one');
      expect(config.apiKeys).toEqual(['sk-or-one']);
    });

    it('appends the list behind the legacy key', () => {
      process.env.CLAUDE_MEM_OPENROUTER_API_KEY = 'sk-or-one';
      process.env.CLAUDE_MEM_OPENROUTER_API_KEYS = 'sk-or-two\nsk-or-three';
      process.env.CLAUDE_MEM_OPENROUTER_BASE_URL = '';

      expect(resolveOpenRouterConfig().apiKeys).toEqual(['sk-or-one', 'sk-or-two', 'sk-or-three']);
      expect(openRouterKeyPoolSize()).toBe(3);
    });

    it('stays available when keys come only from the list', () => {
      process.env.CLAUDE_MEM_OPENROUTER_API_KEY = '';
      process.env.CLAUDE_MEM_OPENROUTER_API_KEYS = 'sk-or-listed';
      process.env.CLAUDE_MEM_OPENROUTER_BASE_URL = '';

      expect(resolveOpenRouterConfig().apiKey).toBe('sk-or-listed');
      expect(isOpenRouterAvailable()).toBe(true);
    });

    it('NEVER pools personal keys onto the cmem gateway', () => {
      // The gateway key is account-delivered; the list is by definition the
      // user's personal keys. Rotating into it would send a personal credential
      // to the gateway — the same leak resolveOpenRouterConfig already refuses
      // to commit when a key-only override meets a persisted cmem base URL.
      process.env.CLAUDE_MEM_OPENROUTER_API_KEY = 'sk-or-delivered';
      process.env.CLAUDE_MEM_OPENROUTER_API_KEYS = 'sk-or-personal-1,sk-or-personal-2';
      process.env.CLAUDE_MEM_OPENROUTER_BASE_URL = CMEM_GATEWAY_BASE;

      const config = resolveOpenRouterConfig();
      expect(config.apiKeys).toEqual(['sk-or-delivered']);
      expect(config.apiKeys).not.toContain('sk-or-personal-1');
      expect(config.apiKeys).not.toContain('sk-or-personal-2');
    });

    it('pools normally against a user-owned custom base URL', () => {
      process.env.CLAUDE_MEM_OPENROUTER_API_KEY = 'sk-own-1';
      process.env.CLAUDE_MEM_OPENROUTER_API_KEYS = 'sk-own-2';
      process.env.CLAUDE_MEM_OPENROUTER_BASE_URL = 'https://api.deepseek.com/v1';

      expect(resolveOpenRouterConfig().apiKeys).toEqual(['sk-own-1', 'sk-own-2']);
    });

    it('does not report availability with no keys anywhere', () => {
      process.env.CLAUDE_MEM_OPENROUTER_API_KEY = '';
      process.env.CLAUDE_MEM_OPENROUTER_API_KEYS = '';
      process.env.CLAUDE_MEM_OPENROUTER_BASE_URL = '';

      expect(isOpenRouterAvailable()).toBe(false);
      expect(openRouterKeyPoolSize()).toBe(0);
    });
  });

  describe('Gemini', () => {
    it('is available from the legacy key alone', () => {
      process.env.CLAUDE_MEM_GEMINI_API_KEY = 'AIza-one';
      expect(isGeminiAvailable()).toBe(true);
    });

    it('is available from a list-only configuration, so dispatch does not fall through', () => {
      process.env.CLAUDE_MEM_GEMINI_API_KEY = '';
      process.env.CLAUDE_MEM_GEMINI_API_KEYS = 'AIza-a,AIza-b';
      expect(isGeminiAvailable()).toBe(true);
    });

    it('is unavailable with neither', () => {
      process.env.CLAUDE_MEM_GEMINI_API_KEY = '';
      process.env.CLAUDE_MEM_GEMINI_API_KEYS = '';
      expect(isGeminiAvailable()).toBe(false);
    });
  });
});
