// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { SessionStore } from '../src/services/sqlite/SessionStore.js';
import { SessionSearch } from '../src/services/sqlite/SessionSearch.js';
import { recordSurfaced } from '../src/services/reinforcement/persist.js';
import {
  detectEcho,
  findDedupCandidates,
  ECHO_LAST_SURFACED_WINDOW_DAYS,
} from '../src/services/reinforcement/dedup.js';
import { queryObservationsMulti } from '../src/services/context/ObservationCompiler.js';
import type { ContextConfig } from '../src/services/context/types.js';
import { computeGroundedness, hasToolEvidence } from '../scripts/memory-eval/lib/groundedness.js';

/**
 * Memory grounding (plans/2026-08-05-memory-grounding.md): migration v55,
 * echo detection (Layer 2) and the groundedness metric (Layer 3).
 */

const TODAY = new Date('2026-08-05T12:00:00Z');

const mkObs = (title: string, narrative: string, over: Record<string, unknown> = {}) => ({
  type: 'discovery',
  title,
  subtitle: null,
  facts: [],
  narrative,
  concepts: [],
  files_read: [],
  files_modified: [],
  ...over,
});

function makeSession(store: SessionStore): void {
  store.db.run(
    `INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, status, started_at, started_at_epoch)
     VALUES ('c1', 's1', 'proj', 'active', '2026-08-01', 1754000000)`,
  );
}

const colOf = (store: SessionStore, id: number, col: string) =>
  (store.db.prepare(`SELECT ${col} AS v FROM observations WHERE id=?`).get(id) as { v: unknown }).v;

describe('migration v55 (last_surfaced + echo_of)', () => {
  it('adds both columns and records the schema version', () => {
    const store = new SessionStore(':memory:');
    const cols = (store.db.query('PRAGMA table_info(observations)').all() as { name: string }[]).map(c => c.name);
    expect(cols).toContain('last_surfaced');
    expect(cols).toContain('echo_of');
    const v = store.db.prepare('SELECT version FROM schema_versions WHERE version=?').get(55) as { version: number } | undefined;
    expect(v?.version).toBe(55);
    store.db.close();
  });

  it('is idempotent — re-running the migration chain does not throw', () => {
    const store = new SessionStore(':memory:');
    expect(() => new SessionStore(store.db)).not.toThrow();
    store.db.close();
  });
});

describe('recordSurfaced stamps last_surfaced', () => {
  it('sets the ISO day alongside the relevance_count bump', () => {
    const store = new SessionStore(':memory:');
    makeSession(store);
    const a = store.storeObservation('s1', 'proj', mkObs('a', 'a'), 1, 0, 1754000000000);
    expect(colOf(store, a.id, 'last_surfaced')).toBeNull();

    recordSurfaced(store.db, [a.id], TODAY);
    expect(colOf(store, a.id, 'last_surfaced')).toBe('2026-08-05');
    store.db.close();
  });
});

describe('detectEcho (three conditions, each gated separately)', () => {
  let store: SessionStore;
  let targetId: number;
  const near = () => ({
    project: 'proj',
    type: 'discovery',
    title: 'auth token rotation',
    narrative: 'auth tokens rotate on a schedule',
    files_read: [] as string[],
    files_modified: [] as string[],
  });
  const setSurfaced = (day: string | null) =>
    store.db.prepare('UPDATE observations SET last_surfaced = ? WHERE id = ?').run(day, targetId);

  beforeEach(() => {
    store = new SessionStore(':memory:');
    new SessionSearch(store.db); // observations_fts + triggers
    makeSession(store);
    const r = store.storeObservation('s1', 'proj',
      mkObs('auth token refresh', 'the auth token refresh flow rotates keys on a schedule'),
      1, 0, 1754000000000);
    targetId = r.id;
  });
  afterEach(() => store.db.close());

  it('condition 1: no semantically-near candidate → not an echo', () => {
    setSurfaced('2026-08-04'); // fresh, but nothing near this new observation
    const unrelated = { ...near(), title: 'payment webhook retries', narrative: 'stripe webhooks retry with backoff' };
    expect(detectEcho(store.db, unrelated, { today: TODAY })).toBeNull();
  });

  it('condition 2: near candidate never surfaced → not an echo', () => {
    setSurfaced(null);
    expect(detectEcho(store.db, near(), { today: TODAY })).toBeNull();
  });

  it('condition 2: near candidate surfaced outside the window → not an echo', () => {
    const stale = new Date(TODAY.getTime() - (ECHO_LAST_SURFACED_WINDOW_DAYS + 10) * 86_400_000);
    setSurfaced(stale.toISOString().slice(0, 10));
    expect(detectEcho(store.db, near(), { today: TODAY })).toBeNull();
  });

  it('condition 3: new observation carries tool evidence → not an echo', () => {
    setSurfaced('2026-08-04');
    expect(detectEcho(store.db, { ...near(), files_read: ['src/auth.ts'] }, { today: TODAY })).toBeNull();
    expect(detectEcho(store.db, { ...near(), files_modified: ['src/auth.ts'] }, { today: TODAY })).toBeNull();
  });

  it('all three conditions → returns the echoed observation id', () => {
    setSurfaced('2026-08-04');
    expect(detectEcho(store.db, near(), { today: TODAY })).toBe(targetId);
  });

  it('surfaced exactly on the cutoff day still counts as fresh', () => {
    const cutoff = new Date(TODAY.getTime() - ECHO_LAST_SURFACED_WINDOW_DAYS * 86_400_000);
    setSurfaced(cutoff.toISOString().slice(0, 10));
    expect(detectEcho(store.db, near(), { today: TODAY })).toBe(targetId);
  });
});

