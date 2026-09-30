import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { SessionSearch } from '../../../src/services/sqlite/SessionSearch.js';

// Schema v53 (plan-21, #2793): FTS5 external-content indexes only grow when a row's indexed
// text is written. total_changes() counts rows written by trigger programs too, so an update
// that leaves the index alone changes exactly one row.
function totalChanges(db: Database): number {
  return (db.query('SELECT total_changes() AS changes').get() as { changes: number }).changes;
}

function schemaObjectSql(db: Database, name: string): string | undefined {
  const row = db.query('SELECT sql FROM sqlite_master WHERE name = ?').get(name) as { sql: string } | null;
  return row?.sql;
}

function userPromptsFtsObjects(db: Database): string[] {
  return (db.query(`
    SELECT name FROM sqlite_master
    WHERE name IN ('user_prompts_fts', 'user_prompts_ai', 'user_prompts_ad', 'user_prompts_au')
  `).all() as { name: string }[]).map(row => row.name);
}

describe('FTS sync triggers (schema v53)', () => {
  let db: Database;
  let store: SessionStore;
  let search: SessionSearch;
  let sdkSessionId: number;
  let observationId: number;
  let summaryId: number;

  beforeEach(() => {
    db = new Database(':memory:');
    store = new SessionStore(db);
    search = new SessionSearch(db);
    sdkSessionId = store.createSDKSession('fts-content', 'fts-project', 'first prompt');
    store.ensureMemorySessionIdRegistered(sdkSessionId, 'fts-mem');
    observationId = store.storeObservation('fts-mem', 'fts-project', {
      type: 'discovery',
      title: 'original searchable title',
      subtitle: null,
      facts: [],
      narrative: 'narrative text',
      concepts: [],
      files_read: [],
      files_modified: [],
    }, 1).id;
    summaryId = store.storeSummary('fts-mem', 'fts-project', {
      request: 'original summary request',
      investigated: '',
      learned: '',
      completed: '',
      next_steps: '',
      notes: null,
    }, 1, 0).id;
  });

  afterEach(() => {
    db.close();
  });

  it('leaves the observation index alone when a non-indexed column is updated', () => {
    const before = totalChanges(db);
    db.run(`UPDATE observations SET merged_into_project = 'other-project' WHERE id = ?`, [observationId]);
    expect(totalChanges(db) - before).toBe(1);
  });

  it('leaves the summary index alone when a non-indexed column is updated', () => {
    const before = totalChanges(db);
    db.run('UPDATE session_summaries SET discovery_tokens = 42 WHERE id = ?', [summaryId]);
    expect(totalChanges(db) - before).toBe(1);
  });

  it('still re-indexes a row when an indexed column changes', () => {
    db.run(`UPDATE observations SET title = 'renamed heading' WHERE id = ?`, [observationId]);
    db.run(`UPDATE session_summaries SET request = 'reworded summary' WHERE id = ?`, [summaryId]);

    expect(search.searchObservations('renamed heading', { project: 'fts-project' }).map(o => o.id)).toEqual([observationId]);
    expect(search.searchObservations('original searchable', { project: 'fts-project' })).toEqual([]);
    expect(search.searchSessions('reworded summary', { project: 'fts-project' }).map(s => s.id)).toEqual([summaryId]);
  });

  it('creates no prompt FTS index, and prompt search still finds prompts by substring', () => {
    expect(userPromptsFtsObjects(db)).toEqual([]);
    store.saveUserPrompt('fts-content', 2, 'find this prompt later', sdkSessionId);
    expect(search.searchUserPrompts('this prompt', {})).toHaveLength(1);
  });

  it('migrates a pre-v53 database: re-scopes the update triggers and drops user_prompts_fts', () => {
    // Recreate the pre-v53 shape: unscoped update triggers plus the write-only prompt index.
    db.run('DROP TRIGGER observations_au');
    db.run(`
      CREATE TRIGGER observations_au AFTER UPDATE ON observations BEGIN
        INSERT INTO observations_fts(observations_fts, rowid, title, subtitle, narrative, text, facts, concepts)
        VALUES('delete', old.id, old.title, old.subtitle, old.narrative, old.text, old.facts, old.concepts);
        INSERT INTO observations_fts(rowid, title, subtitle, narrative, text, facts, concepts)
        VALUES (new.id, new.title, new.subtitle, new.narrative, new.text, new.facts, new.concepts);
      END;
    `);
    db.run('DROP TRIGGER session_summaries_au');
    db.run(`
      CREATE TRIGGER session_summaries_au AFTER UPDATE ON session_summaries BEGIN
        INSERT INTO session_summaries_fts(session_summaries_fts, rowid, request, investigated, learned, completed, next_steps, notes)
        VALUES('delete', old.id, old.request, old.investigated, old.learned, old.completed, old.next_steps, old.notes);
        INSERT INTO session_summaries_fts(rowid, request, investigated, learned, completed, next_steps, notes)
        VALUES (new.id, new.request, new.investigated, new.learned, new.completed, new.next_steps, new.notes);
      END;
    `);
    db.run(`CREATE VIRTUAL TABLE user_prompts_fts USING fts5(prompt_text, content='user_prompts', content_rowid='id')`);
    db.run(`
      CREATE TRIGGER user_prompts_ai AFTER INSERT ON user_prompts BEGIN
        INSERT INTO user_prompts_fts(rowid, prompt_text) VALUES (new.id, new.prompt_text);
      END;
    `);
    db.run('DELETE FROM schema_versions WHERE version = 53');

    const legacyBefore = totalChanges(db);
    db.run(`UPDATE observations SET merged_into_project = 'legacy-project' WHERE id = ?`, [observationId]);
    expect(totalChanges(db) - legacyBefore).toBeGreaterThan(1);

    new SessionStore(db);

    expect(schemaObjectSql(db, 'observations_au')).toContain('UPDATE OF');
    expect(schemaObjectSql(db, 'session_summaries_au')).toContain('UPDATE OF');
    expect(userPromptsFtsObjects(db)).toEqual([]);
    expect(db.query('SELECT version FROM schema_versions WHERE version = 53').get()).not.toBeNull();

    const before = totalChanges(db);
    db.run(`UPDATE observations SET merged_into_project = 'migrated-project' WHERE id = ?`, [observationId]);
    expect(totalChanges(db) - before).toBe(1);
    store.saveUserPrompt('fts-content', 3, 'prompt after migration', sdkSessionId);
    expect(search.searchUserPrompts('after migration', {})).toHaveLength(1);
  });
});
