import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import type { Request, Response } from 'express';
import { existsSync, readFileSync, writeFileSync, rmSync } from 'fs';
import {
  SettingsRoutes,
  isForeignLoopbackBrowserWrite,
} from '../../../../src/services/worker/http/routes/SettingsRoutes.js';
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

describe('isForeignLoopbackBrowserWrite', () => {
  it('allows Origin-less requests (hooks, CLI, curl)', () => {
    expect(isForeignLoopbackBrowserWrite({ headers: {} } as Request)).toBe(false);
    expect(isForeignLoopbackBrowserWrite({ headers: { host: '127.0.0.1:37777' } } as Request)).toBe(false);
  });

  it('allows same-port loopback origins, including localhost ↔ 127.0.0.1', () => {
    expect(isForeignLoopbackBrowserWrite({
      headers: { origin: 'http://localhost:37777', host: '127.0.0.1:37777' },
    } as Request)).toBe(false);
    expect(isForeignLoopbackBrowserWrite({
      headers: { origin: 'http://127.0.0.1:37777', host: 'localhost:37777' },
    } as Request)).toBe(false);
  });

  it('rejects another localhost port (browser CSRF from a different local origin)', () => {
    expect(isForeignLoopbackBrowserWrite({
      headers: { origin: 'http://localhost:3000', host: '127.0.0.1:37777' },
    } as Request)).toBe(true);
  });

  it('rejects a non-loopback or unparseable Origin', () => {
    expect(isForeignLoopbackBrowserWrite({
      headers: { origin: 'http://evil.example', host: '127.0.0.1:37777' },
    } as Request)).toBe(true);
    expect(isForeignLoopbackBrowserWrite({
      headers: { origin: 'not-a-url', host: '127.0.0.1:37777' },
    } as Request)).toBe(true);
  });
});

describe('SettingsRoutes — CLAUDE_CODE_PATH is not HTTP-writable', () => {
  const settingsPath = paths.settings();
  let priorSettingsContent: string | undefined;
  let handler: (req: Request, res: Response) => void;

  beforeEach(() => {
    priorSettingsContent = existsSync(settingsPath) ? readFileSync(settingsPath, 'utf-8') : undefined;
    handler = captureSettingsPostHandler(new SettingsRoutes({} as any));
  });

  afterEach(() => {
    if (priorSettingsContent === undefined) {
      try {
        rmSync(settingsPath, { force: true });
      } catch {
        // best effort
      }
    } else {
      writeFileSync(settingsPath, priorSettingsContent, 'utf-8');
    }
  });

  it('does not persist CLAUDE_CODE_PATH from POST /api/settings', () => {
    writeFileSync(settingsPath, JSON.stringify({
      CLAUDE_MEM_MODEL: 'claude-haiku-4-5-20251001',
    }));

    const { res, jsonSpy } = createMockRes();
    handler({
      body: {
        CLAUDE_CODE_PATH: '/tmp/attacker-controlled-binary',
        CLAUDE_MEM_MODEL: 'claude-sonnet-5',
      },
      path: '/api/settings',
      params: {},
      query: {},
      headers: {},
    } as Request, res as Response);

    expect(jsonSpy).toHaveBeenCalledWith({ success: true, message: 'Settings updated successfully' });
    const persisted = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    expect(persisted.CLAUDE_CODE_PATH).toBeUndefined();
    expect(persisted.CLAUDE_MEM_MODEL).toBe('claude-sonnet-5');
  });

  it('leaves an existing file/env CLAUDE_CODE_PATH unchanged when the viewer echoes GET', () => {
    writeFileSync(settingsPath, JSON.stringify({
      CLAUDE_CODE_PATH: '/usr/local/bin/claude',
      CLAUDE_MEM_LOG_LEVEL: 'INFO',
    }));

    const { res, jsonSpy } = createMockRes();
    handler({
      body: {
        CLAUDE_CODE_PATH: '/tmp/attacker-controlled-binary',
        CLAUDE_MEM_LOG_LEVEL: 'DEBUG',
      },
      path: '/api/settings',
      params: {},
      query: {},
      headers: {},
    } as Request, res as Response);

    expect(jsonSpy).toHaveBeenCalledWith({ success: true, message: 'Settings updated successfully' });
    const persisted = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    expect(persisted.CLAUDE_CODE_PATH).toBe('/usr/local/bin/claude');
    expect(persisted.CLAUDE_MEM_LOG_LEVEL).toBe('DEBUG');
  });

  it('rejects a browser POST from a different localhost origin', () => {
    writeFileSync(settingsPath, JSON.stringify({
      CLAUDE_MEM_MODEL: 'claude-haiku-4-5-20251001',
    }));

    const { res, statusSpy, jsonSpy } = createMockRes();
    handler({
      body: { CLAUDE_MEM_MODEL: 'claude-sonnet-5' },
      path: '/api/settings',
      params: {},
      query: {},
      headers: { origin: 'http://localhost:3000', host: '127.0.0.1:37777' },
    } as unknown as Request, res as Response);

    expect(statusSpy).toHaveBeenCalledWith(403);
    expect(jsonSpy).toHaveBeenCalledWith(expect.objectContaining({ success: false }));
    const persisted = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    expect(persisted.CLAUDE_MEM_MODEL).toBe('claude-haiku-4-5-20251001');
  });
});
