import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import express from 'express';
import type { Server } from 'node:http';
import { SessionStore } from '../../../../src/services/sqlite/SessionStore.js';
import { backfillProjectDedup, sweepProjectCandidates } from '../../../../src/services/sqlite/dedup-store.js';
import { DedupRoutes } from '../../../../src/services/worker/http/routes/DedupRoutes.js';
import type { DatabaseManager } from '../../../../src/services/worker/DatabaseManager.js';

const CFG = { cosineThreshold: 0.8, idfVetoDf: 10, minSharedTokens: 2, maxScan: 2000, maxBackfillRows: 50000 };

let store: SessionStore;
let server: Server;
let endpoint: string;
let candidateId: number;
const previousEnabled = process.env.CLAUDE_MEM_DEDUP_ENABLED;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  new DedupRoutes({ getSessionStore: () => store } as unknown as DatabaseManager).setupRoutes(app);
  server = await new Promise<Server>(resolve => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing owned listener');
  endpoint = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  if (previousEnabled === undefined) delete process.env.CLAUDE_MEM_DEDUP_ENABLED;
  else process.env.CLAUDE_MEM_DEDUP_ENABLED = previousEnabled;
});

beforeEach(() => {
  process.env.CLAUDE_MEM_DEDUP_ENABLED = 'true';
  store = new SessionStore(':memory:');
  const id = store.createSDKSession('c-p', 'p', 'prompt');
  store.updateMemorySessionId(id, 'm-p');
  let t = Date.now();
  for (const title of ['build the worker service module', 'worker build the service module', 'distinct subject matter']) {
    store.storeObservation('m-p', 'p', { type: 'discovery', title, subtitle: null, facts: [], narrative: `n-${title}`, concepts: [], files_read: [], files_modified: [] }, 1, 0, t++);
  }
  backfillProjectDedup(store.db, 'p');
  sweepProjectCandidates(store.db, 'p', CFG);
  candidateId = store.listDedupCandidates('p')[0].id;
});

afterEach(() => store.close());

const resolve = (id: number | string, body: unknown) =>
  fetch(`${endpoint}/api/dedup/candidates/${id}/resolve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('POST /api/dedup/candidates/:id/resolve', () => {
  for (const status of ['distinct', 'dismissed'] as const) {
    it(`records a ${status} verdict`, async () => {
      const response = await resolve(candidateId, { status });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ candidate: { id: candidateId, status } });
      expect(store.listDedupCandidates('p').find(c => c.id === candidateId)?.status).toBe(status);
    });
  }

  it('rejects a status outside distinct and dismissed', async () => {
    for (const status of ['merged', 'pending', 'nope']) {
      const response = await resolve(candidateId, { status });
      expect(response.status).toBe(400);
    }
    expect(store.listDedupCandidates('p').find(c => c.id === candidateId)?.status).toBe('pending');
  });

  it('rejects a malformed id', async () => {
    const response = await resolve('abc', { status: 'distinct' });
    expect(response.status).toBe(400);
  });

  it('returns 404 for an unknown candidate', async () => {
    const response = await resolve(999999, { status: 'distinct' });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Dedup candidate not found' });
  });

  it('returns 409 while dedup is disabled and leaves the candidate pending', async () => {
    process.env.CLAUDE_MEM_DEDUP_ENABLED = 'false';
    const response = await resolve(candidateId, { status: 'distinct' });
    expect(response.status).toBe(409);
    expect((await response.json() as { error: string }).error).toBe('dedup_disabled');
    expect(store.listDedupCandidates('p').find(c => c.id === candidateId)?.status).toBe('pending');
  });
});

describe('GET /api/dedup/candidates status filter', () => {
  it('returns only candidates with the requested status', async () => {
    store.resolveDedupCandidate(candidateId, 'dismissed');
    const dismissed = await (await fetch(`${endpoint}/api/dedup/candidates?status=dismissed`)).json() as { candidates: Array<{ id: number }> };
    expect(dismissed.candidates.map(c => c.id)).toEqual([candidateId]);
    const pending = await (await fetch(`${endpoint}/api/dedup/candidates?status=pending`)).json() as { candidates: Array<{ id: number }> };
    expect(pending.candidates.map(c => c.id)).not.toContain(candidateId);
  });

  it('keeps listing every status without the filter', async () => {
    store.resolveDedupCandidate(candidateId, 'dismissed');
    const all = await (await fetch(`${endpoint}/api/dedup/candidates`)).json() as { candidates: Array<{ id: number }> };
    expect(all.candidates.map(c => c.id)).toContain(candidateId);
  });

  it('rejects an unknown status filter', async () => {
    const response = await fetch(`${endpoint}/api/dedup/candidates?status=bogus`);
    expect(response.status).toBe(400);
  });
});
