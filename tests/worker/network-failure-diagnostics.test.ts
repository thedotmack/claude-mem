// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'bun:test';
import { classifyOpenRouterError } from '../../src/services/worker/OpenRouterProvider.js';
import { classifyOpenAICompatError } from '../../src/services/worker/OpenAICompatProvider.js';
import { describeNetworkFailure } from '../../src/shared/network-failure.js';

// #4092: a LAN endpoint failed instantly from the background worker while the
// same request worked from a terminal, and the error named neither the
// runtime's code nor the host. A request with no response now says both, and
// a local-network host gets a hint about process network permissions.

const bunRefused = () => Object.assign(new Error('Unable to connect. Is the computer able to access the url?'), { code: 'ConnectionRefused' });
const nodeRefused = () => Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });

describe('describeNetworkFailure', () => {
  it('reads Bun\'s code from the error and Node\'s from its cause', () => {
    expect(describeNetworkFailure(bunRefused()).code).toBe('ConnectionRefused');
    expect(describeNetworkFailure(nodeRefused()).code).toBe('ECONNREFUSED');
    expect(describeNetworkFailure(new Error('plain')).code).toBeUndefined();
  });

  it('hints only for a local-network host, never this machine or the internet', () => {
    for (const url of ['http://192.168.1.20:11434/v1', 'http://10.0.0.5/v1', 'http://172.20.1.1/v1', 'http://box.local:8000/v1']) {
      expect(describeNetworkFailure(bunRefused(), url).localNetworkHint).toContain('Local Network');
    }
    for (const url of ['http://localhost:11434/v1', 'http://127.0.0.1:1234/v1', 'https://openrouter.ai/api/v1', 'https://cmem.ai/api/inference/v1']) {
      expect(describeNetworkFailure(bunRefused(), url).localNetworkHint).toBeUndefined();
    }
  });
});

describe('OpenRouter network errors name the code and host', () => {
  it('reports a refused LAN endpoint with the hint as its action', () => {
    const err = classifyOpenRouterError({ cause: bunRefused(), requestUrl: 'http://192.168.1.20:11434/v1/chat/completions' });
    expect(err.kind).toBe('transient');
    expect(err.message).toContain('ConnectionRefused');
    expect(err.message).toContain('reaching 192.168.1.20:11434');
    expect(err.action).toContain('Local Network');
  });

  it('keeps an internet host to code and host, no hint', () => {
    const err = classifyOpenRouterError({ cause: nodeRefused(), requestUrl: 'https://openrouter.ai/api/v1/chat/completions' });
    expect(err.message).toContain('ECONNREFUSED, reaching openrouter.ai');
    expect(err.action).toBeUndefined();
  });

  it('still works without a URL', () => {
    expect(classifyOpenRouterError({ cause: new Error('ECONNRESET') }).message).toBe('OpenRouter network error: ECONNRESET');
  });
});

describe('openai-compatible network errors name the code and host', () => {
  it('reports a refused LAN endpoint with the hint as its action', () => {
    const err = classifyOpenAICompatError({
      cause: bunRefused(),
      endpointLabel: 'Ollama (local)',
      requestUrl: 'http://192.168.1.20:11434/v1/chat/completions',
    });
    expect(err.kind).toBe('transient');
    expect(err.message).toContain('Ollama (local) network error');
    expect(err.message).toContain('ConnectionRefused, reaching 192.168.1.20:11434');
    expect(err.action).toContain('Local Network');
  });
});
