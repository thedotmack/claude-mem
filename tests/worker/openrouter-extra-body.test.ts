// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { createServer, type IncomingMessage } from 'node:http';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  OpenRouterProvider,
  buildOpenRouterRequestBody,
  resolveOpenRouterConfig,
} from '../../src/services/worker/OpenRouterProvider.js';
import { OpenRouterObservationProvider } from '../../src/server/generation/providers/OpenRouterObservationProvider.js';
import {
  PROTECTED_EXTRA_BODY_KEYS,
  parseOpenRouterExtraBody,
  withOpenRouterExtraBody,
} from '../../src/shared/openrouter-extra-body.js';
import { logger } from '../../src/utils/logger.js';

// CLAUDE_MEM_OPENROUTER_EXTRA_BODY (#3040, #2995): provider-specific request
// fields for a reasoning model that otherwise spends the output budget
// thinking. It never replaces the fields that carry the conversation, routing,
// streaming or the output cap, and it never reaches the cmem gateway.

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const GATEWAY_URL = 'https://cmem.ai/api/inference/v1/chat/completions';
const MESSAGES = [{ role: 'user' as const, content: 'observe' }];

describe('parseOpenRouterExtraBody', () => {
  it('keeps a JSON object', () => {
    expect(parseOpenRouterExtraBody('{"reasoning":{"enabled":false},"provider":{"sort":"price"}}')).toEqual({
      extraBody: { reasoning: { enabled: false }, provider: { sort: 'price' } },
    });
  });

  it('takes an object written straight into settings.json', () => {
    expect(parseOpenRouterExtraBody({ reasoning: { enabled: false } })).toEqual({
      extraBody: { reasoning: { enabled: false } },
    });
  });

  it('treats a blank or missing value as unset', () => {
    expect(parseOpenRouterExtraBody('')).toEqual({});
    expect(parseOpenRouterExtraBody('   ')).toEqual({});
    expect(parseOpenRouterExtraBody(undefined)).toEqual({});
  });

  it('ignores invalid JSON and non-objects with a warning, never throwing', () => {
    expect(parseOpenRouterExtraBody('{reasoning:')).toEqual({ warning: expect.stringContaining('not valid JSON') });
    expect(parseOpenRouterExtraBody('[1,2]')).toEqual({ warning: expect.stringContaining('JSON object') });
    expect(parseOpenRouterExtraBody('42')).toEqual({ warning: expect.stringContaining('JSON object') });
    expect(parseOpenRouterExtraBody('null')).toEqual({ warning: expect.stringContaining('JSON object') });
  });

  it('drops the protected fields and names them', () => {
    const parsed = parseOpenRouterExtraBody(JSON.stringify({
      model: 'x', messages: [], stream: true, max_tokens: 1, max_completion_tokens: 1, models: ['y'], top_p: 0.5,
    }));
    expect(parsed.extraBody).toEqual({ top_p: 0.5 });
    for (const key of PROTECTED_EXTRA_BODY_KEYS) expect(parsed.warning).toContain(key);
  });
});

describe('buildOpenRouterRequestBody with an extra body', () => {
  const base = { model: 'vendor/model', fallbackModels: [], messages: MESSAGES, maxOutputTokens: 4096 };

  it('merges the extra fields last, so they can override ordinary fields', () => {
    const body = buildOpenRouterRequestBody({
      ...base,
      apiUrl: OPENROUTER_URL,
      extraBody: { reasoning: { enabled: false }, temperature: 0.9 },
    });
    expect(body.reasoning).toEqual({ enabled: false });
    expect(body.temperature).toBe(0.9);
    expect(body.usage).toEqual({ include: true });
  });

  it('never lets them replace the conversation, routing, streaming or the output cap', () => {
    const body = buildOpenRouterRequestBody({
      ...base,
      apiUrl: OPENROUTER_URL,
      extraBody: { model: 'other', messages: [], stream: true, max_tokens: 1, max_completion_tokens: 1 },
    });
    expect(body.model).toBe('vendor/model');
    expect(body.messages).toEqual(MESSAGES);
    expect(body.stream).toBeUndefined();
    expect(body.max_tokens).toBe(4096);
    expect(body.max_completion_tokens).toBeUndefined();
  });

  it('keeps a Telegram wrap-up\'s own output controls', () => {
    const body = buildOpenRouterRequestBody({
      ...base,
      apiUrl: OPENROUTER_URL,
      plainText: true,
      extraBody: { reasoning: { effort: 'high' }, response_format: { type: 'json_object' }, top_p: 0.5 },
    });
    expect(body.reasoning).toEqual({ enabled: false });
    expect(body.response_format).toEqual({ type: 'text' });
    expect(body.top_p).toBe(0.5);
  });

  it('sends nothing extra to the cmem gateway: the body is byte-identical', () => {
    const plain = buildOpenRouterRequestBody({ ...base, apiUrl: GATEWAY_URL });
    const withExtra = buildOpenRouterRequestBody({
      ...base,
      apiUrl: GATEWAY_URL,
      extraBody: { reasoning: { enabled: false }, provider: { order: ['x'] }, temperature: 1 },
    });
    expect(JSON.stringify(withExtra)).toBe(JSON.stringify(plain));
  });

  it('reaches a custom OpenAI-compatible endpoint (thinking control for a vendor gateway)', () => {
    const body = buildOpenRouterRequestBody({
      ...base,
      apiUrl: 'https://api.deepseek.com/chat/completions',
      extraBody: { thinking: { type: 'disabled' } },
    });
    expect(body.thinking).toEqual({ type: 'disabled' });
  });
});

