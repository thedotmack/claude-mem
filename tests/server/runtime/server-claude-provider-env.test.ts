// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { instantiateServerGenerationProvider, parseAnthropicCustomHeaders } from '../../../src/server/runtime/create-server-service.js';
import { logger } from '../../../src/utils/logger.js';

const ENV_KEYS = [
  'ANTHROPIC_API_KEY', 'CLAUDE_MEM_ANTHROPIC_API_KEY', 'CLAUDE_MEM_OBSERVER_THINKING',
  'ANTHROPIC_BASE_URL', 'CLAUDE_MEM_ANTHROPIC_BASE_URL',
  'ANTHROPIC_CUSTOM_HEADERS', 'CLAUDE_MEM_ANTHROPIC_CUSTOM_HEADERS',
  'CMEM_PRO_ORIGIN',
];

const CM_KEY = 'cm_pro_0123456789abcdef01234567';

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

  it('reads the gateway from CLAUDE_MEM_ANTHROPIC_BASE_URL, never from an inherited ANTHROPIC_BASE_URL', async () => {
    const urlOf = (p: unknown) => (p as { messagesUrl: string }).messagesUrl;
    process.env.ANTHROPIC_BASE_URL = 'https://claude-code-gateway.example.com';
    expect(urlOf(await instantiateServerGenerationProvider('claude'))).toBe('https://api.anthropic.com/v1/messages');
    process.env.CLAUDE_MEM_ANTHROPIC_BASE_URL = 'https://gateway.example.com/anthropic/';
    expect(urlOf(await instantiateServerGenerationProvider('claude'))).toBe('https://gateway.example.com/anthropic/v1/messages');
  });

  it('sends CLAUDE_MEM_ANTHROPIC_CUSTOM_HEADERS, never an inherited ANTHROPIC_CUSTOM_HEADERS', async () => {
    const headersOf = (p: unknown) => (p as { extraHeaders: unknown }).extraHeaders;
    process.env.ANTHROPIC_CUSTOM_HEADERS = 'x-claude-code-gateway: token';
    expect(headersOf(await instantiateServerGenerationProvider('claude'))).toEqual({});
    process.env.CLAUDE_MEM_ANTHROPIC_CUSTOM_HEADERS = 'cf-aig-authorization: Bearer gw\ncf-aig-collect-log-payload: false';
    expect(headersOf(await instantiateServerGenerationProvider('claude')))
      .toEqual({ 'cf-aig-authorization': 'Bearer gw', 'cf-aig-collect-log-payload': 'false' });
  });

  // The shared cmem key lock (src/shared/cmem-gateway.ts): a cm_pro_ memory
  // key authenticates only against the cmem gateway and must never be sent to
  // api.anthropic.com or to a third-party gateway.
  it('never builds a Claude provider around a cm_pro_ key on api.anthropic.com', async () => {
    process.env.ANTHROPIC_API_KEY = CM_KEY;
    const warnSpy = spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      expect(await instantiateServerGenerationProvider('claude')).toBeNull();
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(warnSpy.mock.calls)).not.toContain(CM_KEY);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('never sends a cm_pro_ key to a custom Anthropic gateway', async () => {
    process.env.ANTHROPIC_API_KEY = CM_KEY;
    process.env.CLAUDE_MEM_ANTHROPIC_BASE_URL = 'https://gateway.example.com/anthropic';
    const warnSpy = spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      expect(await instantiateServerGenerationProvider('claude')).toBeNull();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('POSTs a normal key to <base>/v1/messages on a custom gateway', async () => {
    process.env.CLAUDE_MEM_ANTHROPIC_BASE_URL = 'https://gateway.example.com/anthropic/';
    const calls: Array<{ url: string; headers: Headers }> = [];
    const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), headers: new Headers(init?.headers) });
      return new Response(JSON.stringify({ content: [{ type: 'text', text: 'ok' }] }), { status: 200 });
    }) as typeof fetch);
    try {
      const provider = await instantiateServerGenerationProvider('claude');
      expect(provider).not.toBeNull();
      await provider!.generate({
        job: { id: 'job-1', projectId: 'p', teamId: 't', sourceType: 'observation', sourceId: 's' },
        events: [{ id: 'e', eventType: 'tool_use', payload: { tool: 'bash', input: 'ls' }, metadata: {}, occurredAtEpoch: 0 }],
        project: { projectId: 'p', teamId: 't', name: 'p' },
      } as never);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.url).toBe('https://gateway.example.com/anthropic/v1/messages');
      expect(calls[0]!.headers.get('x-api-key')).toBe('sk-fake');
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe('parseAnthropicCustomHeaders', () => {
  it('is undefined when unset, blank or holding no valid line', () => {
    expect(parseAnthropicCustomHeaders(undefined)).toBeUndefined();
    expect(parseAnthropicCustomHeaders(' \n ')).toBeUndefined();
    expect(parseAnthropicCustomHeaders('no colon')).toBeUndefined();
  });

  it('splits each line at its first colon and skips malformed lines', () => {
    expect(parseAnthropicCustomHeaders('A: 1\r\n: no name\nB:x:y\nnot a header'))
      .toEqual({ A: '1', B: 'x:y' });
  });

  it('skips a line fetch would refuse, warning without its text', () => {
    const warnSpy = spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      expect(parseAnthropicCustomHeaders('Bad Name: x\nX-Tok: s\u0007ecret\nX-Tok2: s\u2713ecret\nGood: ok')).toEqual({ Good: 'ok' });
      expect(warnSpy).toHaveBeenCalledTimes(3);
      const logged = JSON.stringify(warnSpy.mock.calls);
      expect(logged).not.toContain('ecret');
      expect(logged).not.toContain('Bad Name');
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('drops a header carrying a cmem.ai memory key, warning with its line number only', () => {
    const warnSpy = spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      expect(parseAnthropicCustomHeaders(`Good: ok\nX-Gateway-Auth: Bearer ${CM_KEY}`)).toEqual({ Good: 'ok' });
      expect(warnSpy).toHaveBeenCalledTimes(1);
      const logged = JSON.stringify(warnSpy.mock.calls);
      expect(logged).toContain('line 2');
      expect(logged).not.toContain('cm_pro_0123');
      expect(logged).not.toContain('X-Gateway-Auth');
    } finally {
      warnSpy.mockRestore();
    }
  });
});
