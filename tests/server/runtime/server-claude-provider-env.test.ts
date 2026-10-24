// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { instantiateServerGenerationProvider } from '../../../src/server/runtime/create-server-service.js';

const ENV_KEYS = ['ANTHROPIC_API_KEY', 'CLAUDE_MEM_ANTHROPIC_API_KEY', 'CLAUDE_MEM_OBSERVER_THINKING'];

function thinkingOf(provider: unknown): unknown {
  return (provider as { thinking: unknown }).thinking;
}

describe('server Claude provider reads the worker observer settings', () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {};
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    process.env.ANTHROPIC_API_KEY = 'sk-fake';
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it('disables thinking when CLAUDE_MEM_OBSERVER_THINKING is unset', async () => {
    expect(thinkingOf(await instantiateServerGenerationProvider('claude'))).toEqual({ type: 'disabled' });
  });

  it('passes CLAUDE_MEM_OBSERVER_THINKING through the worker parser', async () => {
    process.env.CLAUDE_MEM_OBSERVER_THINKING = 'omit';
    expect(thinkingOf(await instantiateServerGenerationProvider('claude'))).toBe('omit');
    process.env.CLAUDE_MEM_OBSERVER_THINKING = 'enabled:2048';
    expect(thinkingOf(await instantiateServerGenerationProvider('claude'))).toEqual({ type: 'enabled', budgetTokens: 2048 });
  });
});
