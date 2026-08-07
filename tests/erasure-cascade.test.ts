// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import type { Request, Response } from 'express';
import { SessionStore } from '../src/services/sqlite/SessionStore.js';
import { supersedeObservation } from '../src/services/reinforcement/persist.js';
import {
  eraseObservationCascade,
  eraseFactCascade,
  observationErasureChain,
} from '../src/services/reinforcement/erasure.js';
import { insertFact, supersedeFact, invalidateFact } from '../src/services/sqlite/facts/store.js';
import { DataRoutes } from '../src/services/worker/http/routes/DataRoutes.js';

// SessionStore owns observation writes; this mirrors the shape it accepts.
type ObservationInput = {
  type: string;
  title: string | null;
  subtitle: string | null;
  facts: string[];
  narrative: string | null;
  concepts: string[];
  files_read: string[];
  files_modified: string[];
};

const obs = (over: Partial<ObservationInput> = {}): ObservationInput => ({
  type: 'discovery',
  title: 'x',
  subtitle: null,
  facts: [],
  narrative: 'x',
  concepts: [],
  files_read: [],
  files_modified: [],
  ...over,
});

function makeSession(store: SessionStore): void {
  store.db.run(
    `INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, status, started_at, started_at_epoch)
     VALUES ('c1', 's1', 'proj', 'active', '2026-06-17', 1750000000)`,
  );
}

