import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { projectReadKeys } from '../../src/services/sqlite/project-read-keys.js';

describe('whole-project promotion counterexamples', () => {
  let store: SessionStore;
  beforeEach(() => {
    store = new SessionStore(':memory:');
    const session = store.createSDKSession('source-content', 'Source', 'request');
    store.ensureMemorySessionIdRegistered(session, 'source-memory');
    row('observations', 'Source', 'target');
    row('session_summaries', 'source', 'TARGET');
  });
  afterEach(() => store.close());

  function row(table: 'observations' | 'session_summaries', project: string, mergedInto: string | null) {
    const extra = table === 'observations' ? ", type, title" : ', request';
    const values = table === 'observations' ? ", 'discovery', 'record'" : ", 'request'";
    store.db.run(`INSERT INTO ${table} (memory_session_id, project, merged_into_project, created_at, created_at_epoch${extra})
      VALUES ('source-memory', ?, ?, '2026-01-01T00:00:00.000Z', 1767225600000${values})`, [project, mergedInto]);
  }

  for (const table of ['observations', 'session_summaries'] as const) {
    for (const destination of [null, '', 'other']) {
      it(`does not promote a source with ${table} pointing to ${JSON.stringify(destination)}`, () => {
        row(table, 'SOURCE', destination);
        expect(projectReadKeys(store.db, ['target']).sort()).toEqual(['TARGET', 'target']);
      });
    }
  }

  it('retains all source and destination spellings for a complete merge', () => {
    row('observations', 'SOURCE', 'Target');
    expect(projectReadKeys(store.db, ['target']).sort()).toEqual(['SOURCE', 'Source', 'TARGET', 'Target', 'source', 'target']);
  });

  it('accepts a source split across multiple requested destinations', () => {
    row('observations', 'SOURCE', 'second');
    row('session_summaries', 'Source', 'SECOND');
    expect(projectReadKeys(store.db, ['target', 'second']).sort())
      .toEqual(['SECOND', 'SOURCE', 'Source', 'TARGET', 'second', 'source', 'target']);
  });
});
