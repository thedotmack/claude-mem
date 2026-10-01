import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import type { Request, Response } from 'express';
import { existsSync, readFileSync, writeFileSync, rmSync } from 'fs';
import { SettingsRoutes } from '../../../../src/services/worker/http/routes/SettingsRoutes.js';
import { paths } from '../../../../src/shared/paths.js';

function createMockRes(): {
  res: Partial<Response>;
  jsonSpy: ReturnType<typeof mock>;
  statusSpy: ReturnType<typeof mock>;
} {
  const jsonSpy = mock(() => {});
  const statusSpy = mock(() => ({ json: jsonSpy }));
  return {
    res: { json: jsonSpy, status: statusSpy, headersSent: false } as unknown as Partial<Response>,
    jsonSpy,
    statusSpy,
  };
}

function captureSettingsPostHandler(routes: SettingsRoutes): (req: Request, res: Response) => void {
  let handler!: (req: Request, res: Response) => void;
  const mockApp: any = {
    get: mock(() => {}),
    post: mock((path: string, ...handlers: Array<(req: Request, res: Response) => void>) => {
      if (path === '/api/settings') {
        handler = handlers[handlers.length - 1];
      }
    }),
  };
  routes.setupRoutes(mockApp);
  return (req: Request, res: Response): void => handler(req, res);
}

function post(handler: (req: Request, res: Response) => void, body: Record<string, string>) {
  const mockRes = createMockRes();
  handler({ body, path: '/api/settings', params: {}, query: {}, headers: {} } as Request, mockRes.res as Response);
  return mockRes;
}

describe('SettingsRoutes — quota fallback keys', () => {
  const settingsPath = paths.settings();
  let priorSettingsContent: string | undefined;
  let handler: (req: Request, res: Response) => void;

  beforeEach(() => {
    priorSettingsContent = existsSync(settingsPath) ? readFileSync(settingsPath, 'utf-8') : undefined;
    handler = captureSettingsPostHandler(new SettingsRoutes({} as any));
    writeFileSync(settingsPath, JSON.stringify({ CLAUDE_MEM_PROVIDER: 'gemini' }));
  });

  afterEach(() => {
    if (priorSettingsContent === undefined) {
      rmSync(settingsPath, { force: true });
    } else {
      writeFileSync(settingsPath, priorSettingsContent, 'utf-8');
    }
  });

  it('saves both keys from the viewer', () => {
    const { jsonSpy } = post(handler, {
      CLAUDE_MEM_QUOTA_FALLBACK_PROVIDER: 'claude',
      CLAUDE_MEM_QUOTA_FALLBACK_MODEL: 'claude-haiku-4-5-20251001',
    });
    expect(jsonSpy).toHaveBeenCalledWith({ success: true, message: 'Settings updated successfully' });
    const persisted = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    expect(persisted.CLAUDE_MEM_QUOTA_FALLBACK_PROVIDER).toBe('claude');
    expect(persisted.CLAUDE_MEM_QUOTA_FALLBACK_MODEL).toBe('claude-haiku-4-5-20251001');
  });

  it('turns the fallback off with an empty value', () => {
    post(handler, { CLAUDE_MEM_QUOTA_FALLBACK_PROVIDER: 'claude' });
    const { jsonSpy } = post(handler, { CLAUDE_MEM_QUOTA_FALLBACK_PROVIDER: '' });
    expect(jsonSpy).toHaveBeenCalledWith({ success: true, message: 'Settings updated successfully' });
    expect(JSON.parse(readFileSync(settingsPath, 'utf-8')).CLAUDE_MEM_QUOTA_FALLBACK_PROVIDER).toBe('');
  });

  it('rejects an unknown fallback provider and leaves the file alone', () => {
    const before = readFileSync(settingsPath, 'utf-8');
    const { jsonSpy, statusSpy } = post(handler, { CLAUDE_MEM_QUOTA_FALLBACK_PROVIDER: 'anthropic' });
    expect(statusSpy).toHaveBeenCalledWith(400);
    expect(jsonSpy).toHaveBeenCalledWith({
      success: false,
      error: 'CLAUDE_MEM_QUOTA_FALLBACK_PROVIDER must be empty (off), "claude", "gemini", "openrouter", or "openai-compatible"',
    });
    expect(readFileSync(settingsPath, 'utf-8')).toBe(before);
  });
});
