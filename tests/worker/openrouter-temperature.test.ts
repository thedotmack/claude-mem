// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { buildOpenRouterRequestBody, resolveOpenRouterConfig } from '../../src/services/worker/OpenRouterProvider.js';
import { SettingsRoutes } from '../../src/services/worker/http/routes/SettingsRoutes.js';

import { instantiateServerGenerationProvider } from '../../src/server/runtime/create-server-service.js';

const KEY = 'CLAUDE_MEM_OPENROUTER_TEMPERATURE';
const ENV_KEYS = [KEY, 'CLAUDE_MEM_OPENROUTER_BASE_URL', 'CLAUDE_MEM_OPENROUTER_API_KEY',
  'CLAUDE_MEM_OPENROUTER_EXTRA_BODY', 'OPENROUTER_API_KEY', 'CLAUDE_MEM_ENV_FILE', 'OPENROUTER_BASE_URL', 'CMEM_PRO_ORIGIN'];
let directory: string;
let settingsPath: string;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'openrouter-temperature-'));
  settingsPath = join(directory, 'settings.json');
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  process.env.CLAUDE_MEM_ENV_FILE = join(directory, '.env');
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  rmSync(directory, { recursive: true, force: true });
});

function body(settings: Record<string, unknown> = {}) {
  writeFileSync(settingsPath, JSON.stringify({
    CLAUDE_MEM_PROVIDER: 'openrouter',
    CLAUDE_MEM_OPENROUTER_API_KEY: 'local-key',
    CLAUDE_MEM_OPENROUTER_BASE_URL: 'http://127.0.0.1:1234/v1',
    ...settings,
  }));
  return buildOpenRouterRequestBody({
    ...resolveOpenRouterConfig(settingsPath), messages: [{ role: 'user', content: 'Observe this change.' }],
  });
}

describe('OpenRouter temperature configuration', () => {
  it('uses the persisted temperature for local endpoints and OpenRouter', () => {
    for (const url of ['http://127.0.0.1:1234/v1', 'https://openrouter.ai/api/v1']) {
      expect(body({ [KEY]: '0.7', CLAUDE_MEM_OPENROUTER_BASE_URL: url }).temperature).toBe(0.7);
    }
  });

  it('honors the environment override, including zero', () => {
    process.env[KEY] = '0';
    expect(body({ [KEY]: '0.7' }).temperature).toBe(0);
  });

  it('preserves the default and existing extra-body overrides when unset', () => {
    expect(body().temperature).toBe(0.3);
    expect(body({ [KEY]: '', CLAUDE_MEM_OPENROUTER_EXTRA_BODY: { temperature: 0.9 } }).temperature).toBe(0.9);
  });

  it('gives the explicit setting precedence without dropping other extra fields', () => {
    const request = body({ [KEY]: '0.7', CLAUDE_MEM_OPENROUTER_EXTRA_BODY: { temperature: 0.9, top_p: 0.8 } });
    expect(request.temperature).toBe(0.7);
    expect(request.top_p).toBe(0.8);
  });

  it('keeps the managed gateway request policy unchanged', () => {
    expect(body({ [KEY]: '0.7', CLAUDE_MEM_OPENROUTER_BASE_URL: 'https://cmem.ai/api/inference/v1',
      CLAUDE_MEM_OPENROUTER_API_KEY: 'cm_pro_0123456789abcdef01234567' }).temperature).toBe(0.3);
  });

  it('ignores invalid file values instead of failing observation generation', () => {
    for (const value of ['invalid', '-0.1', '2.1', 'Infinity', true, null, {}]) {
      expect(body({ [KEY]: value }).temperature).toBe(0.3);
    }
  });
});

describe('temperature settings API validation', () => {
  const routes = new SettingsRoutes({} as never) as unknown as {
    validateSettings(settings: Record<string, unknown>): { valid: boolean };
  };
  it('accepts blank and finite values between zero and two', () => {
    for (const value of ['', '0', '0.7', '2', 0.7]) expect(routes.validateSettings({ [KEY]: value }).valid).toBe(true);
  });
  it('rejects malformed and out-of-range values', () => {
    for (const value of ['invalid', '-0.1', '2.1', 'Infinity', true, null, {}]) {
      expect(routes.validateSettings({ [KEY]: value }).valid).toBe(false);
    }
  });
});


describe('server temperature configuration', () => {
  it('sends the configured temperature while preserving other extra fields', async () => {
    process.env.CLAUDE_MEM_OPENROUTER_API_KEY = 'local-key';
    process.env.CLAUDE_MEM_OPENROUTER_BASE_URL = 'http://127.0.0.1:1234/v1';
    process.env.CLAUDE_MEM_OPENROUTER_EXTRA_BODY = '{"temperature":0.9,"top_p":0.8}';
    process.env[KEY] = '0.7';
    let request: Record<string, unknown> = {};
    const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((async (_url, init) => {
      request = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ choices: [{ message: { content: '<skip_summary />' } }] }), { status: 200 });
    }) as typeof fetch);
    try {
      const provider = await instantiateServerGenerationProvider('openrouter');
      expect(provider).not.toBeNull();
      await provider!.generate({
        job: { id: 'job-1', projectId: 'p', teamId: 't', jobType: 'observation_generate_for_event' },
        events: [{ id: 'e', sourceAdapter: 'api', eventType: 'tool_use', payload: { tool_name: 'Read' }, occurredAtEpoch: 1_700_000_000_000 }],
        project: { projectId: 'p', teamId: 't' },
      } as never);
      expect(request.temperature).toBe(0.7);
      expect(request.top_p).toBe(0.8);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
