// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import type { Request, Response } from 'express';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { FILE_ONLY_SETTING_KEYS, SettingsRoutes } from '../../../../src/services/worker/http/routes/SettingsRoutes.js';
import { STEP_MODEL_SETTINGS } from '../../../../src/services/work-view/refresh-task.js';
import { paths } from '../../../../src/shared/paths.js';

// Wave 3 gate R4-13: the viewer posts every setting back, edited or not. A
// value hand-edited into settings.json that the worker already ignores (it
// falls back to the default) failed validation on every later save, so the
// user could not change anything else from the viewer.

function handlers() {
  const routes: Record<string, (req: Request, res: Response) => void> = {};
  const app = {
    get: mock((path: string, ...hs: Array<(req: Request, res: Response) => void>) => { routes[`GET ${path}`] = hs[hs.length - 1]; }),
    post: mock((path: string, ...hs: Array<(req: Request, res: Response) => void>) => { routes[`POST ${path}`] = hs[hs.length - 1]; }),
  };
  new SettingsRoutes({} as never).setupRoutes(app as never);
  return routes;
}

function call(handler: (req: Request, res: Response) => void, body: Record<string, unknown> = {}) {
  const json = mock((_payload: unknown) => {});
  let statusCode = 200;
  const res = {
    json,
    status: mock((code: number) => { statusCode = code; return { json }; }),
    headersSent: false,
  } as unknown as Response;
  handler({ body, path: '/api/settings', params: {}, query: {}, headers: {} } as Request, res);
  return { payload: json.mock.calls[0]?.[0] as Record<string, unknown>, status: () => statusCode };
}

describe('a viewer save is judged on what it changes', () => {
  const settingsPath = paths.settings();
  let prior: string | undefined;

  beforeEach(() => {
    prior = existsSync(settingsPath) ? readFileSync(settingsPath, 'utf-8') : undefined;
  });

  afterEach(() => {
    if (prior === undefined) rmSync(settingsPath, { force: true });
    else writeFileSync(settingsPath, prior, 'utf-8');
  });

  for (const [key, value] of [
    ['CLAUDE_MEM_QUOTA_FALLBACK_PROVIDER', 'codex'],
    ['CLAUDE_MEM_CODEX_REASONING_EFFORT', 'hand-edited'],
    ['CLAUDE_MEM_OPENROUTER_REASONING_EFFORT', 'xhigh'],
    ['CLAUDE_MEM_OPENROUTER_BASE_URL', 'api.deepseek.com/v1'],
  ] as const) {
    it(`saves an unrelated edit while settings.json holds ${key}=${value}`, () => {
      writeFileSync(settingsPath, JSON.stringify({ [key]: value }));
      const routes = handlers();
      const shown = call(routes['GET /api/settings']).payload;

      const saved = call(routes['POST /api/settings'], { ...shown, CLAUDE_MEM_CONTEXT_OBSERVATIONS: '60' });

      expect(saved.status()).toBe(200);
      const after = JSON.parse(readFileSync(settingsPath, 'utf-8'));
      expect(after.CLAUDE_MEM_CONTEXT_OBSERVATIONS).toBe('60');
      expect(after[key]).toBe(value);
    });
  }

  it('still refuses the same value when this save sets it', () => {
    writeFileSync(settingsPath, JSON.stringify({}));
    const routes = handlers();
    const shown = call(routes['GET /api/settings']).payload;

    const saved = call(routes['POST /api/settings'], { ...shown, CLAUDE_MEM_QUOTA_FALLBACK_PROVIDER: 'codex' });

    expect(saved.status()).toBe(400);
    expect(String(saved.payload.error)).toContain('CLAUDE_MEM_QUOTA_FALLBACK_PROVIDER');
  });

  it('persists the observer capture hard switch from the viewer', () => {
    writeFileSync(settingsPath, JSON.stringify({}));
    const routes = handlers();
    const shown = call(routes['GET /api/settings']).payload;

    const saved = call(routes['POST /api/settings'], { ...shown, CLAUDE_MEM_OBSERVER_ENABLED: 'false' });

    expect(saved.status()).toBe(200);
    expect(JSON.parse(readFileSync(settingsPath, 'utf-8')).CLAUDE_MEM_OBSERVER_ENABLED).toBe('false');
  });

  it('shows "Keep images" on by default and persists turning it off from the viewer', () => {
    writeFileSync(settingsPath, JSON.stringify({}));
    const routes = handlers();
    const shown = call(routes['GET /api/settings']).payload;
    expect(shown.CLAUDE_MEM_MEDIA_CAPTURE_ENABLED).toBe('true');

    const saved = call(routes['POST /api/settings'], { ...shown, CLAUDE_MEM_MEDIA_CAPTURE_ENABLED: 'false' });

    expect(saved.status()).toBe(200);
    const onDisk = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    expect(onDisk.CLAUDE_MEM_MEDIA_CAPTURE_ENABLED).toBe('false');
    // The switch never turns inference on.
    expect(onDisk.CLAUDE_MEM_MEDIA_INFERENCE_ENABLED ?? 'false').toBe('false');
    expect(call(handlers()['GET /api/settings']).payload.CLAUDE_MEM_MEDIA_CAPTURE_ENABLED).toBe('false');
  });

  it('does not let the viewer turn image inference on', () => {
    writeFileSync(settingsPath, JSON.stringify({}));
    const routes = handlers();
    const shown = call(routes['GET /api/settings']).payload;

    call(routes['POST /api/settings'], { ...shown, CLAUDE_MEM_MEDIA_INFERENCE_ENABLED: 'true' });

    expect(JSON.parse(readFileSync(settingsPath, 'utf-8')).CLAUDE_MEM_MEDIA_INFERENCE_ENABLED ?? 'false').toBe('false');
  });
});

