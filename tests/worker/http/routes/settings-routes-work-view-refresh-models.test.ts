import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import type { Request, Response } from 'express';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { SettingsRoutes } from '../../../../src/services/worker/http/routes/SettingsRoutes.js';
import { STEP_MODEL_SETTINGS } from '../../../../src/services/work-view/refresh-task.js';
import { paths } from '../../../../src/shared/paths.js';

function createMockReqRes(body: unknown) {
  const jsonSpy = mock(() => {});
  const statusSpy = mock(() => ({ json: jsonSpy }));
  return {
    req: { body, path: '/api/settings', params: {}, query: {} } as Partial<Request>,
    res: { json: jsonSpy, status: statusSpy, headersSent: false } as unknown as Partial<Response>,
    jsonSpy, statusSpy,
  };
}

function capturePost(): (req: Request, res: Response) => void {
  let handler!: (req: Request, res: Response) => void;
  new SettingsRoutes({} as any).setupRoutes({
    get: mock(() => {}),
    post: mock((path: string, ...handlers: Array<(req: Request, res: Response) => void>) => {
      if (path === '/api/settings') handler = handlers[handlers.length - 1];
    }),
  } as any);
  return (req, res) => handler(req, res);
}

describe('SettingsRoutes — My Work refresh model settings (#5164)', () => {
  const settingsPath = paths.settings();
  const KEYS = Object.values(STEP_MODEL_SETTINGS);
  let prior: string | undefined;
  let post: (req: Request, res: Response) => void;

  beforeEach(() => {
    prior = existsSync(settingsPath) ? readFileSync(settingsPath, 'utf-8') : undefined;
    post = capturePost();
  });
  afterEach(() => {
    if (prior === undefined) rmSync(settingsPath, { force: true });
    else writeFileSync(settingsPath, prior, 'utf-8');
  });

  const save = (body: Record<string, unknown>) => {
    const call = createMockReqRes(body);
    post(call.req as Request, call.res as Response);
    return call;
  };
  const stored = () => JSON.parse(readFileSync(settingsPath, 'utf-8'));

  it('saves all three keys through the API', () => {
    const { jsonSpy } = save({
      CLAUDE_MEM_WORK_VIEW_CLAUDE_MODEL: 'haiku',
      CLAUDE_MEM_WORK_VIEW_CODEX_MODEL: 'gpt-6',
      CLAUDE_MEM_WORK_VIEW_GEMINI_MODEL: 'flash-lite',
    });
    expect(jsonSpy).toHaveBeenCalledWith({ success: true, message: 'Settings updated successfully' });
    expect(stored().CLAUDE_MEM_WORK_VIEW_CLAUDE_MODEL).toBe('haiku');
    expect(stored().CLAUDE_MEM_WORK_VIEW_CODEX_MODEL).toBe('gpt-6');
    expect(stored().CLAUDE_MEM_WORK_VIEW_GEMINI_MODEL).toBe('flash-lite');
  });

  it('clears a key back to the per-step defaults with an empty string', () => {
    for (const key of KEYS) {
      save({ [key]: 'haiku' });
      expect(stored()[key]).toBe('haiku');
      const { jsonSpy } = save({ [key]: '' });
      expect(jsonSpy).toHaveBeenCalledWith({ success: true, message: 'Settings updated successfully' });
      expect(stored()[key]).toBe('');
    }
  });

  it('rejects a non-string or over-200-character value without changing the file', () => {
    save(Object.fromEntries(KEYS.map(key => [key, 'existing-model'])));
    const before = readFileSync(settingsPath, 'utf-8');
    for (const key of KEYS) {
      for (const invalid of [42, 'm'.repeat(201)]) {
        const { statusSpy, jsonSpy } = save({ [key]: invalid });
        expect(statusSpy).toHaveBeenCalledWith(400);
        expect(jsonSpy).toHaveBeenCalledWith(expect.objectContaining({ error: `${key} must be a string of at most 200 characters` }));
        expect(readFileSync(settingsPath, 'utf-8')).toBe(before);
      }
    }
  });

  it('accepts a value of exactly 200 characters', () => {
    const { jsonSpy } = save({ CLAUDE_MEM_WORK_VIEW_CLAUDE_MODEL: 'm'.repeat(200) });
    expect(jsonSpy).toHaveBeenCalledWith({ success: true, message: 'Settings updated successfully' });
    expect(stored().CLAUDE_MEM_WORK_VIEW_CLAUDE_MODEL).toBe('m'.repeat(200));
  });
});