describe('echo storage (Layer 2 write path)', () => {
  let store: SessionStore;
  let targetId: number;
  beforeEach(() => {
    store = new SessionStore(':memory:');
    new SessionSearch(store.db);
    makeSession(store);
    const r = store.storeObservation('s1', 'proj',
      mkObs('auth token refresh', 'the auth token refresh flow rotates keys', { concepts: ['grounding'] }),
      1, 0, 1754000000000);
    targetId = r.id;
  });
  afterEach(() => store.db.close());

  it('echo rows are stored with echo_of set and NO reinforcement seed', () => {
    const echo = store.storeObservation('s1', 'proj',
      { ...mkObs('auth token refresh retold', 'retells the auth token refresh note'), echo_of: targetId },
      2, 0, 1754000001000);
    expect(colOf(store, echo.id, 'echo_of')).toBe(targetId);
    expect(colOf(store, echo.id, 'reinforcement_dates')).toBeNull();
    expect(colOf(store, echo.id, 'last_reinforced')).toBeNull();
    // a normal row written in the same batch still gets its seed
    const normal = store.storeObservation('s1', 'proj', mkObs('fresh fact', 'brand new'), 2, 0, 1754000002000);
    expect(colOf(store, normal.id, 'reinforcement_dates')).not.toBeNull();
  });

  it('echo rows drop out of the ACT-R injection pool (same filter as superseded)', () => {
    const config: ContextConfig = {
      totalObservationCount: 50,
      fullObservationCount: 10,
      sessionCount: 0,
      factsInjectCount: 0,
      showReadTokens: false,
      showWorkTokens: false,
      showSavingsAmount: false,
      showSavingsPercent: false,
      observationTypes: new Set(['discovery']),
      observationConcepts: new Set(['grounding']),
      fullObservationField: 'narrative',
      showLastSummary: false,
      showLastMessage: false,
    };
    const echo = store.storeObservation('s1', 'proj',
      { ...mkObs('auth token refresh retold', 'retells the auth token refresh note', { concepts: ['grounding'] }), echo_of: targetId },
      2, 0, 1754000001000);
    const pool = queryObservationsMulti({ db: store.db }, ['proj'], config);
    const ids = pool.map(o => o.id);
    expect(ids).toContain(targetId);
    expect(ids).not.toContain(echo.id);
  });

  it('echo rows drop out of dedup candidacy', () => {
    store.storeObservation('s1', 'proj',
      { ...mkObs('auth token refresh retold', 'retells the auth token refresh note rotates keys'), echo_of: targetId },
      2, 0, 1754000001000);
    const cands = findDedupCandidates(store.db, {
      project: 'proj', type: 'discovery', title: 'auth token', narrative: 'rotating auth keys',
    });
    expect(cands.length).toBe(1);
    expect(cands[0].id).toBe(targetId);
  });

  it('echo rows skip the dedup judge — the echoed note is NOT reinforced', async () => {
    const { applyDedupJudge } = await import('../src/services/reinforcement/dedup-judge.js');
    const before = colOf(store, targetId, 'reinforcement_dates');
    let judgeCalls = 0;
    const judge = async () => {
      judgeCalls++;
      return '{"action":"INCREMENT","target":1,"rationale":"same"}';
    };
    const batch = [{
      type: 'discovery',
      title: 'auth token refresh retold',
      narrative: 'retells the auth token refresh note',
      echo_of: targetId,
    }];
    const kept = await applyDedupJudge(store.db, batch, 'proj', judge);
    expect(kept.length).toBe(1); // echo is stored, not dropped
    expect(judgeCalls).toBe(0); // judge never saw it
    expect(colOf(store, targetId, 'reinforcement_dates')).toBe(before); // A unchanged
  });
});

