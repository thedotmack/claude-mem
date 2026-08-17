// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { SessionStore } from '../src/services/sqlite/SessionStore.js';
import { SessionSearch } from '../src/services/sqlite/SessionSearch.js';
import {
  selectRetentionCandidates,
  runRetentionSweep,
  observationChromaDocIds,
  RETENTION_REASON,
  type RetentionPolicy,
} from '../src/services/reinforcement/retention.js';

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

const NOW = new Date('2026-08-01T12:00:00Z');
const DAY_MS = 86_400_000;
const daysAgo = (n: number) => NOW.getTime() - n * DAY_MS;

const policy = (over: Partial<RetentionPolicy> = {}): RetentionPolicy => ({
  enabled: true,
  minAgeDays: 90,
  minStrength: 0.05,
  maxDeletesPerRun: 500,
  ...over,
});

function makeSession(store: SessionStore): void {
  store.db.run(
    `INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, status, started_at, started_at_epoch)
     VALUES ('c1', 's1', 'proj', 'active', '2026-06-17', 1750000000)`,
  );
}

/** Strip the seeded reinforcement date → strength 0 (pre-v50 rows had no backfill). */
function clearReinforcement(store: SessionStore, id: number): void {
  store.db.prepare('UPDATE observations SET reinforcement_dates = NULL, last_reinforced = NULL WHERE id = ?').run(id);
}

