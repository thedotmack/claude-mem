// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { SessionStore } from '../src/services/sqlite/SessionStore.js';
import {
  buildConsolidationPrompt,
  parseConsolidationVerdicts,
  type ConsolidationObservationInput,
} from '../src/services/reinforcement/consolidation.js';
import { shouldConsolidate, runConsolidation } from '../src/services/reinforcement/consolidation-judge.js';
import { getActiveFacts, getFactsByIds, type SemanticFactRow } from '../src/services/sqlite/facts/store.js';

const OBS: ConsolidationObservationInput[] = [
  { id: 11, title: 'Bun runtime adopted', narrative: 'The project runs on Bun with bun:sqlite.', concepts: '["environment"]' },
  { id: 12, title: 'Test runner', narrative: 'Tests run via `bun test`.', concepts: null },
];

const FACT_IDS = new Set([7]);
const OBS_IDS = new Set([11, 12]);

function parse(raw: string) {
  return parseConsolidationVerdicts(raw, { factIds: FACT_IDS, observationIds: OBS_IDS });
}

describe('Semantic memory layer — consolidation prompt', () => {
  it('lists active facts and new observations with their ids', () => {
    const prompt = buildConsolidationPrompt([{ id: 7, kind: 'environment', fact: 'Runs on Bun.' }], OBS);
    expect(prompt).toContain('[F7] (environment) Runs on Bun.');
    expect(prompt).toContain('[O11] Bun runtime adopted');
    expect(prompt).toContain('[O12] Test runner');
    expect(prompt).toContain('source_ids');
  });
});