describe('groundedness metric (Layer 3)', () => {
  it('hasToolEvidence: non-empty files_read or files_modified counts', () => {
    expect(hasToolEvidence('["a.ts"]', null)).toBe(true);
    expect(hasToolEvidence('[]', '["b.ts"]')).toBe(true);
    expect(hasToolEvidence('[]', '[]')).toBe(false);
    expect(hasToolEvidence(null, null)).toBe(false);
    expect(hasToolEvidence('not json', null)).toBe(false);
  });

  it('computes all three metrics on an in-memory store', () => {
    const store = new SessionStore(':memory:');
    makeSession(store);
    // 1 grounded, 1 ungrounded, 1 echo (echoes excluded from the active pool)
    const grounded = store.storeObservation('s1', 'proj',
      { ...mkObs('real fix', 'fixed it'), files_read: ['src/a.ts'] }, 1, 0, 1754000000000);
    const ungrounded = store.storeObservation('s1', 'proj', mkObs('vibes', 'it probably works'), 1, 0, 1754000001000);
    store.storeObservation('s1', 'proj',
      { ...mkObs('real fix retold', 'retells the fix'), echo_of: grounded.id }, 2, 0, 1754000002000);

    // one fact fully grounded (source has evidence), one not (source lacks it)
    const insertFact = store.db.prepare(`
      INSERT INTO semantic_facts
      (project, kind, fact, source_observation_ids, content_hash, created_at, created_at_epoch, updated_at_epoch)
      VALUES ('proj', 'world', ?, ?, ?, '2026-08-01T00:00:00.000Z', 1754000000000, 1754000000000)
    `);
    insertFact.run('grounded fact', JSON.stringify([grounded.id]), 'h1');
    insertFact.run('ungrounded fact', JSON.stringify([ungrounded.id]), 'h2');
    insertFact.run('sourceless fact', '[]', 'h3');

    const result = computeGroundedness(store.db);

    expect(result.observations.active).toBe(2); // echo excluded
    expect(result.observations.withToolEvidence).toBe(1);
    expect(result.observations.pct).toBeCloseTo(0.5);

    expect(result.facts).not.toBeNull();
    expect(result.facts!.active).toBe(3);
    expect(result.facts!.withSources).toBe(2);
    expect(result.facts!.sourceless).toBe(1);
    expect(result.facts!.allSourcesGrounded).toBe(1);
    expect(result.facts!.pct).toBeCloseTo(0.5);

    expect(result.echo.available).toBe(true);
    expect(result.echo.total).toBe(1);
    expect(result.echo.byMonth.length).toBe(1);
    const month = result.echo.byMonth[0];
    expect(month.observations).toBe(3); // month bucket counts everything, echoes included
    expect(month.echoes).toBe(1);
    store.db.close();
  });

  it('reports echo metric as unavailable on a pre-v55 schema', () => {
    const store = new SessionStore(':memory:');
    // simulate a DB the v55 migration hasn't reached yet: a minimal pre-v55
    // observations table in a fresh in-memory db (no echo_of, no semantic_facts)
    store.db.close();
    const db = new Database(':memory:');
    db.run(`CREATE TABLE observations (
      id INTEGER PRIMARY KEY, project TEXT, type TEXT, title TEXT, narrative TEXT,
      files_read TEXT, files_modified TEXT, superseded_by INTEGER,
      created_at TEXT, created_at_epoch INTEGER
    )`);
    db.run(`INSERT INTO observations (project, type, title, narrative, files_read, files_modified, created_at, created_at_epoch)
            VALUES ('proj', 'discovery', 'x', 'y', '["a.ts"]', '[]', '2026-08-01T00:00:00.000Z', 1754000000000)`);
    const result = computeGroundedness(db);
    expect(result.echo.available).toBe(false);
    expect(result.facts).toBeNull(); // no semantic_facts table either
    expect(result.observations.pct).toBeCloseTo(1);
    db.close();
  });
});
