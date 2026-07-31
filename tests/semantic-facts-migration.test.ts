// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { SessionStore } from '../src/services/sqlite/SessionStore.js';

interface ColumnInfo {
  name: string;
}

function factColumns(db: Database): Set<string> {
  const cols = db.query('PRAGMA table_info(semantic_facts)').all() as ColumnInfo[];
  return new Set(cols.map(c => c.name));
}

describe('Semantic memory layer — schema v53 migration', () => {
  let store: SessionStore;

  beforeEach(() => {
    store = new SessionStore(':memory:');
  });

  afterEach(() => {
    store.db.close();
  });

  it('creates the semantic_facts table with all spec columns', () => {
    const cols = factColumns(store.db);
    for (const col of [
      'id', 'project', 'kind', 'fact', 'source_observation_ids',
      'reinforcement_dates', 'last_reinforced', 'relevance_count',
      'superseded_by', 'invalidated_at', 'valid_from', 'valid_to',
      'content_hash', 'created_at', 'created_at_epoch', 'updated_at_epoch',
    ]) {
      expect(cols.has(col)).toBe(true);
    }
  });

  it('creates the per-project consolidation state table', () => {
    const cols = (store.db.query('PRAGMA table_info(semantic_consolidation_state)').all() as ColumnInfo[]).map(c => c.name);
    expect(cols).toEqual(['project', 'last_run_at_epoch', 'last_observation_id']);
  });

  it('enforces UNIQUE(project, content_hash)', () => {
    const indexes = store.db.query("PRAGMA index_list('semantic_facts')").all() as Array<{ name: string; unique: number }>;
    const unique = indexes.find(i => i.unique === 1 && i.name === 'idx_semantic_facts_project_content_hash');
    expect(unique).toBeDefined();
    const indexCols = (store.db.query(`PRAGMA index_info('${unique!.name}')`).all() as ColumnInfo[]).map(c => c.name);
    expect(indexCols).toEqual(['project', 'content_hash']);
  });

  it('records schema version 53', () => {
    const row = store.db
      .prepare('SELECT version FROM schema_versions WHERE version = ?')
      .get(53) as { version: number } | undefined;
    expect(row?.version).toBe(53);
  });

  it('is idempotent — re-opening the same db does not error or duplicate', () => {
    const db = store.db;
    expect(() => new SessionStore(db)).not.toThrow();
    const versions = db
      .prepare('SELECT COUNT(*) as n FROM schema_versions WHERE version = ?')
      .get(53) as { n: number };
    expect(versions.n).toBe(1);
  });
});
