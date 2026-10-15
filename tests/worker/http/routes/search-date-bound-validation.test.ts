// An unparseable dateStart/dateEnd used to resolve to NaN: SQLite bound it as
// NULL (no rows), the Chroma path's `!NaN` check skipped the filter (all rows).
// The search routes now reject it with a 400 INVALID_DATE.
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { Request, Response } from 'express';
import { SearchRoutes } from '../../../../src/services/worker/http/routes/SearchRoutes.js';
import { SearchManager } from '../../../../src/services/worker/SearchManager.js';
import { SessionSearch } from '../../../../src/services/sqlite/SessionSearch.js';
import { SessionStore } from '../../../../src/services/sqlite/SessionStore.js';
import { FormattingService } from '../../../../src/services/worker/FormattingService.js';
import { ModeManager } from '../../../../src/services/domain/ModeManager.js';
import { TimelineService } from '../../../../src/services/worker/TimelineService.js';
import { resolveDateBound } from '../../../../src/shared/date-bounds.js';

type Handler = (req: Request, res: Response) => void;

let store: SessionStore;
let handlers: Map<string, Handler>;

let priorMode: unknown;
let priorModeId: unknown;

beforeEach(() => {
  const modes = ModeManager.getInstance();
  priorMode = Reflect.get(modes, 'activeMode');
  priorModeId = Reflect.get(modes, 'activeModeId');
  modes.loadMode('code');
  store = new SessionStore(':memory:');
  const search = new SessionSearch(store.db);
  const sessionDbId = store.createSDKSession('content-date', 'date-project', 'prompt');
  store.ensureMemorySessionIdRegistered(sessionDbId, 'mem-date');
  store.storeObservation('mem-date', 'date-project', {
    type: 'discovery', title: 'zebrafish', subtitle: null, facts: [], narrative: 'zebrafish narrative',
    concepts: [], files_read: [], files_modified: [],
  }, 1);
  const formatter = new FormattingService();
  const manager = new SearchManager(search, store, null as any, formatter, new TimelineService());
  handlers = new Map();
  new SearchRoutes(manager).setupRoutes({
    use: () => {},
    get: (path: string, handler: Handler) => { handlers.set(path, handler); },
    post: () => {},
  } as any);
});

afterEach(() => {
  Reflect.set(ModeManager.getInstance(), 'activeMode', priorMode);
  Reflect.set(ModeManager.getInstance(), 'activeModeId', priorModeId);
  store.close();
});

async function request(path: string, query: Record<string, unknown>): Promise<{ status: number; body: any }> {
  let status = 200;
  let body: any;
  let responded!: () => void;
  const response = new Promise<void>(resolve => { responded = resolve; });
  const res = {
    headersSent: false,
    locals: {},
    status(code: number) { status = code; return res; },
    json(payload: unknown) { body = payload; responded(); return res; },
    send(payload: unknown) { body = payload; responded(); return res; },
    setHeader() { return res; },
  };
  handlers.get(path)!({ path, query, body: {}, get: () => undefined } as any, res as any);
  await response;
  return { status, body };
}

const textOf = (body: any): string => body?.content?.[0]?.text ?? '';

describe('invalid date bounds on the search routes', () => {
  for (const key of ['dateStart', 'dateEnd', 'date_from', 'date_to']) {
    it(`${key}=not-a-date is a 400 INVALID_DATE, not an empty or unfiltered result`, async () => {
      const { status, body } = await request('/api/search', { query: 'zebrafish', [key]: 'not-a-date' });
      expect(status).toBe(400);
      expect(body.code).toBe('INVALID_DATE');
    });
  }

  it('also rejects it on the timeline and observations routes', async () => {
    for (const path of ['/api/timeline', '/api/search/observations']) {
      expect(handlers.has(path)).toBe(true);
      const { status, body } = await request(path, { query: 'zebrafish', dateStart: '2025-13-45' });
      expect(status).toBe(400);
      expect(body.code).toBe('INVALID_DATE');
    }
  });

  it('keeps accepting valid date-only and ISO bounds', async () => {
    const { status, body } = await request('/api/search', {
      query: 'zebrafish', dateStart: '2000-01-01', dateEnd: '2999-12-31T00:00:00Z',
    });
    expect(status).toBe(200);
    expect(textOf(body)).toContain('zebrafish');
  });

  it('resolveDateBound itself throws a 400 AppError for a non-date', () => {
    for (const value of ['nope', '', 'tomorrow-ish']) {
      expect(() => resolveDateBound(value, 'start')).toThrow(/Invalid date/);
    }
    expect(() => resolveDateBound(Number.NaN, 'end')).toThrow(/Invalid date/);
  });
});