describe('Semantic memory layer — verdict parsing', () => {
  it('parses an ADD verdict with kind, fact, and source ids', () => {
    const { verdicts, rejected } = parse(JSON.stringify({
      verdicts: [{ action: 'ADD', kind: 'environment', fact: 'This project runs on Bun.', source_ids: [11] }],
    }));
    expect(rejected).toEqual([]);
    expect(verdicts).toEqual([{ action: 'ADD', kind: 'environment', fact: 'This project runs on Bun.', sourceIds: [11] }]);
  });

  it('parses an UPDATE verdict targeting an active fact', () => {
    const { verdicts } = parse('{"verdicts":[{"action":"UPDATE","target_fact_id":7,"fact":"Runs on Bun 1.3 now.","source_ids":[11]}]}');
    expect(verdicts).toEqual([{ action: 'UPDATE', targetFactId: 7, fact: 'Runs on Bun 1.3 now.', sourceIds: [11] }]);
  });

  it('accepts string ids with O/F/# prefixes — LLMs cite the prompt markers verbatim', () => {
    // Observed live with kimi-for-coding (2026-07-28): the judge returns
    // source_ids as ["O7211"], copying the [O<id>] prompt format.
    const { verdicts, rejected } = parse('{"verdicts":[' +
      '{"action":"ADD","kind":"environment","fact":"Runs tests via uv.","source_ids":["O11","#12",11]},' +
      '{"action":"UPDATE","target_fact_id":"F7","fact":"Runs on Bun 1.3.","source_ids":["O11"]},' +
      '{"action":"DELETE","target_fact_id":"7"}' +
      ']}');
    expect(rejected).toEqual([]);
    expect(verdicts).toEqual([
      { action: 'ADD', kind: 'environment', fact: 'Runs tests via uv.', sourceIds: [11, 12] },
      { action: 'UPDATE', targetFactId: 7, fact: 'Runs on Bun 1.3.', sourceIds: [11] },
      { action: 'DELETE', targetFactId: 7 },
    ]);
  });

  it('parses a DELETE verdict', () => {
    const { verdicts } = parse('{"verdicts":[{"action":"DELETE","target_fact_id":7}]}');
    expect(verdicts).toEqual([{ action: 'DELETE', targetFactId: 7 }]);
  });

  it('parses a bare NOOP and collapses duplicates', () => {
    const { verdicts } = parse('{"verdicts":[{"action":"NOOP"},{"action":"NOOP"}]}');
    expect(verdicts).toEqual([{ action: 'NOOP' }]);
  });

  it('fact-gate: rejects ADD with zero source_ids', () => {
    const { verdicts, rejected } = parse('{"verdicts":[{"action":"ADD","kind":"environment","fact":"Hallucinated.","source_ids":[]}]}');
    expect(verdicts).toEqual([]);
    expect(rejected.some(r => r.includes('fact-gate'))).toBe(true);
  });

  it('fact-gate: rejects UPDATE whose source_ids cite no shown observation', () => {
    const { verdicts, rejected } = parse('{"verdicts":[{"action":"UPDATE","target_fact_id":7,"fact":"x","source_ids":[999]}]}');
    expect(verdicts).toEqual([]);
    expect(rejected.some(r => r.includes('fact-gate'))).toBe(true);
  });

  it('fact-gate: rejects ADD with no source_ids field at all', () => {
    const { verdicts, rejected } = parse('{"verdicts":[{"action":"ADD","kind":"environment","fact":"Hallucinated."}]}');
    expect(verdicts).toEqual([]);
    expect(rejected.some(r => r.includes('fact-gate'))).toBe(true);
  });

  it('rejects verdicts targeting facts that were not shown', () => {
    const { verdicts, rejected } = parse('{"verdicts":[{"action":"DELETE","target_fact_id":999},{"action":"UPDATE","target_fact_id":999,"fact":"x","source_ids":[11]}]}');
    expect(verdicts).toEqual([]);
    expect(rejected.length).toBe(2);
  });

  it('rejects unknown kinds and unknown actions', () => {
    const { verdicts, rejected } = parse('{"verdicts":[{"action":"ADD","kind":"gossip","fact":"x","source_ids":[11]},{"action":"EXPLODE"}]}');
    expect(verdicts).toEqual([]);
    expect(rejected.length).toBe(2);
  });

  it('malformed JSON degrades to zero verdicts (NOOP effect)', () => {
    for (const raw of ['not json at all', '{"verdicts": [', '{"foo": 1}', '']) {
      const { verdicts, rejected } = parse(raw);
      expect(verdicts).toEqual([]);
      expect(rejected.length).toBeGreaterThan(0);
    }
  });

  it('tolerates prose around the JSON and keeps valid verdicts alongside rejected ones', () => {
    const raw = 'Here are my verdicts:\n{"verdicts":[{"action":"ADD","kind":"user_preference","fact":"The user prefers Russian.","source_ids":[12]},{"action":"DELETE","target_fact_id":999}]}\nDone.';
    const { verdicts, rejected } = parse(raw);
    expect(verdicts).toEqual([{ action: 'ADD', kind: 'user_preference', fact: 'The user prefers Russian.', sourceIds: [12] }]);
    expect(rejected.length).toBe(1);
  });

  it('accepts a bare verdicts array without the wrapping object', () => {
    const { verdicts } = parse('[{"action":"NOOP"}]');
    expect(verdicts).toEqual([{ action: 'NOOP' }]);
  });
});

