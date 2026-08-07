// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import type { Request, Response } from 'express';
import { SessionStore } from '../src/services/sqlite/SessionStore.js';
import { insertFact, supersedeFact, invalidateFact } from '../src/services/sqlite/facts/store.js';
import {
  getFactProvenance,
  getFactsAt,
  parseTemporalTs,
} from '../src/services/sqlite/facts/audit.js';
import { supersedeObservation } from '../src/services/reinforcement/persist.js';
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

describe('provenance audit + temporal query (audit G6)', () => {
  let store: SessionStore;

  beforeEach(() => {
    store = new SessionStore(':memory:');
    makeSession(store);
  });

  afterEach(() => store.db.close());

  describe('getFactProvenance', () => {
    it('resolves the fact, its source observations, and empty supersession chains', () => {
      const o1 = store.storeObservation('s1', 'proj', obs({ type: 'decision', title: 'chose bun', narrative: 'a' }), 1, 0, Date.parse('2026-05-01T12:00:00Z'));
      const o2 = store.storeObservation('s1', 'proj', obs({ type: 'discovery', title: 'bun test works', narrative: 'b' }), 2, 0, Date.parse('2026-05-10T12:00:00Z'));
      const { id } = insertFact(store.db, {
        project: 'proj', kind: 'project_convention', fact: 'Tests run via bun test.', sourceObservationIds: [o1.id, o2.id],
      }, new Date('2026-06-17T12:00:00Z'));

      const report = getFactProvenance(store.db, id);
      expect(report).not.toBeNull();
      expect(report!.fact.id).toBe(id);
      expect(report!.fact.kind).toBe('project_convention');
      expect(report!.fact.status).toBe('active');
      expect(report!.fact.reinforcement_dates).toEqual(['2026-06-17']);
      expect(report!.note).toBeUndefined();

      expect(report!.provenance).toHaveLength(2);
      expect(report!.provenance[0]).toMatchObject({ id: o1.id, type: 'decision', title: 'chose bun', stale: false, superseded_by: null });
      expect(report!.provenance[1]).toMatchObject({ id: o2.id, type: 'discovery', title: 'bun test works', stale: false });

      expect(report!.supersession.superseded_by_chain).toEqual([]);
      expect(report!.supersession.replaces).toEqual([]);
      expect(report!.supersession.replaces_chain_continues).toBe(false);
    });

    it('flags a superseded source observation as stale', () => {
      const o1 = store.storeObservation('s1', 'proj', obs({ title: 'old note', narrative: 'a' }), 1, 0, Date.parse('2026-05-01T12:00:00Z'));
      const o2 = store.storeObservation('s1', 'proj', obs({ title: 'correction', narrative: 'b' }), 2, 0, Date.parse('2026-05-10T12:00:00Z'));
      const { id } = insertFact(store.db, {
        project: 'proj', kind: 'environment', fact: 'runs on bun', sourceObservationIds: [o1.id],
      }, new Date('2026-06-17T12:00:00Z'));
      expect(supersedeObservation(store.db, o1.id, o2.id)).toBe(true);

      const report = getFactProvenance(store.db, id)!;
      expect(report.provenance).toHaveLength(1);
      expect(report.provenance[0].stale).toBe(true);
      expect(report.provenance[0].superseded_by).toBe(o2.id);
    });

    it('reports an honest empty provenance + note for legacy facts without source ids', () => {
      const { id } = insertFact(store.db, {
        project: 'proj', kind: 'environment', fact: 'legacy fact', sourceObservationIds: [],
      }, new Date('2026-06-17T12:00:00Z'));

      const report = getFactProvenance(store.db, id)!;
      expect(report.provenance).toEqual([]);
      expect(report.note).toBe('no source ids recorded');
    });

    it('walks the supersession chain A → B → C up to the active head', () => {
      const a = insertFact(store.db, { project: 'proj', kind: 'environment', fact: 'v1', sourceObservationIds: [] }, new Date('2026-05-01T12:00:00Z'));
      const b = insertFact(store.db, { project: 'proj', kind: 'environment', fact: 'v2', sourceObservationIds: [] }, new Date('2026-06-01T12:00:00Z'));
      const c = insertFact(store.db, { project: 'proj', kind: 'environment', fact: 'v3', sourceObservationIds: [] }, new Date('2026-06-17T12:00:00Z'));
      expect(supersedeFact(store.db, a.id, b.id, new Date('2026-06-01T12:00:00Z'))).toBe(true);
      expect(supersedeFact(store.db, b.id, c.id, new Date('2026-06-17T12:00:00Z'))).toBe(true);

      const fromA = getFactProvenance(store.db, a.id)!;
      expect(fromA.fact.status).toBe('superseded_later');
      expect(fromA.supersession.superseded_by_chain.map(e => e.id)).toEqual([b.id, c.id]);
      expect(fromA.supersession.superseded_by_chain[0].status).toBe('superseded_later');
      expect(fromA.supersession.superseded_by_chain[1].status).toBe('active');

      const fromC = getFactProvenance(store.db, c.id)!;
      expect(fromC.supersession.superseded_by_chain).toEqual([]);
      expect(fromC.supersession.replaces.map(e => e.id)).toEqual([b.id]);
      expect(fromC.supersession.replaces_chain_continues).toBe(true); // B itself replaced A

      const fromB = getFactProvenance(store.db, b.id)!;
      expect(fromB.supersession.superseded_by_chain.map(e => e.id)).toEqual([c.id]);
      expect(fromB.supersession.replaces.map(e => e.id)).toEqual([a.id]);
      expect(fromB.supersession.replaces_chain_continues).toBe(false);
    });

    it('returns null for a missing fact', () => {
      expect(getFactProvenance(store.db, 999999)).toBeNull();
    });
  });

  describe('parseTemporalTs', () => {
    it('accepts epoch ms (number or numeric string) and ISO 8601 dates', () => {
      expect(parseTemporalTs(1750000000000)).toBe(1750000000000);
      expect(parseTemporalTs('1750000000000')).toBe(1750000000000);
      expect(parseTemporalTs('2026-06-10T00:00:00Z')).toBe(Date.parse('2026-06-10T00:00:00Z'));
      expect(parseTemporalTs('2026-06-10')).toBe(Date.parse('2026-06-10'));
    });

    it('rejects garbage', () => {
      expect(parseTemporalTs('not a date')).toBeNull();
      expect(parseTemporalTs('')).toBeNull();
      expect(parseTemporalTs(undefined)).toBeNull();
      expect(parseTemporalTs(null)).toBeNull();
      expect(parseTemporalTs(NaN)).toBeNull();
    });
  });

  describe('getFactsAt', () => {
    // Timeline: f1 (old runtime) valid from 05-01, superseded by f2 on 06-10;
    // f2 (new runtime) valid from 06-10, active; f3 (doomed) valid from
    // 05-15, invalidated on 06-01; f4 lives in another project.
    let f1: { id: number };
    let f2: { id: number };
    let f3: { id: number };

    beforeEach(() => {
      f1 = insertFact(store.db, { project: 'proj', kind: 'environment', fact: 'runtime is node', sourceObservationIds: [] }, new Date('2026-05-01T12:00:00Z'));
      f2 = insertFact(store.db, { project: 'proj', kind: 'environment', fact: 'runtime is bun', sourceObservationIds: [] }, new Date('2026-06-10T12:00:00Z'));
      f3 = insertFact(store.db, { project: 'proj', kind: 'architecture', fact: 'cache uses redis', sourceObservationIds: [] }, new Date('2026-05-15T12:00:00Z'));
      insertFact(store.db, { project: 'other', kind: 'environment', fact: 'unrelated', sourceObservationIds: [] }, new Date('2026-05-01T12:00:00Z'));
      supersedeFact(store.db, f1.id, f2.id, new Date('2026-06-10T12:00:00Z'));
      invalidateFact(store.db, f3.id, new Date('2026-06-01T12:00:00Z'));
    });

    it('returns rows true at ts, including ones superseded/invalidated since, with today-status', () => {
      const at = getFactsAt(store.db, 'proj', Date.parse('2026-05-20T12:00:00Z'));
      expect(at.map(r => r.id)).toEqual([f3.id, f1.id]); // created_at_epoch DESC
      expect(at.find(r => r.id === f1.id)!.status).toBe('superseded_later');
      expect(at.find(r => r.id === f3.id)!.status).toBe('invalidated_later');
    });

    it('valid_from is inclusive, valid_to is exclusive (UTC-day boundaries)', () => {
      // On the supersession day the successor is already true and the old row is not.
      const at = getFactsAt(store.db, 'proj', Date.parse('2026-06-10T00:00:00Z'));
      expect(at.map(r => r.id)).toEqual([f2.id]);
      expect(at[0].status).toBe('active');

      // On the invalidation day the doomed fact is already out.
      const atInvalidation = getFactsAt(store.db, 'proj', Date.parse('2026-06-01T00:00:00Z'));
      expect(atInvalidation.map(r => r.id)).toEqual([f1.id]);

      // The day before invalidation it still counted as true.
      const before = getFactsAt(store.db, 'proj', Date.parse('2026-05-31T23:59:59Z'));
      expect(before.map(r => r.id).sort()).toEqual([f1.id, f3.id].sort());
    });

    it('includeActive=false drops rows that are still active today', () => {
      const withActive = getFactsAt(store.db, 'proj', Date.parse('2026-06-20T12:00:00Z'));
      expect(withActive.map(r => r.id)).toEqual([f2.id]);

      const withoutActive = getFactsAt(store.db, 'proj', Date.parse('2026-06-20T12:00:00Z'), { includeActive: false });
      expect(withoutActive).toEqual([]);

      // Rows tombstoned since still show up with includeActive=false.
      const past = getFactsAt(store.db, 'proj', Date.parse('2026-05-20T12:00:00Z'), { includeActive: false });
      expect(past.map(r => r.id).sort()).toEqual([f1.id, f3.id].sort());
    });

    it('scopes by project', () => {
      const other = getFactsAt(store.db, 'other', Date.parse('2026-05-20T12:00:00Z'));
      expect(other).toHaveLength(1);
      expect(other[0].fact).toBe('unrelated');
    });

    it('honors the limit', () => {
      const at = getFactsAt(store.db, 'proj', Date.parse('2026-05-20T12:00:00Z'), { limit: 1 });
      expect(at).toHaveLength(1);
      expect(at[0].id).toBe(f3.id);
    });
  });

  describe('GET routes', () => {
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
        get: (path: string, handler: (req: Request, res: Response) => void) => {
          handlers.set(path, handler);
        },
        post: () => {},
        delete: () => {},
      } as any);
      return handlers;
    }

    function makeRes(): { res: Response; out: { status: number; body: any } } {
      const out = { status: 200, body: undefined as any };
      const res = {
        headersSent: false,
        status(code: number) { out.status = code; return this; },
        json(value: unknown) { out.body = value; return this; },
      } as unknown as Response;
      return { res, out };
    }

    it('GET /api/facts/:id/provenance returns the audit report', () => {
      const o1 = store.storeObservation('s1', 'proj', obs({ title: 'src', narrative: 'a' }), 1, 0, Date.parse('2026-05-01T12:00:00Z'));
      const { id } = insertFact(store.db, {
        project: 'proj', kind: 'environment', fact: 'runs on bun', sourceObservationIds: [o1.id],
      }, new Date('2026-06-17T12:00:00Z'));

      const handlers = makeRoutes();
      const { res, out } = makeRes();
      handlers.get('/api/facts/:id/provenance')!({ params: { id: String(id) } } as unknown as Request, res);

      expect(out.status).toBe(200);
      expect(out.body.fact.id).toBe(id);
      expect(out.body.provenance).toHaveLength(1);
      expect(out.body.supersession.superseded_by_chain).toEqual([]);
    });

    it('GET /api/facts/:id/provenance 404s on a missing fact', () => {
      const handlers = makeRoutes();
      const { res, out } = makeRes();
      handlers.get('/api/facts/:id/provenance')!({ params: { id: '424242' } } as unknown as Request, res);
      expect(out.status).toBe(404);
    });

    it('GET /api/facts/at returns facts true at ts with statuses', () => {
      const f1 = insertFact(store.db, { project: 'proj', kind: 'environment', fact: 'runtime is node', sourceObservationIds: [] }, new Date('2026-05-01T12:00:00Z'));
      const f2 = insertFact(store.db, { project: 'proj', kind: 'environment', fact: 'runtime is bun', sourceObservationIds: [] }, new Date('2026-06-10T12:00:00Z'));
      supersedeFact(store.db, f1.id, f2.id, new Date('2026-06-10T12:00:00Z'));

      const handlers = makeRoutes();
      const { res, out } = makeRes();
      handlers.get('/api/facts/at')!({
        query: { project: 'proj', ts: '2026-05-20T00:00:00Z' },
      } as unknown as Request, res);

      expect(out.status).toBe(200);
      expect(out.body.project).toBe('proj');
      expect(out.body.ts).toBe(Date.parse('2026-05-20T00:00:00Z'));
      expect(out.body.count).toBe(1);
      expect(out.body.facts[0]).toMatchObject({ id: f1.id, status: 'superseded_later' });
    });

    it('GET /api/facts/at accepts epoch ms and honors includeActive=false', () => {
      const f1 = insertFact(store.db, { project: 'proj', kind: 'environment', fact: 'runtime is node', sourceObservationIds: [] }, new Date('2026-05-01T12:00:00Z'));
      const f2 = insertFact(store.db, { project: 'proj', kind: 'environment', fact: 'runtime is bun', sourceObservationIds: [] }, new Date('2026-06-10T12:00:00Z'));
      supersedeFact(store.db, f1.id, f2.id, new Date('2026-06-10T12:00:00Z'));

      const handlers = makeRoutes();
      const { res, out } = makeRes();
      handlers.get('/api/facts/at')!({
        query: { project: 'proj', ts: String(Date.parse('2026-06-20T00:00:00Z')), includeActive: 'false' },
      } as unknown as Request, res);

      expect(out.status).toBe(200);
      expect(out.body.count).toBe(0); // only the active successor was true then
    });

    it('GET /api/facts/at rejects a missing project or an unparseable ts with 400', () => {
      const handlers = makeRoutes();

      const noProject = makeRes();
      handlers.get('/api/facts/at')!({ query: { ts: '2026-05-20' } } as unknown as Request, noProject.res);
      expect(noProject.out.status).toBe(400);

      const badTs = makeRes();
      handlers.get('/api/facts/at')!({ query: { project: 'proj', ts: 'not a date' } } as unknown as Request, badTs.res);
      expect(badTs.out.status).toBe(400);
      expect(badTs.out.body.error).toContain('ts');

      const noTs = makeRes();
      handlers.get('/api/facts/at')!({ query: { project: 'proj' } } as unknown as Request, noTs.res);
      expect(noTs.out.status).toBe(400);
    });
  });
});