describe('retention policy (audit G2)', () => {
  let store: SessionStore;
  beforeEach(() => {
    store = new SessionStore(':memory:');
    makeSession(store);
  });
  afterEach(() => store.db.close());

  describe('migration v54', () => {
    it('creates deleted_observations and records schema v54', () => {
      const tables = store.db.query(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'deleted_observations'",
      ).all();
      expect(tables.length).toBe(1);
      const v = store.db.prepare('SELECT version FROM schema_versions WHERE version = ?').get(54) as { version: number } | undefined;
      expect(v?.version).toBe(54);
    });
  });

  describe('candidate selection', () => {
    it('age filter: a young strength-0 observation is not a candidate', () => {
      const young = store.storeObservation('s1', 'proj', obs(), 1, 0, daysAgo(10));
      clearReinforcement(store, young.id);
      const { candidates } = selectRetentionCandidates(store.db, policy(), NOW);
      expect(candidates.map(c => c.id)).not.toContain(young.id);
    });

    it('strength filter: a stale single-date observation above minStrength survives', () => {
      // One reinforcement date 120 days ago → strength ln(1+120^-0.5) ≈ 0.087.
      const old = store.storeObservation('s1', 'proj', obs(), 1, 0, daysAgo(120));
      let candidates = selectRetentionCandidates(store.db, policy({ minStrength: 0.05 }), NOW).candidates;
      expect(candidates.map(c => c.id)).not.toContain(old.id);
      // …but falls below a looser threshold and becomes a candidate.
      candidates = selectRetentionCandidates(store.db, policy({ minStrength: 0.2 }), NOW).candidates;
      expect(candidates.map(c => c.id)).toContain(old.id);
    });

    it('relevance filter: a surfaced observation is never a candidate', () => {
      const surfaced = store.storeObservation('s1', 'proj', obs(), 1, 0, daysAgo(120));
      clearReinforcement(store, surfaced.id);
      store.db.prepare('UPDATE observations SET relevance_count = 3 WHERE id = ?').run(surfaced.id);
      const { candidates } = selectRetentionCandidates(store.db, policy(), NOW);
      expect(candidates.map(c => c.id)).not.toContain(surfaced.id);
    });

    it('superseded filter: tombstones are erasure-cascade territory, not retention', () => {
      const tombstone = store.storeObservation('s1', 'proj', obs(), 1, 0, daysAgo(120));
      clearReinforcement(store, tombstone.id);
      store.db.prepare('UPDATE observations SET superseded_by = 999 WHERE id = ?').run(tombstone.id);
      const { candidates } = selectRetentionCandidates(store.db, policy(), NOW);
      expect(candidates.map(c => c.id)).not.toContain(tombstone.id);
    });

    it('immunity: reinforcement history of >=2 dates is never deleted, however weak', () => {
      const confirmed = store.storeObservation('s1', 'proj', obs(), 1, 0, daysAgo(400));
      store.db.prepare('UPDATE observations SET reinforcement_dates = ? WHERE id = ?')
        .run(JSON.stringify(['2025-06-01', '2025-06-02']), confirmed.id);
      // Two ancient dates: strength ln(1 + 2·~400^-0.5) ≈ 0.095 — below a loose
      // threshold, yet the world re-confirmed this note, so it is immune.
      const { candidates } = selectRetentionCandidates(store.db, policy({ minStrength: 0.2 }), NOW);
      expect(candidates.map(c => c.id)).not.toContain(confirmed.id);
    });

    it('type immunity: decisions are never candidates, however stale and weak', () => {
      // One-off decisions / constraints ("why we did it this way") are needed
      // rarely but critically — and a note the ranker never surfaced can never
      // earn retrieval reinforcement, so without this filter retention becomes
      // a self-fulfilling recall bias against exactly these.
      const decision = store.storeObservation('s1', 'proj', obs({ type: 'decision', title: 'decision note', narrative: 'why we did it this way' }), 1, 0, daysAgo(400));
      clearReinforcement(store, decision.id);
      const bugfix = store.storeObservation('s1', 'proj', obs({ type: 'bugfix', title: 'bugfix note', narrative: 'fixed the race' }), 1, 0, daysAgo(400));
      clearReinforcement(store, bugfix.id);
      const { candidates } = selectRetentionCandidates(store.db, policy(), NOW);
      expect(candidates.map(c => c.id)).not.toContain(decision.id);
      expect(candidates.map(c => c.id)).toContain(bugfix.id); // control: same age/weakness, deletable type
    });

    it('a stale, strength-0, never-surfaced, active observation IS a candidate', () => {
      const stale = store.storeObservation('s1', 'proj', obs(), 1, 0, daysAgo(120));
      clearReinforcement(store, stale.id);
      const { candidates, scanned } = selectRetentionCandidates(store.db, policy(), NOW);
      expect(scanned).toBe(1);
      expect(candidates).toHaveLength(1);
      expect(candidates[0].id).toBe(stale.id);
      expect(candidates[0].strength).toBe(0);
      expect(candidates[0].ageDays).toBe(120);
    });

    it('caps the run at maxDeletesPerRun, oldest first', () => {
      const ids: number[] = [];
      for (let i = 0; i < 5; i++) {
        const row = store.storeObservation('s1', 'proj', obs({ title: `stale-${i}`, narrative: `n-${i}` }), i + 1, 0, daysAgo(120 + i));
        clearReinforcement(store, row.id);
        ids.push(row.id);
      }
      const { candidates } = selectRetentionCandidates(store.db, policy({ maxDeletesPerRun: 2 }), NOW);
      expect(candidates).toHaveLength(2);
      expect(candidates.map(c => c.id)).toEqual([ids[4], ids[3]]); // 124d, 123d oldest
    });
  });

  describe('sweep', () => {
    it('dry-run reports candidates without mutating anything', () => {
      const stale = store.storeObservation('s1', 'proj', obs(), 1, 0, daysAgo(120));
      clearReinforcement(store, stale.id);

      const result = runRetentionSweep(store.db, policy(), { dryRun: true, now: NOW });
      expect(result.dryRun).toBe(true);
      expect(result.candidates).toHaveLength(1);
      expect(result.deleted).toBe(0);
      expect(result.batchId).toBeNull();

      expect(store.db.prepare('SELECT COUNT(*) AS n FROM observations').get()).toEqual({ n: 1 });
      expect(store.db.prepare('SELECT COUNT(*) AS n FROM deleted_observations').get()).toEqual({ n: 0 });
    });

    it('apply snapshots rows into deleted_observations and removes them', () => {
      const stale = store.storeObservation('s1', 'proj', obs({ title: 'stale note', narrative: 'old stuff' }), 1, 0, daysAgo(120));
      clearReinforcement(store, stale.id);
      const keep = store.storeObservation('s1', 'proj', obs({ title: 'fresh', narrative: 'new' }), 2, 0, daysAgo(10));
      clearReinforcement(store, keep.id);

      const result = runRetentionSweep(store.db, policy(), { dryRun: false, now: NOW });
      expect(result.deleted).toBe(1);
      expect(result.batchId).not.toBeNull();

      const remaining = store.db.prepare('SELECT id FROM observations').all() as Array<{ id: number }>;
      expect(remaining.map(r => r.id)).toEqual([keep.id]);

      const audit = store.db.prepare('SELECT * FROM deleted_observations').all() as Array<{
        observation_id: number; snapshot_json: string; reason: string; batch_id: string; deleted_at: string;
      }>;
      expect(audit).toHaveLength(1);
      expect(audit[0].observation_id).toBe(stale.id);
      expect(audit[0].reason).toBe(RETENTION_REASON);
      expect(audit[0].batch_id).toBe(result.batchId);
      const snapshot = JSON.parse(audit[0].snapshot_json) as { id: number; title: string; narrative: string };
      expect(snapshot.id).toBe(stale.id);
      expect(snapshot.title).toBe('stale note');
      expect(snapshot.narrative).toBe('old stuff');
      expect(result.snapshots).toHaveLength(1);
    });

    it('apply cleans the FTS index via the observations_ad trigger', () => {
      new SessionSearch(store.db); // sets up observations_fts + triggers
      const stale = store.storeObservation('s1', 'proj', obs({ title: 'zyxqwv unique term', narrative: 'zyxqwv body' }), 1, 0, daysAgo(120));
      clearReinforcement(store, stale.id);

      const search = new SessionSearch(store.db);
      expect(search.searchObservations('zyxqwv', { limit: 10 }).map(o => o.id)).toContain(stale.id);

      runRetentionSweep(store.db, policy(), { dryRun: false, now: NOW });
      expect(search.searchObservations('zyxqwv', { limit: 10 }).map(o => o.id)).not.toContain(stale.id);
    });
  });

  describe('observationChromaDocIds', () => {
    it('mirrors the formatObservationDocs id scheme', () => {
      const ids = observationChromaDocIds({
        id: 42,
        narrative: 'n',
        text: null,
        facts: JSON.stringify(['f1', 'f2']),
      });
      expect(ids).toEqual(['obs_42_narrative', 'obs_42_fact_0', 'obs_42_fact_1']);
    });

    it('tolerates malformed facts JSON', () => {
      expect(observationChromaDocIds({ id: 7, narrative: null, text: 't', facts: '{bad' }))
        .toEqual(['obs_7_text']);
    });
  });
});
