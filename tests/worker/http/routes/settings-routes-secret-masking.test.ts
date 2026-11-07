// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import type { Request, Response } from 'express';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { SettingsRoutes } from '../../../../src/services/worker/http/routes/SettingsRoutes.js';
import { paths } from '../../../../src/shared/paths.js';

// Wave 3 gate R4-8: GET /api/settings is unauthenticated. A key pool written
// as a JSON array (api-key-pool accepts arrays) came back in cleartext. These
// tests drive the real handlers: every secret shape is masked on GET, and a
// viewer save that posts the GET body back unchanged keeps every stored value.

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

describe('GET /api/settings masks every secret shape', () => {
  const settingsPath = paths.settings();
  let prior: string | undefined;

  beforeEach(() => {
    prior = existsSync(settingsPath) ? readFileSync(settingsPath, 'utf-8') : undefined;
  });

  afterEach(() => {
    if (prior === undefined) rmSync(settingsPath, { force: true });
    else writeFileSync(settingsPath, prior, 'utf-8');
  });

  const STORED = {
    CLAUDE_MEM_PROVIDER: 'openrouter',
    CLAUDE_MEM_OPENROUTER_API_KEY: 'sk-or-v1-singleSECRET0001',
    CLAUDE_MEM_OPENROUTER_API_KEYS: ['sk-or-v1-arraySECRET0002', 'sk-or-v1-arraySECRET0003'],
    CLAUDE_MEM_GEMINI_API_KEYS: 'AIza-listSECRET0004,AIza-listSECRET0005',
    CLAUDE_MEM_OPENAI_COMPAT_API_KEYS: 'nvapi-lineSECRET0006\nnvapi-lineSECRET0007',
    CLAUDE_MEM_OPENAI_COMPAT_API_KEY: 'nvapi-singleSECRET0008',
  };

  it('never returns a stored key in cleartext, whether a string, a comma or newline list, or an array', () => {
    writeFileSync(settingsPath, JSON.stringify(STORED));
    const text = JSON.stringify(call(handlers()['GET /api/settings']).payload);
    for (const secret of ['singleSECRET0001', 'arraySECRET0002', 'arraySECRET0003', 'listSECRET0004', 'listSECRET0005', 'lineSECRET0006', 'lineSECRET0007', 'singleSECRET0008']) {
      expect(text).not.toContain(secret);
    }
  });

  it('keeps every stored key when the viewer posts the GET body back unchanged', () => {
    writeFileSync(settingsPath, JSON.stringify(STORED));
    const routes = handlers();
    const got = call(routes['GET /api/settings']).payload;
    const posted = call(routes['POST /api/settings'], got);
    expect(posted.status()).toBe(200);

    const after = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    expect(after.CLAUDE_MEM_OPENROUTER_API_KEY).toBe(STORED.CLAUDE_MEM_OPENROUTER_API_KEY);
    expect(after.CLAUDE_MEM_OPENROUTER_API_KEYS).toEqual(STORED.CLAUDE_MEM_OPENROUTER_API_KEYS);
    expect(after.CLAUDE_MEM_GEMINI_API_KEYS).toBe(STORED.CLAUDE_MEM_GEMINI_API_KEYS);
    expect(after.CLAUDE_MEM_OPENAI_COMPAT_API_KEYS).toBe(STORED.CLAUDE_MEM_OPENAI_COMPAT_API_KEYS);
    expect(after.CLAUDE_MEM_OPENAI_COMPAT_API_KEY).toBe(STORED.CLAUDE_MEM_OPENAI_COMPAT_API_KEY);
  });

  it('still takes a real replacement pool from the viewer', () => {
    writeFileSync(settingsPath, JSON.stringify(STORED));
    const routes = handlers();
    const got = call(routes['GET /api/settings']).payload;
    call(routes['POST /api/settings'], { ...got, CLAUDE_MEM_OPENROUTER_API_KEYS: 'sk-or-v1-new1,sk-or-v1-new2' });

    const after = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    expect(after.CLAUDE_MEM_OPENROUTER_API_KEYS).toBe('sk-or-v1-new1,sk-or-v1-new2');
  });
});
