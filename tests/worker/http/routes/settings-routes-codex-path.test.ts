import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import type { Request, Response } from 'express';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { SettingsRoutes } from '../../../../src/services/worker/http/routes/SettingsRoutes.js';
import { paths } from '../../../../src/shared/paths.js';

function postSettings(body: Record<string, unknown>): ReturnType<typeof mock> {
  let handler!: (req: Request, res: Response) => void;
  const app: any = {
    get: mock(() => {}),
    post: mock((path: string, ...handlers: Array<(req: Request, res: Response) => void>) => {
      if (path === '/api/settings') handler = handlers[handlers.length - 1];
    }),
  };
  new SettingsRoutes({} as any).setupRoutes(app);
  const json = mock(() => {});
  const res = { json, status: mock(() => ({ json })), headersSent: false } as unknown as Response;
  handler({ body, path: '/api/settings', params: {}, query: {}, headers: {} } as Request, res);
  return json;
}

describe('SettingsRoutes — CLAUDE_MEM_CODEX_PATH is not HTTP-writable', () => {
  const settingsPath = paths.settings();
  let prior: string | undefined;

  beforeEach(() => {
    prior = existsSync(settingsPath) ? readFileSync(settingsPath, 'utf-8') : undefined;
  });

  afterEach(() => {
    if (prior === undefined) rmSync(settingsPath, { force: true });
    else writeFileSync(settingsPath, prior, 'utf-8');
  });

  it('does not persist a Codex executable path from POST /api/settings', () => {
    writeFileSync(settingsPath, JSON.stringify({ CLAUDE_MEM_PROVIDER: 'codex' }));
    const json = postSettings({ CLAUDE_MEM_CODEX_PATH: '/tmp/attacker-controlled-binary', CLAUDE_MEM_CODEX_MODEL: 'test-model' });
    expect(json).toHaveBeenCalledWith({ success: true, message: 'Settings updated successfully' });
    const persisted = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    expect(persisted.CLAUDE_MEM_CODEX_PATH).toBeUndefined();
    expect(persisted.CLAUDE_MEM_CODEX_MODEL).toBe('test-model');
  });

  it('keeps a file-configured Codex executable path when the viewer echoes GET', () => {
    writeFileSync(settingsPath, JSON.stringify({ CLAUDE_MEM_CODEX_PATH: '/usr/local/bin/codex' }));
    const json = postSettings({ CLAUDE_MEM_CODEX_PATH: '/tmp/attacker-controlled-binary', CLAUDE_MEM_LOG_LEVEL: 'DEBUG' });
    expect(json).toHaveBeenCalledWith({ success: true, message: 'Settings updated successfully' });
    const persisted = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    expect(persisted.CLAUDE_MEM_CODEX_PATH).toBe('/usr/local/bin/codex');
    expect(persisted.CLAUDE_MEM_LOG_LEVEL).toBe('DEBUG');
  });
});
