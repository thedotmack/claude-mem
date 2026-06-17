// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { SessionStore } from '../src/services/sqlite/SessionStore.js';
import { SessionSearch } from '../src/services/sqlite/SessionSearch.js';
import {
  significantTokens,
  buildFtsQuery,
  findDedupCandidates,
  buildJudgePrompt,
  parseVerdict,
  judgeObservation,
  type JudgeFn,
} from '../src/services/reinforcement/dedup.js';

describe('significantTokens', () => {
  it('lowercases, drops stopwords + short words, dedups, keeps cyrillic', () => {
    expect(significantTokens('Fixed the AUTH token refresh refresh')).toEqual(['auth', 'token', 'refresh']);
    expect(significantTokens('обновление токена авторизации')).toEqual(['обновление', 'токена', 'авторизации']);
  });
  it('empty for null / trivial', () => {
    expect(significantTokens(null)).toEqual([]);
    expect(significantTokens('a of to is')).toEqual([]);
  });
});

describe('buildFtsQuery', () => {
  it('ORs quoted terms from title+narrative', () => {
    const q = buildFtsQuery({ project: 'p', type: 'discovery', title: 'auth token', narrative: 'refresh flow' });
    expect(q).toContain('"auth"');
    expect(q).toContain(' OR ');
    expect(q).toContain('"refresh"');
  });
  it('empty when nothing significant', () => {
    expect(buildFtsQuery({ project: 'p', type: 'discovery', title: 'a to', narrative: null })).toBe('');
  });
});

describe('parseVerdict', () => {
  it('parses a clean JSON verdict', () => {
    expect(parseVerdict('{"action":"INCREMENT","target":2,"rationale":"same"}', 3)).toEqual({
      action: 'INCREMENT', target: 2, rationale: 'same',
    });
  });
  it('extracts JSON embedded in prose', () => {
    expect(parseVerdict('Here: {"action":"ADD","target":null,"rationale":"new"} done', 3).action).toBe('ADD');
  });
  it('fails open to ADD on unparseable', () => {
    expect(parseVerdict('no json here', 3).action).toBe('ADD');
    expect(parseVerdict('{bad json', 3).action).toBe('ADD');
  });
  it('fails open to ADD on out-of-range target', () => {
    expect(parseVerdict('{"action":"INCREMENT","target":9,"rationale":"x"}', 3).action).toBe('ADD');
    expect(parseVerdict('{"action":"INCREMENT","target":0,"rationale":"x"}', 3).action).toBe('ADD');
  });
  it('rejects unknown action', () => {
    expect(parseVerdict('{"action":"MERGE","target":1}', 3).action).toBe('ADD');
  });
});

describe('buildJudgePrompt', () => {
  it('numbers candidates and includes the new observation', () => {
    const p = buildJudgePrompt(
      { project: 'p', type: 'discovery', title: 'new', narrative: 'body' },
      [{ id: 5, type: 'discovery', title: 'old', subtitle: null, narrative: 'oldbody' }],
    );
    expect(p).toContain('[1] (discovery) old');
    expect(p).toContain('NEW OBSERVATION');
    expect(p).toContain('INCREMENT');
  });
});

describe('findDedupCandidates (FTS over real observations)', () => {
  let store: SessionStore;
  const mkObs = (title: string, narrative: string) => ({
    type: 'discovery', title, subtitle: null, facts: [], narrative,
    concepts: [], files_read: [], files_modified: [],
  });
  beforeEach(() => {
    store = new SessionStore(':memory:');
    new SessionSearch(store.db); // sets up observations_fts + triggers
    store.db.run(
      `INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, status, started_at, started_at_epoch)
       VALUES ('c1','s1','proj','active','2026-06-17',1750000000)`,
    );
    store.storeObservation('s1', 'proj', mkObs('auth token refresh', 'the auth token refresh flow rotates keys'), 1, 0, 1750000000000);
    store.storeObservation('s1', 'proj', mkObs('database migration', 'sqlite schema migration adds a column'), 1, 0, 1750000000000);
  });
  afterEach(() => store.db.close());

  it('finds the topically-matching candidate, not the unrelated one', () => {
    const cands = findDedupCandidates(store.db, { project: 'proj', type: 'discovery', title: 'token refresh', narrative: 'rotating auth tokens' });
    expect(cands.length).toBeGreaterThanOrEqual(1);
    expect(cands[0].title).toBe('auth token refresh');
  });
  it('respects excludeId and project/type scoping', () => {
    const all = findDedupCandidates(store.db, { project: 'proj', type: 'discovery', title: 'auth token', narrative: 'auth' });
    const exclude = findDedupCandidates(store.db, { project: 'proj', type: 'discovery', title: 'auth token', narrative: 'auth' }, { excludeId: all[0].id });
    expect(exclude.find(c => c.id === all[0].id)).toBeUndefined();
    // different type → no match
    expect(findDedupCandidates(store.db, { project: 'proj', type: 'bugfix', title: 'auth token', narrative: 'auth' })).toEqual([]);
  });
});

