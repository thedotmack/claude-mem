// limit/offset reached SQLite LIMIT/OFFSET straight from the query string:
// limit=-1 returned every row, limit=abc became "no results". The search routes
// now accept only digits (limit >= 1) and answer 400 INVALID_PAGINATION.
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { Request, Response } from 'express';
import { SearchRoutes } from '../../../../src/services/worker/http/routes/SearchRoutes.js';
import { SearchManager } from '../../../../src/services/worker/SearchManager.js';
import { SessionSearch } from '../../../../src/services/sqlite/SessionSearch.js';
import { SessionStore } from '../../../../src/services/sqlite/SessionStore.js';
import { FormattingService } from '../../../../src/services/worker/FormattingService.js';
import { ModeManager } from '../../../../src/services/domain/ModeManager.js';
import { TimelineService } from '../../../../src/services/worker/TimelineService.js';

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
  for (const n of [1, 2, 3, 4]) {
    const sessionDbId = store.createSDKSession(`content-${n}`, 'page-project', 'prompt');
    store.ensureMemorySessionIdRegistered(sessionDbId, `mem-${n}`);
    store.storeObservation(`mem-${n}`, 'page-project', {
      type: 'discovery', title: `zebrafish-${n}`, subtitle: null, facts: [], narrative: `zebrafish narrative ${n}`,
      concepts: [], files_read: [], files_modified: [],
    }, 1);
  }
  const manager = new SearchManager(search, store, null as any, new FormattingService(), new TimelineService());
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

const hits = (body: any): number => ((body?.content?.[0]?.text ?? '') as string).match(/zebrafish-\d/g)?.length ?? 0;

describe('limit and offset on the search routes', () => {
  for (const [key, value] of [
    ['limit', '-1'], ['limit', 'abc'], ['limit', '0'], ['limit', '1.5'], ['limit', '1e2'], ['limit', ['1', '2']],
    ['offset', '-1'], ['offset', 'abc'], ['offset', '1.5'],
  ] as const) {
    it(`${key}=${JSON.stringify(value)} is a 400 INVALID_PAGINATION`, async () => {
      const { status, body } = await request('/api/search', { query: 'zebrafish', [key]: value });
      expect(status).toBe(400);
      expect(body.code).toBe('INVALID_PAGINATION');
    });
  }

  it('is rejected on /api/timeline and /api/search/observations too', async () => {
    for (const path of ['/api/timeline', '/api/search/observations']) {
      const { status, body } = await request(path, { query: 'zebrafish', limit: '-1' });
      expect(status).toBe(400);
      expect(body.code).toBe('INVALID_PAGINATION');
    }
  });

  it('still honors a valid limit and offset, and treats empty values as absent', async () => {
    expect(hits((await request('/api/search', { query: 'zebrafish' })).body)).toBe(4);
    expect(hits((await request('/api/search', { query: 'zebrafish', limit: '2' })).body)).toBe(2);
    expect(hits((await request('/api/search', { query: 'zebrafish', limit: '2', offset: '3' })).body)).toBe(1);
    const empty = await request('/api/search', { query: 'zebrafish', limit: '', offset: '' });
    expect(empty.status).toBe(200);
    expect(hits(empty.body)).toBe(4);
  });
});
