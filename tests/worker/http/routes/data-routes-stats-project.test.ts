import { describe, it, expect, mock, beforeEach, afterEach, spyOn } from 'bun:test';
import type { Request, Response } from 'express';
import { mkdirSync, writeFileSync } from 'node:fs';
import { logger } from '../../../../src/utils/logger.js';

// handleGetStats reads <packageRoot>/package.json and paths.database(); point both
// at a throwaway dir so the handler runs without touching the real install.
const PKG_ROOT = '/tmp/claude-mem-stats-project-test';
mkdirSync(PKG_ROOT, { recursive: true });
writeFileSync(`${PKG_ROOT}/package.json`, JSON.stringify({ version: '13.6.1-test' }));

// Sentinel for the internal observer-sessions bookkeeping project. The handler
// excludes it from global counts (mirroring PaginationHelper's reader queries),
// so the mock db keys "is this the global query?" off this value being bound.
const OBSERVER_PROJECT = '__observer-sessions__';

mock.module('../../../../src/shared/paths.js', () => ({
  getPackageRoot: () => PKG_ROOT,
  paths: { database: () => `${PKG_ROOT}/does-not-exist.db` },
  OBSERVER_SESSIONS_PROJECT: OBSERVER_PROJECT,
}));
mock.module('../../../../src/shared/worker-utils.js', () => ({
  getWorkerPort: () => 37777,
}));

import { DataRoutes } from '../../../../src/services/worker/http/routes/DataRoutes.js';

const GLOBAL_COUNT = 14476;
const PROJECT_COUNT = 135;

let loggerSpies: ReturnType<typeof spyOn>[] = [];

function buildRoutes() {
  // A query is "global" when it excludes the observer project (binds the
  // sentinel) and "project-scoped" when it binds a real project name. The mock
  // returns the matching count so the response reflects which path the handler
  // actually took.
  const prepareLog: { sql: string; args: unknown[] }[] = [];
  const db = {
    prepare: (sql: string) => ({
      get: (...args: unknown[]) => {
        prepareLog.push({ sql, args });
        if (/created_at/i.test(sql)) return { created_at: null };
        const isGlobal = args.includes(OBSERVER_PROJECT);
        return { count: isGlobal ? GLOBAL_COUNT : PROJECT_COUNT };
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

function countQuery(prepareLog: { sql: string; args: unknown[] }[], table: RegExp) {
  const q = prepareLog.find((p) => /COUNT\(\*\)/i.test(p.sql) && table.test(p.sql));
  if (!q) throw new Error(`no COUNT query found for ${table}`);
  return q;
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

  it('returns global counts excluding the observer project when no ?project= is given', () => {
    const { routes, prepareLog } = buildRoutes();
    const handler = captureStatsHandler(routes);
    const { req, res, jsonSpy } = makeReqRes({});

    handler(req, res);

    const body = jsonSpy.mock.calls[0]?.[0] as any;
    expect(body.database.observations).toBe(GLOBAL_COUNT);
    expect(body.database.sessions).toBe(GLOBAL_COUNT);
    expect(body.database.summaries).toBe(GLOBAL_COUNT);

    // Every global COUNT must mirror the readers: exclude the observer project.
    const countQueries = prepareLog.filter((p) => /COUNT\(\*\)/i.test(p.sql));
    expect(countQueries.length).toBeGreaterThanOrEqual(3);
    for (const q of countQueries) {
      expect(q.sql).toMatch(/WHERE\s+project\s*!=\s*\?/i);
      expect(q.args).toEqual([OBSERVER_PROJECT]);
    }
  });

  it('scopes counts to the project and adopts merged worktree rows when ?project= is given', () => {
    const { routes, prepareLog } = buildRoutes();
    const handler = captureStatsHandler(routes);
    const { req, res, jsonSpy } = makeReqRes({ project: 'claude-mem' });

    handler(req, res);

    const body = jsonSpy.mock.calls[0]?.[0] as any;
    expect(body.database.observations).toBe(PROJECT_COUNT);
    expect(body.database.sessions).toBe(PROJECT_COUNT);
    expect(body.database.summaries).toBe(PROJECT_COUNT);

    // observations + summaries carry merged_into_project (adopted worktrees);
    // they must match the reader's `(project = ? OR merged_into_project = ?)`.
    const obs = countQuery(prepareLog, /FROM\s+observations/i);
    expect(obs.sql).toMatch(/merged_into_project\s*=\s*\?/i);
    expect(obs.args).toEqual(['claude-mem', 'claude-mem']);

    const summ = countQuery(prepareLog, /FROM\s+session_summaries/i);
    expect(summ.sql).toMatch(/merged_into_project\s*=\s*\?/i);
    expect(summ.args).toEqual(['claude-mem', 'claude-mem']);

    // sdk_sessions has no merged column — plain project equality, like the reader.
    const sess = countQuery(prepareLog, /FROM\s+sdk_sessions/i);
    expect(sess.sql).toMatch(/WHERE\s+project\s*=\s*\?/i);
    expect(sess.sql).not.toMatch(/merged_into_project/i);
    expect(sess.args).toEqual(['claude-mem']);
  });

  it('scopes firstObservationAt to the project when ?project= is given', () => {
    const { routes, prepareLog } = buildRoutes();
    const handler = captureStatsHandler(routes);
    const { req, res } = makeReqRes({ project: 'claude-mem' });

    handler(req, res);

    const firstObsQuery = prepareLog.find((p) => /created_at/i.test(p.sql));
    expect(firstObsQuery).toBeDefined();
    // Must be filtered by project, not the unscoped global earliest row.
    expect(firstObsQuery!.sql).toMatch(/project\s*=\s*\?/i);
    expect(firstObsQuery!.args).toEqual(['claude-mem', 'claude-mem']);
  });
});
