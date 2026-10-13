import { expect, it } from 'bun:test';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
function seed() {
  const s = new SessionStore(':memory:');
  const id = s.createSDKSession('content', 'app', 'prompt');
  s.updateMemorySessionId(id, 'memory');
  return s;
}
const summary = {
  memory_session_id: 'memory',
  project: 'app',
  request: null,
  investigated: null,
  learned: null,
  completed: null,
  next_steps: null,
  files_read: null,
  files_edited: null,
  notes: 'first notes',
  prompt_number: 1,
  discovery_tokens: 0,
  created_at: new Date(1000).toISOString(),
  created_at_epoch: 1000,
};
it('imports every summary in a session and skips exact replay', () => {
  const s = seed();
  try {
    const first = s.importSessionSummary(summary);
    const next = {
      ...summary,
      notes: 'latest notes',
      prompt_number: 2,
      created_at: new Date(2000).toISOString(),
      created_at_epoch: 2000,
    };
    const second = s.importSessionSummary(next);
    expect(second.imported).toBe(true);
    expect(second.id).not.toBe(first.id);
    expect(s.getSummaryForSession('memory')?.notes).toBe('latest notes');
    expect(s.importSessionSummary(summary)).toEqual({ imported: false, id: first.id });
    expect(s.importSessionSummary(next)).toEqual({ imported: false, id: second.id });
    expect(s.db.query('SELECT count(*) AS n FROM session_summaries').get()).toEqual({ n: 2 });
    const sameEpoch = { ...next, request: 'a distinct request at the same timestamp' };
    const third = s.importSessionSummary(sameEpoch);
    expect(third.imported).toBe(true);
    expect(s.importSessionSummary(sameEpoch)).toEqual({ imported: false, id: third.id });
    expect(s.db.query('SELECT count(*) AS n FROM session_summaries').get()).toEqual({ n: 3 });
  } finally {
    s.close();
  }
});
it('deduplicates imported legacy observations with nullable titles', () => {
  const s = seed();
  try {
    const row = {
      ...summary,
      text: null,
      type: 'discovery',
      title: null,
      subtitle: null,
      facts: null,
      narrative: 'legacy observation',
      concepts: null,
      files_modified: null,
    };
    const first = s.importObservation(row);
    expect(s.importObservation(row)).toEqual({ imported: false, id: first.id });
    expect(s.importObservation({ ...row, created_at_epoch: 2000 })).toMatchObject({
      imported: true,
    });
  } finally {
    s.close();
  }
});

it('retains distinct summary content at the same request and timestamp', () => {
  const s = seed();
  try {
    const first = s.importSessionSummary(summary);
    const secondRow = { ...summary, notes: 'different notes', prompt_number: 2 };
    const second = s.importSessionSummary(secondRow);
    expect(second.imported).toBe(true);
    expect(second.id).not.toBe(first.id);
    expect(s.importSessionSummary(secondRow)).toEqual({ imported: false, id: second.id });
    expect(s.getSummaryForSession('memory')?.notes).toBe('different notes');
  } finally {
    s.close();
  }
});
it('retains distinct nullable-title observation content at the same timestamp', () => {
  const s = seed();
  try {
    const row = {
      ...summary,
      text: null,
      type: 'discovery',
      title: null,
      subtitle: null,
      facts: null,
      narrative: 'first',
      concepts: null,
      files_modified: null,
    };
    const first = s.importObservation(row);
    const changed = { ...row, type: 'decision', narrative: 'second', agent_id: 'agent-two' };
    const second = s.importObservation(changed);
    expect(second.imported).toBe(true);
    expect(second.id).not.toBe(first.id);
    expect(s.importObservation(changed)).toEqual({ imported: false, id: second.id });
    expect(s.importObservation(row)).toEqual({ imported: false, id: first.id });
  } finally {
    s.close();
  }
});

it('recognizes a replay after project and discovery_tokens change on the stored rows', () => {
  const s = seed();
  try {
    const row = {
      ...summary,
      text: null,
      type: 'discovery',
      title: null,
      subtitle: null,
      facts: null,
      narrative: 'stored before the rewrite',
      concepts: null,
      files_modified: null,
    };
    const firstSummary = s.importSessionSummary(summary);
    const firstObservation = s.importObservation(row);

    // Both columns change after a row exists, so an export taken earlier still
    // carries the old values. A turn's real token cost is filled in later...
    s.updateDiscoveryTokens([firstObservation.id], firstSummary.id, 1234);
    expect(s.importSessionSummary(summary)).toEqual({ imported: false, id: firstSummary.id });
    expect(s.importObservation(row)).toEqual({ imported: false, id: firstObservation.id });

    // ...and the cwd remap moves a session's rows to another project.
    for (const table of ['sdk_sessions', 'observations', 'session_summaries']) {
      s.db.prepare(`UPDATE ${table} SET project = ? WHERE memory_session_id = ?`).run('renamed', 'memory');
    }
    expect(s.importSessionSummary(summary)).toEqual({ imported: false, id: firstSummary.id });
    expect(s.importObservation(row)).toEqual({ imported: false, id: firstObservation.id });

    expect(s.db.query('SELECT count(*) AS n FROM session_summaries').get()).toEqual({ n: 1 });
    expect(s.db.query('SELECT count(*) AS n FROM observations').get()).toEqual({ n: 1 });
  } finally {
    s.close();
  }
});
