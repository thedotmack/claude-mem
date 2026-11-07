import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import type { Request, Response } from 'express';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { SettingsRoutes } from '../../../../src/services/worker/http/routes/SettingsRoutes.js';
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

describe('SettingsRoutes — CLAUDE_MEM_WORK_VIEW_AGENT (#5189)', () => {
  const settingsPath = paths.settings();
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

  it('validates and persists valid CLAUDE_MEM_WORK_VIEW_AGENT values', async () => {
    for (const valid of ['', 'claude-code', 'codex', 'gemini', 'off', 'all']) {
      const { req, res, statusSpy } = createMockReqRes({ CLAUDE_MEM_WORK_VIEW_AGENT: valid });
      await post(req as Request, res as Response);
      expect(statusSpy).not.toHaveBeenCalledWith(400);
      const stored = JSON.parse(readFileSync(settingsPath, 'utf-8'));
      expect(stored.CLAUDE_MEM_WORK_VIEW_AGENT).toBe(valid);
    }
  });

  it('rejects invalid CLAUDE_MEM_WORK_VIEW_AGENT values with 400', async () => {
    const { req, res, statusSpy, jsonSpy } = createMockReqRes({ CLAUDE_MEM_WORK_VIEW_AGENT: 'any' });
    await post(req as Request, res as Response);
    expect(statusSpy).toHaveBeenCalledWith(400);
    expect(jsonSpy).toHaveBeenCalledWith(expect.objectContaining({
      error: expect.stringContaining('CLAUDE_MEM_WORK_VIEW_AGENT'),
    }));
  });
});
