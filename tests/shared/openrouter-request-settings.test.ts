// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'bun:test';
import {
  buildOpenRouterRequestBody,
  parseOpenRouterExtraBody,
  parseOpenRouterReasoningEffort,
  validateOpenRouterExtraBody,
  validateOpenRouterReasoningEffort,
} from '../../src/shared/openrouter-request-settings.js';

describe('OpenRouter request settings', () => {
  it('parses supported reasoning effort values case-insensitively', () => {
    expect(parseOpenRouterReasoningEffort('none')).toBe('none');
    expect(parseOpenRouterReasoningEffort(' LOW ')).toBe('low');
    expect(parseOpenRouterReasoningEffort('medium')).toBe('medium');
    expect(parseOpenRouterReasoningEffort('high')).toBe('high');
    expect(parseOpenRouterReasoningEffort('invalid')).toBeNull();
    expect(validateOpenRouterReasoningEffort('invalid')).toContain('none, low, medium, high');
  });

  it('accepts provider-specific extra body fields', () => {
    expect(parseOpenRouterExtraBody('{"thinking":{"type":"disabled"},"top_k":40}')).toEqual({
      thinking: { type: 'disabled' },
      top_k: 40,
    });
    expect(validateOpenRouterExtraBody({ provider: { order: ['anthropic'] } })).toBeNull();
  });

  it('rejects invalid or unsafe extra body fields', () => {
    expect(validateOpenRouterExtraBody('not json')).toBe('CLAUDE_MEM_OPENROUTER_EXTRA_BODY is not valid JSON');
    expect(validateOpenRouterExtraBody('[]')).toBe('CLAUDE_MEM_OPENROUTER_EXTRA_BODY must be a JSON object');
    expect(validateOpenRouterExtraBody('{"model":"other"}')).toBe(
      'CLAUDE_MEM_OPENROUTER_EXTRA_BODY cannot override core request field "model"',
    );
    expect(validateOpenRouterExtraBody('{"messages":[]}')).toBe(
      'CLAUDE_MEM_OPENROUTER_EXTRA_BODY cannot override core request field "messages"',
    );
    expect(validateOpenRouterExtraBody('{"reasoning":{"effort":"high"}}')).toBe(
      'CLAUDE_MEM_OPENROUTER_EXTRA_BODY cannot override core request field "reasoning"',
    );
    expect(() => buildOpenRouterRequestBody({
      apiUrl: 'https://api.deepseek.com/chat/completions',
      model: 'deepseek-chat',
      messages: [],
      extraBody: { max_tokens: 1 },
    })).toThrow('CLAUDE_MEM_OPENROUTER_EXTRA_BODY cannot override core request field "max_tokens"');
  });

  it('adds reasoning effort and usage accounting for openrouter.ai', () => {
    const body = buildOpenRouterRequestBody({
      apiUrl: 'https://openrouter.ai/api/v1/chat/completions',
      model: 'anthropic/claude-sonnet-4.5',
      messages: [{ role: 'user', content: 'hello' }],
      reasoningEffort: 'none',
      extraBody: { provider: { allow_fallbacks: false } },
    });

    expect(body).toMatchObject({
      model: 'anthropic/claude-sonnet-4.5',
      messages: [{ role: 'user', content: 'hello' }],
      temperature: 0.3,
      max_tokens: 4096,
      reasoning: { effort: 'none' },
      usage: { include: true },
      provider: { allow_fallbacks: false },
    });
  });

  it('omits OpenRouter-only usage accounting for custom gateways', () => {
    const body = buildOpenRouterRequestBody({
      apiUrl: 'https://api.deepseek.com/chat/completions',
      model: 'deepseek-chat',
      messages: [{ role: 'user', content: 'hello' }],
      extraBody: { thinking: { type: 'disabled' } },
    });

    expect(body).not.toHaveProperty('usage');
    expect(body).toMatchObject({
      model: 'deepseek-chat',
      thinking: { type: 'disabled' },
    });
  });
});
