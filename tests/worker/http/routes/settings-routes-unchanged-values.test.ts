// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import type { Request, Response } from 'express';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { SettingsRoutes } from '../../../../src/services/worker/http/routes/SettingsRoutes.js';
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
});