describe('Semantic memory layer — consolidation throttle', () => {
  let store: SessionStore;

  beforeEach(() => {
    store = new SessionStore(':memory:');
    store.db.run(
      `INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, status, started_at, started_at_epoch)
       VALUES ('c1', 's1', 'proj', 'active', '2026-06-17', 1750000000)`,
    );
  });

  afterEach(() => store.db.close());

  const addObservations = (count: number): void => {
    for (let i = 0; i < count; i++) {
      store.db.run(
        `INSERT INTO observations (memory_session_id, project, text, type, title, narrative, created_at, created_at_epoch)
         VALUES ('s1', 'proj', 't', 'discovery', ?, 'n', '2026-06-17', 1750000000)`,
        [`title-${i}-${Math.random()}`],
      );
    }
  };

  const thresholds = { minIntervalHours: 12, minObservations: 20 };
  const NOW = new Date('2026-06-17T12:00:00Z');

  it('blocks when there are not enough new observations', () => {
    addObservations(5);
    const decision = shouldConsolidate(store.db, 'proj', thresholds, NOW);
    expect(decision.ok).toBe(false);
    expect(decision.newObservations).toBe(5);
  });

  it('allows the first run once enough observations exist', () => {
    addObservations(25);
    expect(shouldConsolidate(store.db, 'proj', thresholds, NOW).ok).toBe(true);
  });

  it('blocks within the min interval after a recorded run', () => {
    addObservations(25);
    store.db.prepare('INSERT INTO semantic_consolidation_state (project, last_run_at_epoch, last_observation_id) VALUES (?, ?, ?)')
      .run('proj', NOW.getTime() - 60 * 60 * 1000, 0); // 1h ago
    const decision = shouldConsolidate(store.db, 'proj', thresholds, NOW);
    expect(decision.ok).toBe(false);
    expect(decision.reason).toBe('min interval not elapsed');
  });

  it('counts only observations after the last-run watermark', () => {
    addObservations(25);
    const maxId = (store.db.prepare('SELECT MAX(id) AS m FROM observations').get() as { m: number }).m;
    store.db.prepare('INSERT INTO semantic_consolidation_state (project, last_run_at_epoch, last_observation_id) VALUES (?, ?, ?)')
      .run('proj', NOW.getTime() - 48 * 60 * 60 * 1000, maxId); // 48h ago, interval elapsed
    addObservations(3);
    const decision = shouldConsolidate(store.db, 'proj', thresholds, NOW);
    expect(decision.ok).toBe(false);
    expect(decision.newObservations).toBe(3);
  });
});

