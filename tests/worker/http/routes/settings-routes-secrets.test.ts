import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import type { Request, Response } from 'express';
import { existsSync, readFileSync, writeFileSync, rmSync } from 'fs';
import { SettingsRoutes } from '../../../../src/services/worker/http/routes/SettingsRoutes.js';
import { paths } from '../../../../src/shared/paths.js';

function expectedMask(value: string): string {
  if (value.length <= 4) return '*'.repeat(value.length);
  return `${'*'.repeat(value.length - 4)}${value.slice(-4)}`;
}

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

function captureHandlers(routes: SettingsRoutes): {
  get: (req: Request, res: Response) => void;
  post: (req: Request, res: Response) => void;
} {
  let getHandler!: (req: Request, res: Response) => void;
  let postHandler!: (req: Request, res: Response) => void;
  const mockApp: any = {
    get: mock((path: string, ...handlers: Array<(req: Request, res: Response) => void>) => {
      if (path === '/api/settings') {
        getHandler = handlers[handlers.length - 1];
      }
    }),
    post: mock((path: string, ...handlers: Array<(req: Request, res: Response) => void>) => {
      if (path === '/api/settings') {
        postHandler = handlers[handlers.length - 1];
      }
    }),
  };
  routes.setupRoutes(mockApp);
  return { get: getHandler, post: postHandler };
}

const SECRET_ENV_KEYS = [
  'CLAUDE_MEM_GEMINI_API_KEY',
  'CLAUDE_MEM_OPENROUTER_API_KEY',
  'CLAUDE_MEM_CHROMA_API_KEY',
  'CLAUDE_MEM_CLOUD_SYNC_TOKEN',
  'CLAUDE_MEM_TV_TOKEN',
  'CLAUDE_MEM_PRO_MEMORY_KEY',
  'CLAUDE_MEM_REDIS_URL',
];

describe('SettingsRoutes — credential redaction and host bind (#3861)', () => {
  const settingsPath = paths.settings();
  let priorSettingsContent: string | undefined;
  let priorEnv: Record<string, string | undefined>;
  let handlers: ReturnType<typeof captureHandlers>;

  beforeEach(() => {
    priorSettingsContent = existsSync(settingsPath) ? readFileSync(settingsPath, 'utf-8') : undefined;
    priorEnv = {};
    for (const key of SECRET_ENV_KEYS) {
      priorEnv[key] = process.env[key];
      delete process.env[key];
    }
    handlers = captureHandlers(new SettingsRoutes({} as any));
  });

  afterEach(() => {
    for (const key of SECRET_ENV_KEYS) {
      if (priorEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = priorEnv[key];
      }
    }
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

  it('GET /api/settings masks provider and sync secrets and leaves display prefs intact', () => {
    const secrets = {
      CLAUDE_MEM_GEMINI_API_KEY: 'gemini-secret-1234',
      CLAUDE_MEM_OPENROUTER_API_KEY: 'or-secret-5678',
      CLAUDE_MEM_CHROMA_API_KEY: 'chroma-secret-abcd',
      CLAUDE_MEM_CLOUD_SYNC_TOKEN: 'sync-token-wxyz',
      CLAUDE_MEM_TV_TOKEN: 'tv-token-9999',
      CLAUDE_MEM_PRO_MEMORY_KEY: 'pro-memory-key-aaaa',
    };
    writeFileSync(settingsPath, JSON.stringify({
      ...secrets,
      CLAUDE_MEM_CONTEXT_SHOW_READ_TOKENS: 'false',
      CLAUDE_MEM_CONTEXT_SHOW_WORK_TOKENS: 'true',
    }));

    const { res, jsonSpy } = createMockRes();
    handlers.get({ body: {}, path: '/api/settings', params: {}, query: {} } as Request, res as Response);

    expect(jsonSpy).toHaveBeenCalledTimes(1);
    const body = jsonSpy.mock.calls[0][0] as Record<string, string>;
    for (const [key, value] of Object.entries(secrets)) {
      expect(body[key]).toBe(expectedMask(value));
      expect(body[key]).not.toBe(value);
    }
    expect(body.CLAUDE_MEM_CONTEXT_SHOW_READ_TOKENS).toBe('false');
    expect(body.CLAUDE_MEM_CONTEXT_SHOW_WORK_TOKENS).toBe('true');

    const persisted = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    expect(persisted.CLAUDE_MEM_GEMINI_API_KEY).toBe('gemini-secret-1234');
  });

  it('POST of an unmodified GET body keeps the real Gemini key on disk', () => {
    writeFileSync(settingsPath, JSON.stringify({
      CLAUDE_MEM_GEMINI_API_KEY: 'keep-this-real-key',
      CLAUDE_MEM_MODEL: 'claude-haiku-4-5-20251001',
    }));

    const { res: getRes, jsonSpy: getSpy } = createMockRes();
    handlers.get({ body: {}, path: '/api/settings', params: {}, query: {} } as Request, getRes as Response);
    const getBody = getSpy.mock.calls[0][0] as Record<string, string>;
    expect(getBody.CLAUDE_MEM_GEMINI_API_KEY).toMatch(/^\*+-key$/);

    const { res: postRes, jsonSpy: postSpy } = createMockRes();
    handlers.post({
      body: { ...getBody, CLAUDE_MEM_MODEL: 'claude-haiku-4-5-20251001' },
      path: '/api/settings',
      params: {},
      query: {},
    } as Request, postRes as Response);

    expect(postSpy).toHaveBeenCalledWith({ success: true, message: 'Settings updated successfully' });
    const persisted = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    expect(persisted.CLAUDE_MEM_GEMINI_API_KEY).toBe('keep-this-real-key');
  });

  it('POST of a new Gemini key that starts with * still replaces the stored key', () => {
    writeFileSync(settingsPath, JSON.stringify({
      CLAUDE_MEM_GEMINI_API_KEY: 'old-secret-1234',
    }));

    const { res, jsonSpy } = createMockRes();
    handlers.post({
      body: { CLAUDE_MEM_GEMINI_API_KEY: '*new-gemini-secret' },
      path: '/api/settings',
      params: {},
      query: {},
    } as Request, res as Response);

    expect(jsonSpy).toHaveBeenCalledWith({ success: true, message: 'Settings updated successfully' });
    const persisted = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    expect(persisted.CLAUDE_MEM_GEMINI_API_KEY).toBe('*new-gemini-secret');
  });

  it('rejects an arbitrary IPv4 worker host', () => {
    const { res, statusSpy, jsonSpy } = createMockRes();
    handlers.post({
      body: { CLAUDE_MEM_WORKER_HOST: '8.8.8.8' },
      path: '/api/settings',
      params: {},
      query: {},
    } as Request, res as Response);

    expect(statusSpy).toHaveBeenCalledWith(400);
    expect(jsonSpy).toHaveBeenCalledWith(expect.objectContaining({ success: false }));
  });

  it('still accepts loopback and the documented bind-all hosts', () => {
    for (const host of ['127.0.0.1', 'localhost', '::1', '0.0.0.0', '::']) {
      const { res, jsonSpy, statusSpy } = createMockRes();
      handlers.post({
        body: { CLAUDE_MEM_WORKER_HOST: host },
        path: '/api/settings',
        params: {},
        query: {},
      } as Request, res as Response);
      expect(statusSpy).not.toHaveBeenCalled();
      expect(jsonSpy).toHaveBeenCalledWith({ success: true, message: 'Settings updated successfully' });
    }
  });
});
