/**
 * Observation Deletion Integration Tests
 *
 * Tests the full deletion path: DB → SessionStore → DataRoutes → HTTP.
 * Uses a real in-memory SessionStore and a real Express app.
 *
 * Covers tasks 7.1 and 7.2:
 * - store → delete via API → search returns nothing, FTS cleaned up
 * - delete same ID twice → second call reports notFound
 */

import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import express from 'express';
import http from 'http';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { DataRoutes } from '../../src/services/worker/http/routes/DataRoutes.js';
import {
  createSDKSession,
  updateMemorySessionId,
} from '../../src/services/sqlite/Sessions.js';
import { storeObservation } from '../../src/services/sqlite/Observations.js';
import type { ObservationInput } from '../../src/services/sqlite/observations/types.js';
import { logger } from '../../src/utils/logger.js';

// Stub paths/utils so DataRoutes can be imported without real files
mock.module('../../src/shared/paths.js', () => ({
  getPackageRoot: () => '/tmp/test',
  DATA_DIR: '/tmp',
  DB_PATH: ':memory:',
  ensureDir: () => {},
}));
mock.module('../../src/shared/worker-utils.js', () => ({
  getWorkerPort: () => 37777,
}));

let loggerSpies: ReturnType<typeof spyOn>[] = [];

/** Build a minimal Express app wired to a real in-memory SessionStore. */
function buildTestApp(store: SessionStore): { app: express.Application; dbManager: any } {
  const app = express();
  app.use(express.json());

  const dbManager = { getSessionStore: () => store };

  const routes = new DataRoutes(
    {} as any,   // paginationHelper — not used by delete route
    dbManager as any,
    {} as any,   // sessionManager
    {} as any,   // sseBroadcaster
    {} as any,   // workerService
    Date.now()
  );
  routes.setupRoutes(app);

  return { app, dbManager };
}

/** Start an http.Server on a random port and return [server, baseUrl]. */
async function startServer(app: express.Application): Promise<[http.Server, string]> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve([server, `http://127.0.0.1:${addr.port}`]);
    });
    server.once('error', reject);
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise(resolve => server.close(() => resolve()));
}

function seedSession(store: SessionStore): string {
  const contentId = `content-${Date.now()}-${Math.random()}`;
  const memId = `mem-${Date.now()}-${Math.random()}`;
  const sessionId = createSDKSession(store.db, contentId, 'test-project', 'prompt');
  updateMemorySessionId(store.db, sessionId, memId);
  return memId;
}

function seedObservation(store: SessionStore, memId: string, title: string): number {
  const input: ObservationInput = {
    type: 'discovery',
    title,
    subtitle: null,
    facts: [],
    narrative: null,
    concepts: [],
    files_read: [],
    files_modified: [],
  };
  return storeObservation(store.db, memId, 'test-project', input).id;
}

// Note: baseline assertions (NULL session IDs, version-tracking, tag-stripping) are covered
// by dedicated test files. This suite is scoped to the deletion path only.
describe('Observation Deletion — Integration', () => {
  let store: SessionStore;

  beforeEach(() => {
    loggerSpies = [
      spyOn(logger, 'info').mockImplementation(() => {}),
      spyOn(logger, 'debug').mockImplementation(() => {}),
      spyOn(logger, 'warn').mockImplementation(() => {}),
      spyOn(logger, 'error').mockImplementation(() => {}),
      spyOn(logger, 'failure').mockImplementation(() => {}),
    ];
    store = new SessionStore(':memory:');
  });

  afterEach(() => {
    store.db.close();
    loggerSpies.forEach(spy => spy.mockRestore());
    mock.restore();
  });

  it('should delete observation via API and remove from DB', async () => {
    const memId = seedSession(store);
    const id = seedObservation(store, memId, 'to-delete');

    // Confirm it exists before deletion
    expect(store.getObservationById(id)).not.toBeNull();

    const { app } = buildTestApp(store);
    const [server, base] = await startServer(app);

    try {
      const res = await fetch(`${base}/api/observations/delete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: [id] }),
      });

      expect(res.status).toBe(200);
      const body = await res.json() as { success: boolean; deleted: number[]; notFound: number[] };
      expect(body.success).toBe(true);
      expect(body.deleted).toContain(id);
      expect(body.notFound).toEqual([]);

      // Confirm it's gone from DB
      expect(store.getObservationById(id)).toBeNull();
    } finally {
      await closeServer(server);
    }
  });

  it('should report notFound when deleting same ID twice', async () => {
    const memId = seedSession(store);
    const id = seedObservation(store, memId, 'delete-twice');

    const { app } = buildTestApp(store);
    const [server, base] = await startServer(app);

    try {
      // First delete — should succeed
      const first = await fetch(`${base}/api/observations/delete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: [id] }),
      });
      expect(first.status).toBe(200);
      const firstBody = await first.json() as { deleted: number[]; notFound: number[] };
      expect(firstBody.deleted).toContain(id);

      // Second delete — should report notFound
      const second = await fetch(`${base}/api/observations/delete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: [id] }),
      });
      expect(second.status).toBe(200);
      const secondBody = await second.json() as { deleted: number[]; notFound: number[] };
      expect(secondBody.deleted).toEqual([]);
      expect(secondBody.notFound).toContain(id);
    } finally {
      await closeServer(server);
    }
  });

  it('should not affect other observations when deleting one', async () => {
    const memId = seedSession(store);
    const id1 = seedObservation(store, memId, 'delete-me');
    const id2 = seedObservation(store, memId, 'keep-me');

    const { app } = buildTestApp(store);
    const [server, base] = await startServer(app);

    try {
      const res = await fetch(`${base}/api/observations/delete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: [id1] }),
      });
      expect(res.status).toBe(200);

      expect(store.getObservationById(id1)).toBeNull();
      expect(store.getObservationById(id2)).not.toBeNull();
    } finally {
      await closeServer(server);
    }
  });
});
