import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import type { Request, Response } from 'express';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { SettingsRoutes } from '../../../../src/services/worker/http/routes/SettingsRoutes.js';
import { paths } from '../../../../src/shared/paths.js';

function postSettings(body: Record<string, unknown>): { json: ReturnType<typeof mock>; status: ReturnType<typeof mock> } {
  let handler!: (req: Request, res: Response) => void;
  const app: any = {
    get: mock(() => {}),
    post: mock((path: string, ...handlers: Array<(req: Request, res: Response) => void>) => {
      if (path === '/api/settings') handler = handlers[handlers.length - 1];
    }),
  };
  new SettingsRoutes({} as any).setupRoutes(app);
  const json = mock(() => {});
  const status = mock(() => ({ json }));
  const res = { json, status, headersSent: false } as unknown as Response;
  handler({ body, path: '/api/settings', params: {}, query: {}, headers: {} } as Request, res);
  return { json, status };
}

// CLAUDE_MEM_DATA_DIR holds every memory and secret, and CLAUDE_MEM_WORKER_HOST
// picks the interface the worker listens on. Neither may be changed over HTTP (#5141).
describe('SettingsRoutes — CLAUDE_MEM_DATA_DIR and CLAUDE_MEM_WORKER_HOST are file-only', () => {
  const settingsPath = paths.settings();
  let prior: string | undefined;

  beforeEach(() => {
    prior = existsSync(settingsPath) ? readFileSync(settingsPath, 'utf-8') : undefined;
  });

  afterEach(() => {
    if (prior === undefined) rmSync(settingsPath, { force: true });
    else writeFileSync(settingsPath, prior, 'utf-8');
  });

  it('ignores both keys in a POST while still saving a whitelisted key from it', () => {
    writeFileSync(settingsPath, JSON.stringify({ CLAUDE_MEM_DATA_DIR: '/home/owner/.claude-mem', CLAUDE_MEM_WORKER_HOST: '127.0.0.1' }));
    const { json } = postSettings({
      CLAUDE_MEM_DATA_DIR: '/tmp/attacker-controlled-dir',
      CLAUDE_MEM_WORKER_HOST: '0.0.0.0',
      CLAUDE_MEM_LOG_LEVEL: 'DEBUG',
    });
    expect(json).toHaveBeenCalledWith({ success: true, message: 'Settings updated successfully' });
    const persisted = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    expect(persisted.CLAUDE_MEM_DATA_DIR).toBe('/home/owner/.claude-mem');
    expect(persisted.CLAUDE_MEM_WORKER_HOST).toBe('127.0.0.1');
    expect(persisted.CLAUDE_MEM_LOG_LEVEL).toBe('DEBUG');
  });
});
