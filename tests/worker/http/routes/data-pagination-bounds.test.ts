import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import express from 'express';
import type { Server } from 'node:http';
import { SessionStore } from '../../../../src/services/sqlite/SessionStore.js';
import { PaginationHelper } from '../../../../src/services/worker/PaginationHelper.js';
import { DataRoutes } from '../../../../src/services/worker/http/routes/DataRoutes.js';

const store = new SessionStore(':memory:');
const facade = { getSessionStore: () => store } as any;
const sid = store.createSDKSession('owned-pagination', 'owned-pagination', 'fixture');
store.ensureMemorySessionIdRegistered(sid, 'owned-pagination-memory');
for (let index = 0; index < 130; index++) store.storeObservation('owned-pagination-memory', 'owned-pagination', {
  type: 'discovery', title: `unique-observation-${index}`, narrative: `owned ${index}`,
  facts: [], concepts: [], files_read: [], files_modified: [],
}, 1, 0, 1000 + index);
let server: Server;
let endpoint: string;
beforeAll(async () => {
  const app = express();
  new DataRoutes(new PaginationHelper(facade), facade, {} as any, {} as any, {} as any, Date.now()).setupRoutes(app);
  server = await new Promise<Server>(resolve => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing owned listener');
  endpoint = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => {
  if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  store.close();
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