describe('erasure cascade (audit G5)', () => {
  let store: SessionStore;
  beforeEach(() => {
    store = new SessionStore(':memory:');
    makeSession(store);
  });
  afterEach(() => store.db.close());

  describe('eraseObservationCascade', () => {
    it('removes the whole supersede chain A → B → C when C is erased', () => {
      const a = store.storeObservation('s1', 'proj', obs({ title: 'a', narrative: 'a' }), 1, 0, Date.parse('2026-06-01T12:00:00Z'));
      const b = store.storeObservation('s1', 'proj', obs({ title: 'b', narrative: 'b' }), 2, 0, Date.parse('2026-06-10T12:00:00Z'));
      const c = store.storeObservation('s1', 'proj', obs({ title: 'c', narrative: 'c' }), 3, 0, Date.parse('2026-06-17T12:00:00Z'));
      expect(supersedeObservation(store.db, a.id, b.id)).toBe(true);
      expect(supersedeObservation(store.db, b.id, c.id)).toBe(true);

      const chain = observationErasureChain(store.db, c.id);
      expect(chain).toContain(c.id);
      expect(chain).toContain(b.id);
      expect(chain).toContain(a.id);
      expect(chain).toHaveLength(3);

      const result = eraseObservationCascade(store.db, c.id);
      expect(result.cascaded).toBe(2);
      expect(result.deletedIds).toHaveLength(3);
      expect(store.db.prepare('SELECT COUNT(*) AS n FROM observations').get()).toEqual({ n: 0 });
    });

    it('erasing a row with no tombstones deletes just itself', () => {
      const lone = store.storeObservation('s1', 'proj', obs(), 1, 0, Date.parse('2026-06-01T12:00:00Z'));
      const result = eraseObservationCascade(store.db, lone.id);
      expect(result.deletedIds).toEqual([lone.id]);
      expect(result.cascaded).toBe(0);
    });

    it('is a no-op for a missing id', () => {
      const result = eraseObservationCascade(store.db, 999999);
      expect(result.deletedIds).toEqual([]);
      expect(result.cascaded).toBe(0);
    });

    it('leaves unrelated rows and sibling chains untouched', () => {
      const a = store.storeObservation('s1', 'proj', obs({ title: 'a', narrative: 'a' }), 1, 0, Date.parse('2026-06-01T12:00:00Z'));
      const b = store.storeObservation('s1', 'proj', obs({ title: 'b', narrative: 'b' }), 2, 0, Date.parse('2026-06-10T12:00:00Z'));
      const unrelated = store.storeObservation('s1', 'proj', obs({ title: 'u', narrative: 'u' }), 3, 0, Date.parse('2026-06-17T12:00:00Z'));
      supersedeObservation(store.db, a.id, b.id);

      eraseObservationCascade(store.db, b.id);
      const remaining = store.db.prepare('SELECT id FROM observations').all() as Array<{ id: number }>;
      expect(remaining.map(r => r.id)).toEqual([unrelated.id]);
    });
  });

  describe('eraseFactCascade', () => {
    it('removes the fact and its supersede chain', () => {
      const f1 = insertFact(store.db, { project: 'proj', kind: 'architecture', fact: 'db is sqlite', sourceObservationIds: [] });
      const f2 = insertFact(store.db, { project: 'proj', kind: 'architecture', fact: 'db is postgres', sourceObservationIds: [] });
      expect(supersedeFact(store.db, f1.id, f2.id)).toBe(true);

      const result = eraseFactCascade(store.db, f2.id);
      expect(result.cascaded).toBe(1);
      expect(store.db.prepare('SELECT COUNT(*) AS n FROM semantic_facts').get()).toEqual({ n: 0 });
    });

    it('invalidated rows are out of cascade scope (no pointer to their deleter)', () => {
      const f1 = insertFact(store.db, { project: 'proj', kind: 'architecture', fact: 'fact one', sourceObservationIds: [] });
      const f2 = insertFact(store.db, { project: 'proj', kind: 'architecture', fact: 'fact two', sourceObservationIds: [] });
      expect(invalidateFact(store.db, f1.id)).toBe(true);

      const result = eraseFactCascade(store.db, f2.id);
      expect(result.deletedIds).toEqual([f2.id]);
      const remaining = store.db.prepare('SELECT id FROM semantic_facts').all() as Array<{ id: number }>;
      expect(remaining.map(r => r.id)).toEqual([f1.id]);
    });

    it('is a no-op for a missing id', () => {
      expect(eraseFactCascade(store.db, 999999).deletedIds).toEqual([]);
    });
  });

  describe('DELETE routes', () => {
    function makeRoutes(): Map<string, (req: Request, res: Response) => void> {
      const routes = new DataRoutes(
        {} as any,
        { getSessionStore: () => store, getCloudSync: () => null, getChromaSync: () => null } as any,
        {} as any,
        {} as any,
        {} as any,
        Date.now(),
      );
      const handlers = new Map<string, (req: Request, res: Response) => void>();
      routes.setupRoutes({
        get: () => {},
        post: () => {},
        delete: (path: string, handler: (req: Request, res: Response) => void) => {
          handlers.set(path, handler);
        },
      } as any);
      return handlers;
    }

    function invoke(handler: (req: Request, res: Response) => void, id: string): { status: number; body: any } {
      const out = { status: 200, body: undefined as any };
      const res = {
        status(code: number) { out.status = code; return this; },
        json(value: unknown) { out.body = value; return this; },
      } as unknown as Response;
      handler({ params: { id } } as unknown as Request, res);
      return out;
    }

    it('DELETE /api/observation/:id cascades to tombstones (local path, no cloud sync)', () => {
      const a = store.storeObservation('s1', 'proj', obs({ title: 'a', narrative: 'a' }), 1, 0, Date.parse('2026-06-01T12:00:00Z'));
      const b = store.storeObservation('s1', 'proj', obs({ title: 'b', narrative: 'b' }), 2, 0, Date.parse('2026-06-10T12:00:00Z'));
      supersedeObservation(store.db, a.id, b.id);

      const handlers = makeRoutes();
      const { status, body } = invoke(handlers.get('/api/observation/:id')!, String(b.id));
      expect(status).toBe(200);
      expect(body).toMatchObject({ success: true, id: String(b.id), kind: 'observation', cascaded: 1 });
      expect(store.db.prepare('SELECT COUNT(*) AS n FROM observations').get()).toEqual({ n: 0 });
    });

    it('DELETE /api/facts/:id cascades to superseded facts', () => {
      const f1 = insertFact(store.db, { project: 'proj', kind: 'architecture', fact: 'v1', sourceObservationIds: [] });
      const f2 = insertFact(store.db, { project: 'proj', kind: 'architecture', fact: 'v2', sourceObservationIds: [] });
      supersedeFact(store.db, f1.id, f2.id);

      const handlers = makeRoutes();
      const { status, body } = invoke(handlers.get('/api/facts/:id')!, String(f2.id));
      expect(status).toBe(200);
      expect(body).toMatchObject({ success: true, id: f2.id, kind: 'fact', cascaded: 1 });
      expect(store.db.prepare('SELECT COUNT(*) AS n FROM semantic_facts').get()).toEqual({ n: 0 });
    });

    it('DELETE /api/facts/:id returns 404 for a missing fact', () => {
      const handlers = makeRoutes();
      const { status, body } = invoke(handlers.get('/api/facts/:id')!, '424242');
      expect(status).toBe(404);
      expect(body.success).toBeUndefined();
    });
  });
});
