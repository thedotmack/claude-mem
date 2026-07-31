// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { SessionStore } from '../src/services/sqlite/SessionStore.js';
import {
  findPromptSessions, buildCandidates, sessionLinkedIds, buildGold,
} from '../scripts/memory-eval/lib/gold.js';

const DAY = 86_400_000;
const T0 = Date.parse('2026-07-20T12:00:00Z');

function makeSessions(store: SessionStore): void {
  store.db.run(
    `INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, status, started_at, started_at_epoch)
     VALUES ('c1', 's1', 'proj', 'completed', '2026-07-20', ${T0})`,
  );
  store.db.run(
    `INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, status, started_at, started_at_epoch)
     VALUES ('c2', 's2', 'proj', 'completed', '2026-07-20', ${T0})`,
  );
}

function addPrompt(store: SessionStore, sessionDbId: number, text: string, epoch: number): number {
  store.db.prepare(
    `INSERT INTO user_prompts (session_db_id, content_session_id, prompt_number, prompt_text, created_at, created_at_epoch)
     VALUES (?, 'c1', 1, ?, '2026-07-20', ?)`,
  ).run(sessionDbId, text, epoch);
  return (store.db.prepare('SELECT last_insert_rowid() AS id').get() as { id: number }).id;
}

const LONG = 'please investigate why the worker restart loop keeps spawning processes';

const obs = (title: string, narrative: string) => ({
  type: 'discovery', title, subtitle: null, facts: [], narrative,
  concepts: ['how-it-works'], files_read: [], files_modified: [],
});

describe('memory-eval gold builder (:memory:)', () => {
  let store: SessionStore;
  beforeEach(() => {
    store = new SessionStore(':memory:');
    makeSessions(store);
  });
  afterEach(() => store.db.close());

  it('findPromptSessions returns prompts whose session has observations, newest first', () => {
    addPrompt(store, 1, LONG, T0);
    addPrompt(store, 1, LONG + ' again', T0 + 1000);
    addPrompt(store, 2, 'short', T0 + 2000); // too short — excluded
    addPrompt(store, 2, LONG + ' no obs', T0 + 3000); // session without observations — excluded
    store.storeObservation('s1', 'proj', obs('a', 'a'), 1, 0, T0);

    const rows = findPromptSessions(store.db, 50);
    expect(rows.map(r => r.prompt_id)).toEqual([2, 1]);
    expect(rows[0].project).toBe('proj');
    expect(rows[0].memory_session_id).toBe('s1');
  });

  it('candidates = session-linked + same-project within ±1 day, superseded excluded', () => {
    const promptId = addPrompt(store, 1, LONG, T0);
    const inSession = store.storeObservation('s1', 'proj', obs('in-session', 'x'), 1, 0, T0 + 60_000).id;
    const inWindow = store.storeObservation('s2', 'proj', obs('in-window', 'x'), 1, 0, T0 + DAY - 1000).id;
    const outWindow = store.storeObservation('s2', 'proj', obs('out-window', 'x'), 1, 0, T0 + 2 * DAY).id;
    const superseded = store.storeObservation('s1', 'proj', obs('superseded', 'x'), 1, 0, T0 + 120_000).id;
    store.db.prepare('UPDATE observations SET superseded_by = ? WHERE id = ?').run(inSession, superseded);

    const prompt = findPromptSessions(store.db, 50).find(p => p.prompt_id === promptId)!;
    const ids = buildCandidates(store.db, prompt).map(c => c.id);
    expect(ids).toContain(inSession);
    expect(ids).toContain(inWindow);
    expect(ids).not.toContain(outWindow);
    expect(ids).not.toContain(superseded);
    // session-linked candidates come first
    expect(ids[0]).toBe(inSession);
  });

  it('buildGold without judge uses session linkage as the scoring target', async () => {
    addPrompt(store, 1, LONG, T0);
    const a = store.storeObservation('s1', 'proj', obs('a', 'a'), 1, 0, T0 + 1000).id;
    const b = store.storeObservation('s1', 'proj', obs('b', 'b'), 2, 0, T0 + 2000).id;
    store.storeObservation('s2', 'proj', obs('other', 'other'), 1, 0, T0 + 1500);

    const gold = await buildGold(store.db, { limit: 10, judge: null, dbPath: ':memory:' });
    expect(gold.judgeUsed).toBe(false);
    expect(gold.itemCount).toBe(1);
    const item = gold.items[0];
    expect(new Set(item.relevantIds)).toEqual(new Set([a, b]));
    expect(new Set(item.sessionLinkedIds)).toEqual(new Set([a, b]));
    expect(item.candidateIds.length).toBe(3);
  });

  it('buildGold with a judge uses judge-confirmed ids', async () => {
    addPrompt(store, 1, LONG, T0);
    const a = store.storeObservation('s1', 'proj', obs('a', 'a'), 1, 0, T0 + 1000).id;
    store.storeObservation('s1', 'proj', obs('b', 'b'), 2, 0, T0 + 2000);

    const fakeJudge = {
      callsSpent: 1,
      cacheHits: 0,
      async confirmRelevant() { return [a]; },
    };
    const gold = await buildGold(store.db, { limit: 10, judge: fakeJudge as never, dbPath: ':memory:' });
    expect(gold.judgeUsed).toBe(true);
    expect(gold.items[0].relevantIds).toEqual([a]);
  });

  it('sessionLinkedIds excludes superseded observations', () => {
    const a = store.storeObservation('s1', 'proj', obs('a', 'a'), 1, 0, T0).id;
    const b = store.storeObservation('s1', 'proj', obs('b', 'b'), 2, 0, T0 + 1000).id;
    store.db.prepare('UPDATE observations SET superseded_by = ? WHERE id = ?').run(b, a);
    expect(sessionLinkedIds(store.db, 's1')).toEqual([b]);
  });
});
