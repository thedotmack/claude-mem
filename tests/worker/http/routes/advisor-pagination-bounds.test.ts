import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import express from 'express';
import type { Server } from 'node:http';
import { AdvisorRoutes } from '../../../../src/services/worker/http/routes/AdvisorRoutes.js';
import { LISTING_OFFSET_CAP_MESSAGE, MAX_LISTING_OFFSET } from '../../../../src/shared/listing-offset-cap.js';

// The advisor listing is served by the same worker router as the observation,
// summary and prompt feeds, and it reads the same SQLite connection. Before
// this bound, `?offset=` reached `LIMIT ? OFFSET ?` unbounded — one request
// could ask SQLite to scan and discard an arbitrarily large row set.

const calls: Array<{ offset: number; limit: number }> = [];
const store = {
  getAdvisorCalls(offset: number, limit: number) {
    calls.push({ offset, limit });
    return { items: [], hasMore: true, offset, limit };
  },
};
const facade = { getSessionStore: () => store } as any;

let server: Server;
let endpoint: string;

beforeAll(async () => {
  const app = express();
  new AdvisorRoutes(facade).setupRoutes(app);
  server = await new Promise<Server>(resolve => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing owned listener');
  endpoint = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});

describe('advisor-calls listing offset bounds', () => {
  it('rejects an offset past the shared cap before reading SQLite', async () => {
    calls.length = 0;
    const response = await fetch(`${endpoint}/api/advisor-calls?offset=${MAX_LISTING_OFFSET + 1}`);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: LISTING_OFFSET_CAP_MESSAGE });
    expect(calls).toHaveLength(0);
  });

  it('serves the cap itself and reports that paging stops there', async () => {
    calls.length = 0;
    const response = await fetch(`${endpoint}/api/advisor-calls?offset=${MAX_LISTING_OFFSET}&limit=5`);
    expect(response.status).toBe(200);
    expect(calls).toEqual([{ offset: MAX_LISTING_OFFSET, limit: 5 }]);
    expect(await response.json()).toMatchObject({
      offset: MAX_LISTING_OFFSET,
      limit: 5,
      hasMore: false,
      offsetCapReached: true,
      maxOffset: MAX_LISTING_OFFSET,
    });
  });

  it('keeps the existing limit clamping', async () => {
    calls.length = 0;
    await fetch(`${endpoint}/api/advisor-calls?limit=1000`);
    await fetch(`${endpoint}/api/advisor-calls?limit=-1`);
    expect(calls).toEqual([{ offset: 0, limit: 100 }, { offset: 0, limit: 1 }]);
  });

  it('normalizes an unrepresentable offset instead of binding it', async () => {
    calls.length = 0;
    const response = await fetch(`${endpoint}/api/advisor-calls?offset=${'9'.repeat(400)}`);
    expect(response.status).toBe(200);
    expect(calls).toEqual([{ offset: 0, limit: 20 }]);
  });
});