describe('judgeObservation (apply verdict)', () => {
  let store: SessionStore;
  let targetId: number;
  beforeEach(() => {
    store = new SessionStore(':memory:');
    new SessionSearch(store.db); // sets up observations_fts + triggers
    store.db.run(
      `INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, status, started_at, started_at_epoch)
       VALUES ('c1','s1','proj','active','2026-06-17',1750000000)`,
    );
    const r = store.storeObservation('s1', 'proj',
      { type: 'discovery', title: 'auth token refresh', subtitle: null, facts: [], narrative: 'rotates keys', concepts: [], files_read: [], files_modified: [] },
      1, 0, Date.parse('2026-06-10T12:00:00Z'));
    targetId = r.id;
  });
  afterEach(() => store.db.close());

  const newObs = { project: 'proj', type: 'discovery', title: 'token rotation', narrative: 'auth tokens rotate' };
  const shortlist = () => findDedupCandidates(store.db, newObs);

  it('empty shortlist → ADD without calling the judge', async () => {
    let called = false;
    const judge: JudgeFn = async () => { called = true; return '{}'; };
    const res = await judgeObservation(store.db, newObs, [], judge);
    expect(res.action).toBe('ADD');
    expect(called).toBe(false);
  });

  it('INCREMENT reinforces the target (adds a reinforcement date)', async () => {
    const before = JSON.parse((store.db.prepare('SELECT reinforcement_dates FROM observations WHERE id=?').get(targetId) as any).reinforcement_dates);
    const judge: JudgeFn = async () => '{"action":"INCREMENT","target":1,"rationale":"same fact"}';
    const res = await judgeObservation(store.db, newObs, shortlist(), judge, new Date('2026-06-17T12:00:00Z'));
    expect(res.action).toBe('INCREMENT');
    expect(res.targetId).toBe(targetId);
    const after = JSON.parse((store.db.prepare('SELECT reinforcement_dates FROM observations WHERE id=?').get(targetId) as any).reinforcement_dates);
    expect(after.length).toBe(before.length + 1);
    expect(after[after.length - 1]).toBe('2026-06-17');
  });

  it('FLAG_CONFLICT returns the target id without reinforcing', async () => {
    const judge: JudgeFn = async () => '{"action":"FLAG_CONFLICT","target":1,"rationale":"contradicts"}';
    const res = await judgeObservation(store.db, newObs, shortlist(), judge);
    expect(res.action).toBe('FLAG_CONFLICT');
    expect(res.targetId).toBe(targetId);
  });

  it('judge throwing → fail-open ADD', async () => {
    const judge: JudgeFn = async () => { throw new Error('llm down'); };
    const res = await judgeObservation(store.db, newObs, shortlist(), judge);
    expect(res.action).toBe('ADD');
  });
});

describe('applyDedupJudge (batch orchestrator, opt-in wiring)', () => {
  let store: SessionStore;
  beforeEach(() => {
    store = new SessionStore(':memory:');
    new SessionSearch(store.db);
    store.db.run(
      `INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, status, started_at, started_at_epoch)
       VALUES ('c1','s1','proj','active','2026-06-17',1750000000)`,
    );
    // existing memory: an auth-token note to dedup against
    store.storeObservation('s1', 'proj',
      { type: 'discovery', title: 'auth token refresh', subtitle: null, facts: [], narrative: 'rotates auth keys', concepts: [], files_read: [], files_modified: [] },
      1, 0, 1750000000000);
  });
  afterEach(() => store.db.close());

  it('drops INCREMENT duplicates and keeps ADDs', async () => {
    const { applyDedupJudge } = await import('../src/services/reinforcement/dedup-judge.js');
    const batch = [
      { type: 'discovery', title: 'token refresh again', narrative: 'auth token rotation' }, // dup → INCREMENT
      { type: 'discovery', title: 'brand new topic', narrative: 'unrelated payment webhook retries' }, // ADD
    ];
    // Fake judge: INCREMENT when candidates exist (the dup), else the orchestrator
    // never calls it (empty shortlist → ADD).
    const judge: JudgeFn = async () => '{"action":"INCREMENT","target":1,"rationale":"same"}';
    const kept = await applyDedupJudge(store.db, batch, 'proj', judge);
    expect(kept.map(o => o.title)).toEqual(['brand new topic']); // dup folded away, new one kept
  });

  it('keeps everything when the judge errors (defensive)', async () => {
    const { applyDedupJudge } = await import('../src/services/reinforcement/dedup-judge.js');
    const batch = [{ type: 'discovery', title: 'token refresh again', narrative: 'auth token rotation' }];
    const judge: JudgeFn = async () => { throw new Error('boom'); };
    const kept = await applyDedupJudge(store.db, batch, 'proj', judge);
    expect(kept.length).toBe(1);
  });
});
