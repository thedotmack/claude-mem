import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import express from 'express';
import type { Server } from 'node:http';
import { SessionStore } from '../../../../src/services/sqlite/SessionStore.js';
import { PaginationHelper } from '../../../../src/services/worker/PaginationHelper.js';
import { DataRoutes } from '../../../../src/services/worker/http/routes/DataRoutes.js';
import { LISTING_OFFSET_CAP_MESSAGE, MAX_LISTING_OFFSET, capListingPage } from '../../../../src/shared/listing-offset-cap.js';

const store = new SessionStore(':memory:');
const facade = { getSessionStore: () => store } as any;
const sid = store.createSDKSession('owned-pagination', 'owned-pagination', 'fixture');
store.ensureMemorySessionIdRegistered(sid, 'owned-pagination-memory');
for (let index = 0; index < 130; index++) store.storeObservation('owned-pagination-memory', 'owned-pagination', {
  type: 'discovery', title: `unique-observation-${index}`, narrative: `owned ${index}`,
  facts: [], concepts: [], files_read: [], files_modified: [],
}, 1, 0, 1000 + index);
// A second database deeper than the offset cap, so the cap page is a real page.
const DEEP_ROWS = MAX_LISTING_OFFSET + 50;
const deepStore = new SessionStore(':memory:');
const deepFacade = { getSessionStore: () => deepStore } as any;
const deepSid = deepStore.createSDKSession('deep-pagination', 'deep-pagination', 'fixture');
deepStore.ensureMemorySessionIdRegistered(deepSid, 'deep-pagination-memory');
deepStore.db.transaction(() => {
  const series = `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${DEEP_ROWS})`;
  deepStore.db.run(`${series} INSERT INTO observations (memory_session_id, project, type, title, created_at, created_at_epoch)
    SELECT 'deep-pagination-memory', 'deep-pagination', 'discovery', 'deep-' || i, '2026-01-01T00:00:00.000Z', 1000 + i FROM n`);
  deepStore.db.run(`${series} INSERT INTO session_summaries (memory_session_id, project, request, created_at, created_at_epoch)
    SELECT 'deep-pagination-memory', 'deep-pagination', 'deep-' || i, '2026-01-01T00:00:00.000Z', 1000 + i FROM n`);
  deepStore.db.run(`${series} INSERT INTO sdk_sessions (content_session_id, project, started_at, started_at_epoch)
    SELECT 'deep-session-' || i, 'deep-pagination', '2026-01-01T00:00:00.000Z', 1000 + i FROM n`);
  // One prompt per session, as real sessions hold few prompts each.
  deepStore.db.run(`INSERT INTO user_prompts (content_session_id, session_db_id, prompt_number, prompt_text, created_at, created_at_epoch)
    SELECT content_session_id, id, 1, 'deep-prompt', started_at, started_at_epoch FROM sdk_sessions WHERE content_session_id LIKE 'deep-session-%'`);
})();

