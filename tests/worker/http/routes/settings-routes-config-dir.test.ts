import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import type { Request, Response } from 'express';
import { existsSync, readFileSync, writeFileSync, rmSync } from 'fs';
import { SettingsRoutes } from '../../../../src/services/worker/http/routes/SettingsRoutes.js';
import { paths } from '../../../../src/shared/paths.js';

/**
 * #2753 round 2 — a review finding noted that CLAUDE_MEM_CLAUDE_CONFIG_DIR
 * was added to the POST /api/settings write-whitelist with zero test
 * coverage anywhere in the repo (`grep -rl "SettingsRoutes" tests/` returned
 * nothing before this file). This exercises the actual route handler so a
 * future silent removal of the whitelist entry — or a validation regression —
 * is caught, without touching the real ~/.claude-mem (paths.settings()
 * resolves under the per-run temp DATA_DIR that tests/preload.ts pins before
 * any module loads).
 */

function createMockReqRes(body: any): {
  req: Partial<Request>;
  res: Partial<Response>;
  jsonSpy: ReturnType<typeof mock>;
  statusSpy: ReturnType<typeof mock>;
} {
  const jsonSpy = mock(() => {});
  const statusSpy = mock(() => ({ json: jsonSpy }));
  return {
    req: { body, path: '/api/settings', params: {}, query: {} } as Partial<Request>,
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

describe('SettingsRoutes — CLAUDE_MEM_CLAUDE_CONFIG_DIR write whitelist (#2753 round 2)', () => {
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

  it('round-trips a valid path value through POST /api/settings', () => {
    const { req, res, jsonSpy } = createMockReqRes({
      CLAUDE_MEM_CLAUDE_CONFIG_DIR: '/Users/matthewdnye/.ccs/instances/iveg50',
    });

    handler(req as Request, res as Response);

    expect(jsonSpy).toHaveBeenCalledWith({ success: true, message: 'Settings updated successfully' });
    const persisted = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    expect(persisted.CLAUDE_MEM_CLAUDE_CONFIG_DIR).toBe('/Users/matthewdnye/.ccs/instances/iveg50');
  });

  it('accepts an empty string (the documented "use the default" sentinel)', () => {
    const { req, res, jsonSpy } = createMockReqRes({ CLAUDE_MEM_CLAUDE_CONFIG_DIR: '' });

    handler(req as Request, res as Response);

    expect(jsonSpy).toHaveBeenCalledWith({ success: true, message: 'Settings updated successfully' });
    const persisted = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    expect(persisted.CLAUDE_MEM_CLAUDE_CONFIG_DIR).toBe('');
  });

  it('rejects a non-string value (e.g. a number) with 400 and does not persist it', () => {
    const { req, res, statusSpy, jsonSpy } = createMockReqRes({ CLAUDE_MEM_CLAUDE_CONFIG_DIR: 42 });
    const before = existsSync(settingsPath) ? readFileSync(settingsPath, 'utf-8') : undefined;

    handler(req as Request, res as Response);

    expect(statusSpy).toHaveBeenCalledWith(400);
    expect(jsonSpy).toHaveBeenCalledWith(expect.objectContaining({ success: false }));
    const after = existsSync(settingsPath) ? readFileSync(settingsPath, 'utf-8') : undefined;
    expect(after).toBe(before);
  });

  it('rejects a whitespace-only value with 400', () => {
    const { req, res, statusSpy } = createMockReqRes({ CLAUDE_MEM_CLAUDE_CONFIG_DIR: '   ' });

    handler(req as Request, res as Response);

    expect(statusSpy).toHaveBeenCalledWith(400);
  });
});
