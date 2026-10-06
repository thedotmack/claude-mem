import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import type { Request, Response } from 'express';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { SettingsRoutes } from '../../../../src/services/worker/http/routes/SettingsRoutes.js';
import { SettingsDefaultsManager } from '../../../../src/shared/SettingsDefaultsManager.js';
import { paths } from '../../../../src/shared/paths.js';

describe('File Read Gate setting', () => {
  const settingsPath = paths.settings();
  let previousSettings: string | undefined;
  let originalEnvValue: string | undefined;
  let postSettings: (req: Request, res: Response) => void;

  beforeEach(() => {
    previousSettings = existsSync(settingsPath) ? readFileSync(settingsPath, 'utf-8') : undefined;
    // An exported override would make the POSTed value an environment echo, which the route drops.
    originalEnvValue = process.env.CLAUDE_MEM_FILE_READ_GATE_ENABLED;
    delete process.env.CLAUDE_MEM_FILE_READ_GATE_ENABLED;
    const app = {
      get: mock(() => {}),
      post: mock((route: string, ...handlers: Array<(req: Request, res: Response) => void>) => {
        if (route === '/api/settings') postSettings = handlers[handlers.length - 1];
      }),
    };
    new SettingsRoutes({} as any).setupRoutes(app as any);
  });

  afterEach(() => {
    if (originalEnvValue === undefined) delete process.env.CLAUDE_MEM_FILE_READ_GATE_ENABLED;
    else process.env.CLAUDE_MEM_FILE_READ_GATE_ENABLED = originalEnvValue;
    if (previousSettings === undefined) rmSync(settingsPath, { force: true });
    else writeFileSync(settingsPath, previousSettings, 'utf-8');
  });

  it('persists turning the gate off through the settings API', () => {
    const json = mock(() => {});
    const req = { body: { CLAUDE_MEM_FILE_READ_GATE_ENABLED: 'false' }, path: '/api/settings', params: {}, query: {} } as unknown as Request;
    const res = { json, status: mock(() => ({ json })), headersSent: false } as unknown as Response;

    postSettings(req, res);

    expect(json).toHaveBeenCalledWith({ success: true, message: 'Settings updated successfully' });
    expect(JSON.parse(readFileSync(settingsPath, 'utf-8')).CLAUDE_MEM_FILE_READ_GATE_ENABLED).toBe('false');
  });

  it('rejects a value other than "true" or "false"', () => {
    const json = mock(() => {});
    const status = mock(() => ({ json }));
    const req = { body: { CLAUDE_MEM_FILE_READ_GATE_ENABLED: 'maybe' }, path: '/api/settings', params: {}, query: {} } as unknown as Request;
    const res = { json, status, headersSent: false } as unknown as Response;
    // The route's own loadFromFile creates a missing settings.json; create it first so the snapshot holds whatever the route will read.
    SettingsDefaultsManager.loadFromFile(settingsPath);
    const before = readFileSync(settingsPath, 'utf-8');

    postSettings(req, res);

    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith({ success: false, error: 'CLAUDE_MEM_FILE_READ_GATE_ENABLED must be "true" or "false"' });
    expect(readFileSync(settingsPath, 'utf-8')).toBe(before);
  });
});
