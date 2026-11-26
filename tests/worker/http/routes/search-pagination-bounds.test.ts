// The search routes validated `limit`/`offset` format (#4787) but set no upper
// bound, so `?limit=999999999` reached SQLite LIMIT unclamped and one request
// made it scan and materialize a whole table. They now apply the same bounds
// the listing feeds do (DataRoutes.parsePaginationParams): clamp the limit,
// reject an offset past the shared cap.
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { Request, Response } from 'express';
import { SearchRoutes } from '../../../../src/services/worker/http/routes/SearchRoutes.js';
import { SearchManager } from '../../../../src/services/worker/SearchManager.js';
import { SessionSearch } from '../../../../src/services/sqlite/SessionSearch.js';
import { SessionStore } from '../../../../src/services/sqlite/SessionStore.js';
import { FormattingService } from '../../../../src/services/worker/FormattingService.js';
import { ModeManager } from '../../../../src/services/domain/ModeManager.js';
import { TimelineService } from '../../../../src/services/worker/TimelineService.js';
import { LISTING_OFFSET_CAP_MESSAGE, MAX_LISTING_LIMIT, MAX_LISTING_OFFSET } from '../../../../src/shared/listing-offset-cap.js';

type Handler = (req: Request, res: Response) => void;

let store: SessionStore;
let handlers: Map<string, Handler>;
let seen: Array<Record<string, unknown>>;
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
  seen = [];
  const originalSearch = manager.search.bind(manager);
  (manager as any).search = (args: Record<string, unknown>, telemetry: unknown) => {
    seen.push(args);
    return originalSearch(args as any, telemetry as any);
  };
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

describe('search routes bound limit and offset like the listing feeds', () => {
  for (const limit of ['1000', '999999999']) it(`clamps limit=${limit} to the listing ceiling`, async () => {
    const { status } = await request('/api/search', { query: 'zebrafish', limit });
    expect(status).toBe(200);
    expect(seen.at(-1)).toMatchObject({ limit: String(MAX_LISTING_LIMIT) });
  });

  // Past Number.MAX_SAFE_INTEGER the route keeps its existing 400 instead of
  // clamping: the digits are not a number this plane can represent.
  it('rejects a limit that is not a safe integer', async () => {
    const { status, body } = await request('/api/search', { query: 'zebrafish', limit: '9007199254740992' });
    expect(status).toBe(400);
    expect(body.code).toBe('INVALID_PAGINATION');
  });

  it('leaves a limit at or below the ceiling alone', async () => {
    await request('/api/search', { query: 'zebrafish', limit: String(MAX_LISTING_LIMIT) });
    expect(seen.at(-1)).toMatchObject({ limit: String(MAX_LISTING_LIMIT) });
    await request('/api/search', { query: 'zebrafish', limit: '2' });
    expect(seen.at(-1)).toMatchObject({ limit: '2' });
  });

  it('rejects an offset past the shared cap on every search route', async () => {
    for (const path of ['/api/search', '/api/timeline', '/api/search/observations', '/api/context/recent']) {
      const { status, body } = await request(path, { query: 'zebrafish', offset: String(MAX_LISTING_OFFSET + 1) });
      expect(status).toBe(400);
      expect(body.code).toBe('INVALID_PAGINATION');
      expect(body.error).toBe(LISTING_OFFSET_CAP_MESSAGE);
    }
  });

  it('serves an offset at the cap itself', async () => {
    const { status } = await request('/api/search', { query: 'zebrafish', offset: String(MAX_LISTING_OFFSET) });
    expect(status).toBe(200);
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
