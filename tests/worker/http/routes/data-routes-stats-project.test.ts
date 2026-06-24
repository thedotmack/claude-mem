import { describe, it, expect, mock, beforeEach, afterEach, spyOn } from 'bun:test';
import type { Request, Response } from 'express';
import { mkdirSync, writeFileSync } from 'node:fs';
import { logger } from '../../../../src/utils/logger.js';

// handleGetStats reads <packageRoot>/package.json and paths.database(); point both
// at a throwaway dir so the handler runs without touching the real install.
const PKG_ROOT = '/tmp/claude-mem-stats-project-test';
mkdirSync(PKG_ROOT, { recursive: true });
writeFileSync(`${PKG_ROOT}/package.json`, JSON.stringify({ version: '13.6.1-test' }));

mock.module('../../../../src/shared/paths.js', () => ({
  getPackageRoot: () => PKG_ROOT,
  paths: { database: () => `${PKG_ROOT}/does-not-exist.db` },
}));
mock.module('../../../../src/shared/worker-utils.js', () => ({
  getWorkerPort: () => 37777,
}));

import { DataRoutes } from '../../../../src/services/worker/http/routes/DataRoutes.js';

const GLOBAL_COUNT = 14476;
const PROJECT_COUNT = 135;

let loggerSpies: ReturnType<typeof spyOn>[] = [];

function buildRoutes() {
  // The mock stmt reports a project-scoped count whenever .get() is given a bound
  // parameter, and the global count otherwise — so the response reflects whether
  // the handler actually parameterized the COUNT queries by project.
  const prepareLog: { sql: string; args: unknown[] }[] = [];
  const db = {
    prepare: (sql: string) => ({
      get: (...args: unknown[]) => {
        prepareLog.push({ sql, args });
        if (/created_at/i.test(sql)) return { created_at: null };
        return { count: args.length > 0 ? PROJECT_COUNT : GLOBAL_COUNT };
      },
    }),
  };
  const dbManager = { getSessionStore: () => ({ db }) } as any;
  const sessionManager = { getActiveSessionCount: () => 2 } as any;
  const sseBroadcaster = { getClientCount: () => 0 } as any;
  const routes = new DataRoutes(
    {} as any,
    dbManager,
    sessionManager,
    sseBroadcaster,
    {} as any,
    Date.now(),
  );
  return { routes, prepareLog };
}

function captureStatsHandler(routes: DataRoutes): (req: Request, res: Response) => void {
  let handler: ((req: Request, res: Response) => void) | undefined;
  const mockApp: any = {
    get: mock((path: string, ...rest: any[]) => {
      if (path === '/api/stats') handler = rest[rest.length - 1];
    }),
    post: mock(() => {}),
    delete: mock(() => {}),
    use: mock(() => {}),
  };
  routes.setupRoutes(mockApp);
  if (!handler) throw new Error('GET /api/stats was not registered');
  return handler;
}

function makeReqRes(query: Record<string, unknown>) {
  const jsonSpy = mock((_body: unknown) => {});
  const statusSpy = mock(() => ({ json: jsonSpy }));
  const req = { query, path: '/api/stats' } as unknown as Request;
  const res = { json: jsonSpy, status: statusSpy } as unknown as Response;
  return { req, res, jsonSpy };
}

describe('handleGetStats — project filtering', () => {
  beforeEach(() => {
    loggerSpies = [
      spyOn(logger, 'info').mockImplementation(() => {}),
      spyOn(logger, 'debug').mockImplementation(() => {}),
      spyOn(logger, 'warn').mockImplementation(() => {}),
      spyOn(logger, 'error').mockImplementation(() => {}),
      spyOn(logger, 'failure').mockImplementation(() => {}),
    ];
  });

  afterEach(() => {
    loggerSpies.forEach((s) => s.mockRestore());
  });

  it('returns global counts when no project query param is given', () => {
    const { routes } = buildRoutes();
    const handler = captureStatsHandler(routes);
    const { req, res, jsonSpy } = makeReqRes({});

    handler(req, res);

    const body = jsonSpy.mock.calls[0]?.[0] as any;
    expect(body.database.observations).toBe(GLOBAL_COUNT);
    expect(body.database.sessions).toBe(GLOBAL_COUNT);
    expect(body.database.summaries).toBe(GLOBAL_COUNT);
  });

  it('scopes counts to the project when ?project= is given', () => {
    const { routes, prepareLog } = buildRoutes();
    const handler = captureStatsHandler(routes);
    const { req, res, jsonSpy } = makeReqRes({ project: 'claude-mem' });

    handler(req, res);

    const body = jsonSpy.mock.calls[0]?.[0] as any;
    expect(body.database.observations).toBe(PROJECT_COUNT);
    expect(body.database.sessions).toBe(PROJECT_COUNT);
    expect(body.database.summaries).toBe(PROJECT_COUNT);

    const countQueries = prepareLog.filter((p) => /COUNT\(\*\)/i.test(p.sql));
    expect(countQueries.length).toBeGreaterThanOrEqual(3);
    for (const q of countQueries) {
      expect(q.sql).toMatch(/WHERE\s+project\s*=\s*\?/i);
      expect(q.args).toEqual(['claude-mem']);
    }
  });
});
