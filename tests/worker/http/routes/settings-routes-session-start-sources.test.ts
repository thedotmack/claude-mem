import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import type { Request, Response } from 'express';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { SettingsRoutes } from '../../../../src/services/worker/http/routes/SettingsRoutes.js';
import { paths } from '../../../../src/shared/paths.js';

describe('SessionStart source scope setting', () => {
  const settingsPath = paths.settings();
  let previousSettings: string | undefined;
  let postSettings: (req: Request, res: Response) => void;

  beforeEach(() => {
    previousSettings = existsSync(settingsPath) ? readFileSync(settingsPath, 'utf-8') : undefined;
    const app = {
      get: mock(() => {}),
      post: mock((route: string, ...handlers: Array<(req: Request, res: Response) => void>) => {
        if (route === '/api/settings') postSettings = handlers[handlers.length - 1];
      }),
    };
    new SettingsRoutes({} as any).setupRoutes(app as any);
  });

  afterEach(() => {
    if (previousSettings === undefined) rmSync(settingsPath, { force: true });
    else writeFileSync(settingsPath, previousSettings, 'utf-8');
  });

  it('persists the opt-in through the settings API', () => {
    const json = mock(() => {});
    const req = { body: { CLAUDE_MEM_SESSION_START_INCLUDE_ALL_SOURCES: 'true' }, path: '/api/settings', params: {}, query: {} } as unknown as Request;
    const res = { json, status: mock(() => ({ json })), headersSent: false } as unknown as Response;

    postSettings(req, res);

    expect(json).toHaveBeenCalledWith({ success: true, message: 'Settings updated successfully' });
    expect(JSON.parse(readFileSync(settingsPath, 'utf-8')).CLAUDE_MEM_SESSION_START_INCLUDE_ALL_SOURCES).toBe('true');
  });

  it('rejects an unsupported scope value', () => {
    const json = mock(() => {});
    const status = mock(() => ({ json }));
    const req = { body: { CLAUDE_MEM_SESSION_START_INCLUDE_ALL_SOURCES: 'sometimes' }, path: '/api/settings', params: {}, query: {} } as unknown as Request;
    const res = { json, status, headersSent: false } as unknown as Response;
    const before = existsSync(settingsPath) ? readFileSync(settingsPath, 'utf-8') : undefined;

    postSettings(req, res);

    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ success: false }));
    expect(existsSync(settingsPath) ? readFileSync(settingsPath, 'utf-8') : undefined).toBe(before);
  });
});