// GET shows environment overrides, so the viewer posts them back with every
// save. Persisted, such a value outlives the variable: an invalid one set in
// the environment kept failing requests after the variable was removed. A value
// whose only source is the environment is neither checked nor written.
describe('a viewer save never writes an environment override to settings.json', () => {
  const settingsPath = paths.settings();
  const ENV_KEYS = ['CLAUDE_MEM_CODEX_REASONING_EFFORT', 'CLAUDE_MEM_OPENROUTER_MODEL', 'CLAUDE_MEM_OPENROUTER_API_KEY'];
  let prior: string | undefined;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    prior = existsSync(settingsPath) ? readFileSync(settingsPath, 'utf-8') : undefined;
    savedEnv = {};
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    if (prior === undefined) rmSync(settingsPath, { force: true });
    else writeFileSync(settingsPath, prior, 'utf-8');
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  /** GET, then POST it back with one unrelated edit, as the viewer does. */
  function saveUnrelatedEdit() {
    const routes = handlers();
    const shown = call(routes['GET /api/settings']).payload;
    return call(routes['POST /api/settings'], { ...shown, CLAUDE_MEM_CONTEXT_OBSERVATIONS: '60' });
  }

  it('does not persist an invalid value set in the environment', () => {
    writeFileSync(settingsPath, JSON.stringify({ CLAUDE_MEM_CODEX_REASONING_EFFORT: 'low' }));
    process.env.CLAUDE_MEM_CODEX_REASONING_EFFORT = 'bogus';

    expect(saveUnrelatedEdit().status()).toBe(200);

    const after = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    expect(after.CLAUDE_MEM_CONTEXT_OBSERVATIONS).toBe('60');
    expect(after.CLAUDE_MEM_CODEX_REASONING_EFFORT).toBe('low');
  });

  it('does not write a value that only the environment sets', () => {
    writeFileSync(settingsPath, JSON.stringify({}));
    process.env.CLAUDE_MEM_OPENROUTER_MODEL = 'env-only/model';

    expect(saveUnrelatedEdit().status()).toBe(200);

    expect(JSON.parse(readFileSync(settingsPath, 'utf-8')).CLAUDE_MEM_OPENROUTER_MODEL).toBeUndefined();
  });

  it('keeps the stored key when the environment overrides it (GET shows the masked environment key)', () => {
    writeFileSync(settingsPath, JSON.stringify({ CLAUDE_MEM_OPENROUTER_API_KEY: 'sk-or-v1-stored-key-1111' }));
    process.env.CLAUDE_MEM_OPENROUTER_API_KEY = 'sk-or-v1-environment-key-2222';

    expect(saveUnrelatedEdit().status()).toBe(200);

    expect(JSON.parse(readFileSync(settingsPath, 'utf-8')).CLAUDE_MEM_OPENROUTER_API_KEY).toBe('sk-or-v1-stored-key-1111');
  });

  it('still checks and saves a field the user edits while the environment overrides it', () => {
    writeFileSync(settingsPath, JSON.stringify({ CLAUDE_MEM_CODEX_REASONING_EFFORT: 'low' }));
    process.env.CLAUDE_MEM_CODEX_REASONING_EFFORT = 'bogus';
    const routes = handlers();
    const shown = call(routes['GET /api/settings']).payload;

    expect(call(routes['POST /api/settings'], { ...shown, CLAUDE_MEM_CODEX_REASONING_EFFORT: 'also-bogus' }).status()).toBe(400);
    expect(call(routes['POST /api/settings'], { ...shown, CLAUDE_MEM_CODEX_REASONING_EFFORT: 'high' }).status()).toBe(200);
    expect(JSON.parse(readFileSync(settingsPath, 'utf-8')).CLAUDE_MEM_CODEX_REASONING_EFFORT).toBe('high');
  });
});