describe('resolveOpenRouterConfig reads CLAUDE_MEM_OPENROUTER_EXTRA_BODY from settings', () => {
  const ENV_KEYS = [
    'CLAUDE_MEM_OPENROUTER_API_KEY',
    'CLAUDE_MEM_OPENROUTER_BASE_URL',
    'CLAUDE_MEM_OPENROUTER_MODEL',
    'CLAUDE_MEM_OPENROUTER_EXTRA_BODY',
    'OPENROUTER_BASE_URL',
    'CLAUDE_MEM_ENV_FILE',
    'CMEM_PRO_ORIGIN',
  ];
  let tempDir: string;
  let settingsPath: string;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    tempDir = join(tmpdir(), `openrouter-extra-body-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tempDir, { recursive: true });
    settingsPath = join(tempDir, 'settings.json');
    savedEnv = {};
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    process.env.CLAUDE_MEM_ENV_FILE = join(tempDir, '.env');
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  const writeSettings = (settings: Record<string, unknown>) =>
    writeFileSync(settingsPath, JSON.stringify({ CLAUDE_MEM_PROVIDER: 'openrouter', ...settings }));

  it('attaches the parsed object for a personal openrouter.ai key', () => {
    writeSettings({
      CLAUDE_MEM_OPENROUTER_API_KEY: 'sk-or-v1-personal',
      CLAUDE_MEM_OPENROUTER_EXTRA_BODY: '{"reasoning":{"enabled":false}}',
    });
    expect(resolveOpenRouterConfig(settingsPath).extraBody).toEqual({ reasoning: { enabled: false } });
  });

  it('reads the object form from settings.json and the string form from the environment', () => {
    writeSettings({
      CLAUDE_MEM_OPENROUTER_API_KEY: 'sk-or-v1-personal',
      CLAUDE_MEM_OPENROUTER_EXTRA_BODY: { provider: { sort: 'price' } },
    });
    expect(resolveOpenRouterConfig(settingsPath).extraBody).toEqual({ provider: { sort: 'price' } });

    process.env.CLAUDE_MEM_OPENROUTER_EXTRA_BODY = '{"thinking":{"type":"disabled"}}';
    expect(resolveOpenRouterConfig(settingsPath).extraBody).toEqual({ thinking: { type: 'disabled' } });
  });

  it('attaches nothing for the cmem gateway tuple', () => {
    writeSettings({
      CLAUDE_MEM_OPENROUTER_API_KEY: 'cm_pro_0123456789abcdef01234567',
      CLAUDE_MEM_OPENROUTER_BASE_URL: 'https://cmem.ai/api/inference/v1',
      CLAUDE_MEM_OPENROUTER_MODEL: 'cmem-observer',
      CLAUDE_MEM_OPENROUTER_EXTRA_BODY: '{"reasoning":{"enabled":false}}',
    });
    const config = resolveOpenRouterConfig(settingsPath);
    expect(config.apiKey).toBe('cm_pro_0123456789abcdef01234567');
    expect(config.extraBody).toBeUndefined();
  });

  it('ignores an invalid value without throwing (it is read on every status poll)', () => {
    const warn = spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      writeSettings({
        CLAUDE_MEM_OPENROUTER_API_KEY: 'sk-or-v1-personal',
        CLAUDE_MEM_OPENROUTER_EXTRA_BODY: '{not json',
      });
      expect(resolveOpenRouterConfig(settingsPath).extraBody).toBeUndefined();
      expect(resolveOpenRouterConfig(settingsPath).extraBody).toBeUndefined();
      // Warned once for this value, not on every read.
      expect(warn.mock.calls.filter(call => String(call[1]).includes('EXTRA_BODY')).length).toBe(1);
    } finally {
      warn.mockRestore();
    }
  });
});

/**
 * Gap 8 of the triage: one request through a stand-in cmem gateway
 * (CMEM_PRO_ORIGIN pointed at a local server) must reach it byte-identical to
 * a request made without the setting.
 */
describe('a request to a dev cmem gateway', () => {
  let savedOrigin: string | undefined;

  beforeEach(() => {
    savedOrigin = process.env.CMEM_PRO_ORIGIN;
  });

  afterEach(() => {
    if (savedOrigin === undefined) delete process.env.CMEM_PRO_ORIGIN;
    else process.env.CMEM_PRO_ORIGIN = savedOrigin;
  });

  it('is byte-identical with and without an extra body', async () => {
    const bodies: string[] = [];
    const server = createServer((req: IncomingMessage, res) => {
      let raw = '';
      req.on('data', chunk => { raw += chunk; });
      req.on('end', () => {
        bodies.push(raw);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }));
      });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
    const { port } = server.address() as { port: number };
    process.env.CMEM_PRO_ORIGIN = `http://127.0.0.1:${port}`;
    try {
      const provider = new OpenRouterProvider({} as never, {} as never) as unknown as {
        query(history: unknown[], config: unknown): Promise<{ content: string }>;
      };
      const config = {
        apiKey: 'cm_pro_0123456789abcdef01234567',
        apiKeys: ['cm_pro_0123456789abcdef01234567'],
        model: 'cmem-observer',
        fallbackModels: [],
        apiUrl: `http://127.0.0.1:${port}/api/inference/v1/chat/completions`,
      };
      await provider.query([{ role: 'user', content: 'observe' }], config);
      await provider.query([{ role: 'user', content: 'observe' }], {
        ...config,
        extraBody: { reasoning: { enabled: false }, temperature: 1, provider: { order: ['x'] } },
      });

      expect(bodies).toHaveLength(2);
      expect(bodies[1]).toBe(bodies[0]);
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});

describe('server runtime OpenRouter provider', () => {
  const capture = () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ choices: [{ message: { content: '<skip_summary />' } }] }), { status: 200 });
    }) as typeof fetch;
    return { bodies, fetchImpl };
  };

  const context = {
    job: {
      id: 'job-1', projectId: 'proj-1', teamId: 'team-1', agentEventId: 'evt-1', sourceType: 'agent_event',
      sourceId: 'evt-1', serverSessionId: null, jobType: 'observation_generate_for_event', status: 'processing',
      idempotencyKey: 'k', bullmqJobId: null, attempts: 1, maxAttempts: 3, nextAttemptAtEpoch: null,
      lockedAtEpoch: null, lockedBy: null, completedAtEpoch: null, failedAtEpoch: null, cancelledAtEpoch: null,
      lastError: null, payload: {}, createdAtEpoch: 0, updatedAtEpoch: 0,
    },
    events: [{
      id: 'evt-1', projectId: 'proj-1', teamId: 'team-1', serverSessionId: null, sourceAdapter: 'api',
      sourceEventId: null, idempotencyKey: 'k', eventType: 'tool_use', payload: { tool: 'bash', input: 'ls' },
      metadata: {}, occurredAtEpoch: 0, receivedAtEpoch: 0, createdAtEpoch: 0,
    }],
    project: { projectId: 'proj-1', teamId: 'team-1', serverSessionId: null, projectName: 'demo' },
  };

  it('applies the same extra body to its requests', async () => {
    const { bodies, fetchImpl } = capture();
    const provider = new OpenRouterObservationProvider({
      apiKey: 'sk-or-v1-personal', fetchImpl, extraBody: { reasoning: { enabled: false } },
    });
    await provider.generate(context as never).catch(() => {});
    expect(bodies[0]?.reasoning).toEqual({ enabled: false });
  });

  it('never sends it to the cmem gateway', async () => {
    const { bodies, fetchImpl } = capture();
    const provider = new OpenRouterObservationProvider({
      apiKey: 'cm_pro_0123456789abcdef01234567',
      baseUrl: 'https://cmem.ai/api/inference/v1',
      fetchImpl,
      extraBody: { reasoning: { enabled: false } },
    });
    await provider.generate(context as never).catch(() => {});
    expect(bodies[0]?.reasoning).toBeUndefined();
  });
});

describe('withOpenRouterExtraBody', () => {
  it('returns the body untouched without an extra body', () => {
    const body = { model: 'm' };
    expect(withOpenRouterExtraBody(body, undefined, OPENROUTER_URL)).toBe(body);
  });
});