async function listen(routes: DataRoutes): Promise<{ server: Server; endpoint: string }> {
  const app = express();
  routes.setupRoutes(app);
  const server = await new Promise<Server>(resolve => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing owned listener');
  return { server, endpoint: `http://127.0.0.1:${address.port}` };
}

let server: Server;
let endpoint: string;
let deepServer: Server;
let deepEndpoint: string;
beforeAll(async () => {
  ({ server, endpoint } = await listen(new DataRoutes(new PaginationHelper(facade), facade, {} as any, {} as any, {} as any, Date.now())));
  ({ server: deepServer, endpoint: deepEndpoint } = await listen(new DataRoutes(new PaginationHelper(deepFacade), deepFacade, {} as any, {} as any, {} as any, Date.now())));
});
afterAll(async () => {
  for (const owned of [server, deepServer]) {
    if (owned) await new Promise<void>((resolve, reject) => owned.close(error => error ? reject(error) : resolve()));
  }
  store.close();
  deepStore.close();
});
describe('data feed pagination bounds at the SQLite boundary', () => {
  for (const limit of [-2, -1]) it(`does not turn limit=${limit} into an unbounded or empty SQL page`, async () => {
    const response = await fetch(`${endpoint}/api/observations?limit=${limit}`);
    expect(response.status).toBe(200);
    const result = await response.json() as { items: unknown[]; limit: number; hasMore: boolean };
    expect(result.items).toHaveLength(1);
    expect(result.limit).toBe(1);
    expect(result.hasMore).toBe(true);
  });
  it('keeps defaults and caps large positive limits', async () => {
    for (const [query, expected] of [['', 20], ['?limit=1000', 100], ['?limit=9007199254740992', 100], [`?limit=${'9'.repeat(400)}`, 100]]) {
      const result = await (await fetch(`${endpoint}/api/observations${query}`)).json() as { items: unknown[]; limit: number };
      expect(result.items).toHaveLength(expected);
      expect(result.limit).toBe(expected);
    }
  });
  it('normalizes an unrepresentable offset instead of returning a binding error', async () => {
    const response = await fetch(`${endpoint}/api/observations?offset=${'9'.repeat(400)}&limit=1`);
    expect(response.status).toBe(200);
    expect((await response.json() as { offset: number }).offset).toBe(0);
  });
});

const FEED_ROUTES = ['/api/observations', '/api/summaries', '/api/prompts'] as const;
const OFFSET_ROUTES = [...FEED_ROUTES, '/api/sessions', '/api/tool-uses'] as const;

describe('listing offset cap on the worker plane', () => {
  for (const route of OFFSET_ROUTES) {
    it(`${route} answers 400 above the cap and serves the cap itself`, async () => {
      const above = await fetch(`${endpoint}${route}?offset=${MAX_LISTING_OFFSET + 1}`);
      expect(above.status).toBe(400);
      expect(await above.json()).toEqual({ error: LISTING_OFFSET_CAP_MESSAGE });
      const atCap = await fetch(`${endpoint}${route}?offset=${MAX_LISTING_OFFSET}`);
      expect(atCap.status).toBe(200);
      if ((FEED_ROUTES as readonly string[]).includes(route)) {
        expect((await atCap.json() as { offset: number }).offset).toBe(MAX_LISTING_OFFSET);
        const omitted = await fetch(`${endpoint}${route}`);
        expect((await omitted.json() as { offset: number }).offset).toBe(0);
      }
    });
  }

  for (const offset of ['-1', '1.5']) it(`/api/tool-uses rejects offset=${offset}`, async () => {
    const response = await fetch(`${endpoint}/api/tool-uses?offset=${offset}`);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'offset must be a non-negative integer' });
  });

  for (const route of FEED_ROUTES) it(`${route} marks the last page it will serve instead of hasMore`, async () => {
    const last = await (await fetch(`${deepEndpoint}${route}?offset=9990&limit=20`)).json() as Record<string, unknown> & { items: unknown[] };
    expect(last.items).toHaveLength(20);
    expect(last).toMatchObject({ hasMore: false, offsetCapReached: true, maxOffset: MAX_LISTING_OFFSET, offset: 9990, limit: 20 });
    // The page whose next offset is exactly the cap still pages on.
    const before = await (await fetch(`${deepEndpoint}${route}?offset=9980&limit=20`)).json() as Record<string, unknown>;
    expect(before.hasMore).toBe(true);
    expect(before.offsetCapReached).toBeUndefined();
  });

  it('/api/sessions marks the last catalog page it will serve', async () => {
    const last = await (await fetch(`${deepEndpoint}/api/sessions?project=deep-pagination&offset=9950&limit=100`)).json() as Record<string, unknown> & { sessions: unknown[] };
    expect(last.sessions).toHaveLength(100);
    expect(last).toMatchObject({ hasMore: false, offsetCapReached: true, maxOffset: MAX_LISTING_OFFSET });
    const before = await (await fetch(`${deepEndpoint}/api/sessions?project=deep-pagination&offset=9900&limit=100`)).json() as Record<string, unknown>;
    expect(before.hasMore).toBe(true);
    expect(before.offsetCapReached).toBeUndefined();
  });
});

describe('capListingPage', () => {
  it('leaves a page alone when there is nothing after it or the next offset is allowed', () => {
    expect(capListingPage({ items: [1], hasMore: false }, 9_990, 50)).toEqual({ items: [1], hasMore: false });
    expect(capListingPage({ items: [1], hasMore: true }, 9_950, 50)).toEqual({ items: [1], hasMore: true });
  });
  it('turns hasMore into offsetCapReached when the next offset would pass the cap', () => {
    expect(capListingPage({ items: [1], hasMore: true }, 9_951, 50))
      .toEqual({ items: [1], hasMore: false, offsetCapReached: true, maxOffset: MAX_LISTING_OFFSET });
  });
});