const SETTINGS_CASES: Array<[string, unknown[], unknown[]]> = [
  ['CLAUDE_MEM_CODEX_MODEL', ['test-model'], [42]],
  ['CLAUDE_MEM_CODEX_REASONING_EFFORT', ['', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'], [42, 'maximum']],
  ['CLAUDE_MEM_CLAUDE_CONFIG_DIR', ['/Users/matthewdnye/.ccs/instances/iveg50', ''], [42, '   ']],
  ['CLAUDE_MEM_FILE_READ_GATE_ENABLED', ['false'], ['maybe']],
  ['CLAUDE_MEM_QUOTA_FALLBACK_PROVIDER', ['claude', ''], ['anthropic']],
  ['CLAUDE_MEM_QUOTA_FALLBACK_MODEL', ['claude-haiku-4-5-20251001'], []],
  ['CLAUDE_MEM_PROVIDER_BY_SOURCE', ['{"codex":"codex","claude":"claude"}', { codex: 'codex' }, ''], [
    '{nope', '{"codex":"anthropic"}', '{"":"codex"}', '{"codex":"codex","Codex CLI":"claude"}', '["codex"]', 5,
  ]],
  ['CLAUDE_MEM_SESSION_START_INCLUDE_ALL_SOURCES', ['true'], ['sometimes']],
  ['CLAUDE_MEM_WORK_VIEW_AGENT', ['', 'claude-code', 'codex', 'gemini', 'off', 'all'], ['any']],
  ['CLAUDE_MEM_WORK_VIEW_COPY_PROVIDER', ['openrouter'], ['fallback']],
  ['CLAUDE_MEM_WORK_VIEW_COPY_MODEL', ['summary-model'], []],
  ...Object.values(STEP_MODEL_SETTINGS).map((key): [string, unknown[], unknown[]] => [
    key, ['haiku', ...(key === STEP_MODEL_SETTINGS.codex ? ['gpt-6'] : key === STEP_MODEL_SETTINGS.gemini ? ['flash-lite'] : []), '', 'm'.repeat(200)], [42, 'm'.repeat(201)],
  ]),
];

const FILE_ONLY_VALUES: Record<string, [string, string]> = {
  CLAUDE_CODE_PATH: ['/usr/local/bin/claude', '/untrusted/bin/claude'],
  CLAUDE_MEM_CODEX_PATH: ['/usr/local/bin/codex', '/untrusted/bin/codex'],
  CLAUDE_MEM_CHROMA_UVX_PATH: ['C:\\Python313\\Scripts\\uvx.exe', '/untrusted/bin/uvx'],
  CLAUDE_MEM_DATA_DIR: ['/home/owner/.claude-mem', '/untrusted/data'],
  CLAUDE_MEM_WORKER_HOST: ['127.0.0.1', '0.0.0.0'],
  CLAUDE_MEM_AUTO_UPDATE: ['false', 'true'],
  CLAUDE_MEM_AUTO_UPDATE_PROMOTED_RELEASE_URL: ['https://updates.example/stored.json', 'https://updates.example/posted.json'],
  CLAUDE_MEM_WORKER_INGEST_TOKEN: ['stored-ingest-token', 'replacement-ingest-token'],
};

const FILE_ONLY_CASES = [...new Set([...FILE_ONLY_SETTING_KEYS, ...Object.keys(FILE_ONLY_VALUES)])]
  .flatMap(key => [undefined, (FILE_ONLY_VALUES[key] ?? ['stored', 'posted'])[0]].map(stored => [
    key, stored, (FILE_ONLY_VALUES[key] ?? ['stored', 'posted'])[1],
  ] as const));

describe('settings write table', () => {
  const settingsPath = paths.settings();
  let prior: string | undefined;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    prior = existsSync(settingsPath) ? readFileSync(settingsPath, 'utf-8') : undefined;
    savedEnv = {};
    for (const [key] of SETTINGS_CASES) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    if (prior === undefined) rmSync(settingsPath, { force: true });
    else writeFileSync(settingsPath, prior, 'utf-8');
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it.each(SETTINGS_CASES)('%s validates and persists its accepted values', (key, accepted, rejected) => {
    const post = handlers()['POST /api/settings'];
    for (const value of accepted) {
      writeFileSync(settingsPath, JSON.stringify({ [key]: 'previous-value' }));
      const saved = call(post, { [key]: value });
      expect(saved.status()).toBe(200);
      expect(saved.payload).toEqual({ success: true, message: 'Settings updated successfully' });
      expect(JSON.parse(readFileSync(settingsPath, 'utf-8'))[key]).toEqual(value);
    }
    for (const value of rejected) {
      const before = JSON.stringify({ [key]: accepted[0] });
      writeFileSync(settingsPath, before);
      const saved = call(post, { [key]: value });
      expect(saved.status()).toBe(400);
      expect(saved.payload.success).toBe(false);
      expect(saved.payload.error).toContain(key);
      expect(readFileSync(settingsPath, 'utf-8')).toBe(before);
      if (key === 'CLAUDE_MEM_CODEX_REASONING_EFFORT' && value === 'maximum') expect(saved.payload.error).toContain('xhigh');
      if (key.startsWith('CLAUDE_MEM_CODEX_') && value === 42) expect(saved.payload.error).toBe(`${key} must be a string`);
      if (key === 'CLAUDE_MEM_FILE_READ_GATE_ENABLED') expect(saved.payload.error).toBe(`${key} must be "true" or "false"`);
      if (Object.values(STEP_MODEL_SETTINGS).some(setting => setting === key)) expect(saved.payload.error).toBe(`${key} must be a string of at most 200 characters`);
      if (key === 'CLAUDE_MEM_QUOTA_FALLBACK_PROVIDER') expect(saved.payload.error).toBe('CLAUDE_MEM_QUOTA_FALLBACK_PROVIDER must be "claude" (or empty, the default), "gemini", "openrouter", "openai-compatible", or "off"');
    }
  });

  it('ignores both filesystem and listener redirects in the same save', () => {
    writeFileSync(settingsPath, JSON.stringify({ CLAUDE_MEM_DATA_DIR: '/home/owner/.claude-mem', CLAUDE_MEM_WORKER_HOST: '127.0.0.1' }));
    const saved = call(handlers()['POST /api/settings'], {
      CLAUDE_MEM_DATA_DIR: '/untrusted/data', CLAUDE_MEM_WORKER_HOST: '0.0.0.0', CLAUDE_MEM_LOG_LEVEL: 'DEBUG',
    });
    expect(saved.status()).toBe(200);
    expect(saved.payload).toEqual({ success: true, message: 'Settings updated successfully' });
    const after = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    expect(after.CLAUDE_MEM_DATA_DIR).toBe('/home/owner/.claude-mem');
    expect(after.CLAUDE_MEM_WORKER_HOST).toBe('127.0.0.1');
    expect(after.CLAUDE_MEM_LOG_LEVEL).toBe('DEBUG');
  });

  it.each(FILE_ONLY_CASES)('%s preserves the file-only value %s during an unrelated save', (key, stored, posted) => {
    writeFileSync(settingsPath, JSON.stringify(stored === undefined ? {} : { [key]: stored }));
    const saved = call(handlers()['POST /api/settings'], { [key]: posted, CLAUDE_MEM_LOG_LEVEL: 'DEBUG' });
    expect(saved.status()).toBe(200);
    expect(saved.payload).toEqual({ success: true, message: 'Settings updated successfully' });
    const after = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    expect(after[key]).toBe(stored);
    expect(after.CLAUDE_MEM_LOG_LEVEL).toBe('DEBUG');
  });
});