describe('Semantic memory layer — consolidation run (fake judge)', () => {
  let store: SessionStore;

  beforeEach(() => {
    store = new SessionStore(':memory:');
    store.db.run(
      `INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, status, started_at, started_at_epoch)
       VALUES ('c1', 's1', 'proj', 'active', '2026-06-17', 1750000000)`,
    );
    for (let i = 0; i < 3; i++) {
      store.db.run(
        `INSERT INTO observations (memory_session_id, project, text, type, title, narrative, created_at, created_at_epoch)
         VALUES ('s1', 'proj', 't', 'discovery', 'obs-${i}', 'narrative-${i}', '2026-06-17', ${Date.parse('2026-06-17T12:00:00Z') + i})`,
      );
    }
  });

  afterEach(() => store.db.close());

  const NOW = new Date('2026-06-17T12:00:00Z');
  const obsIds = (store: SessionStore): number[] =>
    (store.db.prepare('SELECT id FROM observations ORDER BY id').all() as Array<{ id: number }>).map(r => r.id);

  const factRows = (store: SessionStore): SemanticFactRow[] =>
    store.db.prepare('SELECT * FROM semantic_facts ORDER BY id').all() as SemanticFactRow[];

  it('applies ADD / UPDATE / DELETE / NOOP verdicts against the store', async () => {
    const addObservation = (title: string): number =>
      Number(store.db.run(
        `INSERT INTO observations (memory_session_id, project, text, type, title, narrative, created_at, created_at_epoch)
         VALUES ('s1', 'proj', 't', 'discovery', ?, 'n', '2026-06-17', ?)`,
        [title, Date.parse('2026-06-17T12:00:00Z')],
      ).lastInsertRowid);

    // Seed an active fact via a first run.
    const ids = obsIds(store);
    const addJudge = async () => JSON.stringify({
      verdicts: [{ action: 'ADD', kind: 'environment', fact: 'This project runs on Bun.', source_ids: [ids[0]] }],
    });
    const first = await runConsolidation(store.db, 'proj', addJudge, NOW, { force: true });
    expect(first.ran).toBe(true);
    expect(first.added).toBe(1);

    const seeded = factRows(store)[0];
    expect(seeded.fact).toBe('This project runs on Bun.');
    expect(seeded.valid_from).toBe('2026-06-17'); // earliest source observation day

    // Second run: update the seeded fact, delete nothing real, noop extra. A
    // fresh observation is needed — the first run moved the watermark.
    const newObsId = addObservation('obs-for-update');
    const secondJudge = async () => JSON.stringify({
      verdicts: [
        { action: 'UPDATE', target_fact_id: seeded.id, fact: 'This project runs on Bun 1.3.', source_ids: [newObsId] },
        { action: 'DELETE', target_fact_id: 999999 },
        { action: 'NOOP' },
      ],
    });
    const second = await runConsolidation(store.db, 'proj', secondJudge, NOW, { force: true });
    expect(second.updated).toBe(1);
    expect(second.deleted).toBe(0); // out-of-range target rejected by the parser
    expect(second.noop).toBe(true);
    expect(second.rejected.length).toBe(1);

    const rows = factRows(store);
    expect(rows.length).toBe(2);
    const oldRow = rows.find(r => r.id === seeded.id)!;
    const newRow = rows.find(r => r.id !== seeded.id)!;
    expect(oldRow.superseded_by).toBe(newRow.id);
    expect(oldRow.valid_to).toBe('2026-06-17');
    expect(newRow.kind).toBe('environment'); // UPDATE inherits the old kind
    expect(newRow.fact).toBe('This project runs on Bun 1.3.');

    // Third run: DELETE tombstones the new fact.
    addObservation('obs-for-delete');
    const deleteJudge = async () => JSON.stringify({ verdicts: [{ action: 'DELETE', target_fact_id: newRow.id }] });
    const third = await runConsolidation(store.db, 'proj', deleteJudge, NOW, { force: true });
    expect(third.deleted).toBe(1);
    expect(getFactsByIds(store.db, [newRow.id])[0].invalidated_at).not.toBeNull();
    expect(getActiveFacts(store.db, ['proj'], 10)).toEqual([]);
  });

  it('records the run watermark so the next throttle window sees no new observations', async () => {
    const judge = async () => '{"verdicts":[{"action":"NOOP"}]}';
    await runConsolidation(store.db, 'proj', judge, NOW, { force: true });

    const state = store.db.prepare('SELECT * FROM semantic_consolidation_state WHERE project = ?').get('proj') as {
      last_run_at_epoch: number; last_observation_id: number;
    };
    expect(state.last_run_at_epoch).toBe(NOW.getTime());
    expect(state.last_observation_id).toBe(Math.max(...obsIds(store)));

    const decision = shouldConsolidate(store.db, 'proj', { minIntervalHours: 0, minObservations: 1 }, NOW);
    expect(decision.ok).toBe(false);
    expect(decision.newObservations).toBe(0);
  });

  it('a throwing judge produces a NOOP and no writes', async () => {
    const judge = async () => { throw new Error('LLM unavailable'); };
    const summary = await runConsolidation(store.db, 'proj', judge, NOW, { force: true });
    expect(summary.ran).toBe(false);
    expect(factRows(store)).toEqual([]);
  });

  it('garbage judge output produces a NOOP and no writes', async () => {
    const judge = async () => 'I have no idea what you mean.';
    const summary = await runConsolidation(store.db, 'proj', judge, NOW, { force: true });
    expect(summary.ran).toBe(true);
    expect(summary.added + summary.updated + summary.deleted).toBe(0);
    expect(summary.rejected.length).toBeGreaterThan(0);
    expect(factRows(store)).toEqual([]);
  });

  it('respects the throttle unless forced', async () => {
    const judge = async () => '{"verdicts":[{"action":"NOOP"}]}';
    // Only 3 observations, default threshold is 20 → skipped without an LLM call.
    const skipped = await runConsolidation(store.db, 'proj', judge, NOW);
    expect(skipped.ran).toBe(false);
    expect(skipped.reason).toBe('not enough new observations');

    const forced = await runConsolidation(store.db, 'proj', judge, NOW, { force: true });
    expect(forced.ran).toBe(true);
  });
});
