// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { instantiateServerGenerationProvider } from '../../../src/server/runtime/create-server-service.js';
import { GeminiObservationProvider } from '../../../src/server/generation/providers/GeminiObservationProvider.js';
import { OpenRouterObservationProvider } from '../../../src/server/generation/providers/OpenRouterObservationProvider.js';

// Wave 3 gate R4-7: the server runtime built its Gemini and OpenRouter providers
// straight from the environment, with no cmem key lock. A cm_pro_ key set as
// GEMINI_API_KEY went to Google, and one set as OPENROUTER_API_KEY went to
// openrouter.ai. The shared lock now applies here too.

const CM_KEY = 'cm_pro_0123456789abcdef01234567';
const GATEWAY = 'https://cmem.ai/api/inference/v1';
const ENV_KEYS = [
  'GEMINI_API_KEY', 'CLAUDE_MEM_GEMINI_API_KEY',
  'OPENROUTER_API_KEY', 'CLAUDE_MEM_OPENROUTER_API_KEY',
  'CLAUDE_MEM_OPENROUTER_BASE_URL', 'OPENROUTER_BASE_URL',
  'CMEM_PRO_ORIGIN',
];

function keyOf(provider: unknown): string {
  return (provider as { apiKey: string }).apiKey;
}

describe('server runtime providers go through the cmem key lock', () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {};
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it('never builds a Gemini provider around a cm_pro_ key', async () => {
    process.env.GEMINI_API_KEY = CM_KEY;
    expect(await instantiateServerGenerationProvider('gemini')).toBeNull();
  });

  it('still builds Gemini with a Google key', async () => {
    process.env.GEMINI_API_KEY = 'AIza-server-key';
    const provider = await instantiateServerGenerationProvider('gemini');
    expect(provider).toBeInstanceOf(GeminiObservationProvider);
    expect(keyOf(provider)).toBe('AIza-server-key');
  });

  it('never sends a cm_pro_ key to openrouter.ai', async () => {
    process.env.OPENROUTER_API_KEY = CM_KEY;
    expect(await instantiateServerGenerationProvider('openrouter')).toBeNull();
  });

  it('sends a cm_pro_ key to the cmem gateway', async () => {
    process.env.OPENROUTER_API_KEY = CM_KEY;
    process.env.CLAUDE_MEM_OPENROUTER_BASE_URL = GATEWAY;
    const provider = await instantiateServerGenerationProvider('openrouter');
    expect(provider).toBeInstanceOf(OpenRouterObservationProvider);
    expect(keyOf(provider)).toBe(CM_KEY);
  });

  it('never sends a personal key to the cmem gateway', async () => {
    process.env.OPENROUTER_API_KEY = 'sk-or-v1-personal';
    process.env.CLAUDE_MEM_OPENROUTER_BASE_URL = GATEWAY;
    expect(await instantiateServerGenerationProvider('openrouter')).toBeNull();
  });

  it('still builds OpenRouter with a personal key on openrouter.ai', async () => {
    process.env.OPENROUTER_API_KEY = 'sk-or-v1-personal';
    const provider = await instantiateServerGenerationProvider('openrouter');
    expect(provider).toBeInstanceOf(OpenRouterObservationProvider);
    expect(keyOf(provider)).toBe('sk-or-v1-personal');
  });
});
