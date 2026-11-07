import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import type { Request, Response } from 'express';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { SettingsRoutes } from '../../../../src/services/worker/http/routes/SettingsRoutes.js';
import { paths } from '../../../../src/shared/paths.js';

function postSettings(body: Record<string, unknown>): { json: ReturnType<typeof mock> } {
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
  return { json };
}

// CLAUDE_MEM_CHROMA_UVX_PATH names the uvx binary the worker spawns for
// chroma-mcp (#4195), so like the other spawn paths it is file/env only.
describe('SettingsRoutes — CLAUDE_MEM_CHROMA_UVX_PATH is not HTTP-writable', () => {
  const settingsPath = paths.settings();
  let prior: string | undefined;

  beforeEach(() => {
    prior = existsSync(settingsPath) ? readFileSync(settingsPath, 'utf-8') : undefined;
  });

  afterEach(() => {
    if (prior === undefined) rmSync(settingsPath, { force: true });
    else writeFileSync(settingsPath, prior, 'utf-8');
  });

  it('does not persist a uvx path from POST /api/settings', () => {
    writeFileSync(settingsPath, JSON.stringify({}));
    const { json } = postSettings({ CLAUDE_MEM_CHROMA_UVX_PATH: '/tmp/attacker-controlled-binary', CLAUDE_MEM_LOG_LEVEL: 'DEBUG' });
    expect(json).toHaveBeenCalledWith({ success: true, message: 'Settings updated successfully' });
    const persisted = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    expect(persisted.CLAUDE_MEM_CHROMA_UVX_PATH).toBeUndefined();
    expect(persisted.CLAUDE_MEM_LOG_LEVEL).toBe('DEBUG');
  });

  it('keeps a file-configured uvx path when the viewer posts another one', () => {
    writeFileSync(settingsPath, JSON.stringify({ CLAUDE_MEM_CHROMA_UVX_PATH: 'C:\\Python313\\Scripts\\uvx.exe' }));
    const { json } = postSettings({ CLAUDE_MEM_CHROMA_UVX_PATH: '/tmp/attacker-controlled-binary', CLAUDE_MEM_LOG_LEVEL: 'DEBUG' });
    expect(json).toHaveBeenCalledWith({ success: true, message: 'Settings updated successfully' });
    const persisted = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    expect(persisted.CLAUDE_MEM_CHROMA_UVX_PATH).toBe('C:\\Python313\\Scripts\\uvx.exe');
    expect(persisted.CLAUDE_MEM_LOG_LEVEL).toBe('DEBUG');
  });
});
