// Regression tests for #3849: two DDL paths disagreed on the
// session_summaries.memory_session_id FK. addOnUpdateCascadeToForeignKeys
// (v21) is version-row gated and runs once; removeSessionSummariesUniqueConstraint
// (v7) is introspection-gated and can fire later, recreating the table with
// ON DELETE CASCADE only. Parent-key rewrites in ensureMemorySessionIdRegistered
// then throw FOREIGN KEY constraint failed for any session that already has a
// summary. The same class of defect as #3890, on the FK clause rather than the
// column list.
import { describe, it, expect, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';

const ISO = '2025-07-01T00:00:00.000Z';
const EPOCH = 1751328000000;

function createBaseTables(db: Database, observationsOnUpdate: 'CASCADE' | 'NO ACTION' = 'CASCADE'): void {
  db.run(`
    CREATE TABLE schema_versions (
      id INTEGER PRIMARY KEY,
      version INTEGER UNIQUE NOT NULL,
      applied_at TEXT NOT NULL
    )
  `);
  db.run(`
    CREATE TABLE sdk_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content_session_id TEXT NOT NULL,
      memory_session_id TEXT UNIQUE,
      project TEXT NOT NULL,
      platform_source TEXT NOT NULL DEFAULT 'claude',
      user_prompt TEXT,
      started_at TEXT NOT NULL,
      started_at_epoch INTEGER NOT NULL,
      completed_at TEXT,
      completed_at_epoch INTEGER,
      status TEXT CHECK(status IN ('active', 'completed', 'failed')) NOT NULL DEFAULT 'active'
    )
  `);
  const observationsUpdate = observationsOnUpdate === 'CASCADE' ? ' ON UPDATE CASCADE' : '';
  db.run(`
    CREATE TABLE observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      memory_session_id TEXT NOT NULL,
      project TEXT NOT NULL,
      text TEXT,
      type TEXT NOT NULL,
      discovery_tokens INTEGER DEFAULT 0,
      created_at TEXT NOT NULL,
      created_at_epoch INTEGER NOT NULL,
      FOREIGN KEY(memory_session_id) REFERENCES sdk_sessions(memory_session_id) ON DELETE CASCADE${observationsUpdate}
    )
  `);
  db.prepare(`
    INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
    VALUES ('content-healthy', 'mem-healthy', 'proj-a', ?, ?, 'completed')
  `).run(ISO, EPOCH);
}

/**
 * The terminal v21 → v7 order: UNIQUE constraint still present (so v7 will
 * rebuild) but version 21 is already stamped (so a version-row-gated v21
 * would refuse to repair whatever the rebuild leaves behind).
 */
function seedDbWithUniqueConstraintAfterV21(dbPath: string): void {
  const db = new Database(dbPath);
  db.run('PRAGMA foreign_keys = OFF');
  createBaseTables(db);
  db.run(`
    CREATE TABLE session_summaries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      memory_session_id TEXT UNIQUE NOT NULL,
      project TEXT NOT NULL,
      request TEXT,
      investigated TEXT,
      learned TEXT,
      completed TEXT,
      next_steps TEXT,
      files_read TEXT,
      files_edited TEXT,
      notes TEXT,
      discovery_tokens INTEGER DEFAULT 0,
      merged_into_project TEXT,
      created_at TEXT NOT NULL,
      created_at_epoch INTEGER NOT NULL,
      FOREIGN KEY(memory_session_id) REFERENCES sdk_sessions(memory_session_id) ON DELETE CASCADE ON UPDATE CASCADE
    )
  `);
  for (const version of [4, 11, 21]) {
    db.prepare('INSERT INTO schema_versions (version, applied_at) VALUES (?, ?)').run(version, ISO);
  }
  db.prepare(`
    INSERT INTO session_summaries
      (memory_session_id, project, request, discovery_tokens, merged_into_project, created_at, created_at_epoch)
    VALUES ('mem-healthy', 'proj-a', 'first summary', 42, 'keep-merged', ?, ?)
  `).run(ISO, EPOCH);
  db.run('PRAGMA foreign_keys = ON');
  db.close();
}

/**
 * A database the old v7 rebuild already ran on after v21: no UNIQUE, version
 * 21 stamped, session_summaries FK is ON DELETE CASCADE only. Later columns
 * and values must survive the repair.
 */
function seedDbThatAlreadyLostCascade(dbPath: string): void {
  const db = new Database(dbPath);
  db.run('PRAGMA foreign_keys = OFF');
  createBaseTables(db);
  db.run(`
    CREATE TABLE session_summaries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      memory_session_id TEXT NOT NULL,
      project TEXT NOT NULL,
      request TEXT,
      investigated TEXT,
      learned TEXT,
      completed TEXT,
      next_steps TEXT,
      files_read TEXT,
      files_edited TEXT,
      notes TEXT,
      prompt_number INTEGER,
      discovery_tokens INTEGER DEFAULT 0,
      merged_into_project TEXT,
      synced_at INTEGER,
      origin_device_id TEXT,
      origin_local_id TEXT,
      sync_rev TEXT NOT NULL DEFAULT '1',
      created_at TEXT NOT NULL,
      created_at_epoch INTEGER NOT NULL,
      FOREIGN KEY(memory_session_id) REFERENCES sdk_sessions(memory_session_id) ON DELETE CASCADE
    )
  `);
  for (const version of [4, 7, 11, 21]) {
    db.prepare('INSERT INTO schema_versions (version, applied_at) VALUES (?, ?)').run(version, ISO);
  }
  db.prepare(`
    INSERT INTO session_summaries
      (memory_session_id, project, request, discovery_tokens, merged_into_project, synced_at,
       origin_device_id, origin_local_id, sync_rev, created_at, created_at_epoch)
    VALUES ('mem-healthy', 'proj-a', 'already summarised', 7, 'keep-merged', 99,
            'dev-1', 'local-9', '5', ?, ?)
  `).run(ISO, EPOCH);
  db.prepare(`
    INSERT INTO observations (memory_session_id, project, text, type, created_at, created_at_epoch)
    VALUES ('mem-healthy', 'proj-a', 'healthy text', 'discovery', ?, ?)
  `).run(ISO, EPOCH);
  db.run('PRAGMA foreign_keys = ON');
  db.close();
}

function seedDbThatLostObservationsCascade(dbPath: string): void {
  const db = new Database(dbPath);
  db.run('PRAGMA foreign_keys = OFF');
  createBaseTables(db, 'NO ACTION');
  db.run(`
    CREATE TABLE session_summaries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      memory_session_id TEXT NOT NULL,
      project TEXT NOT NULL,
      request TEXT,
      created_at TEXT NOT NULL,
      created_at_epoch INTEGER NOT NULL,
      FOREIGN KEY(memory_session_id) REFERENCES sdk_sessions(memory_session_id) ON DELETE CASCADE ON UPDATE CASCADE
    )
  `);
  for (const version of [4, 7, 9, 11, 21]) {
    db.prepare('INSERT INTO schema_versions (version, applied_at) VALUES (?, ?)').run(version, ISO);
  }
  db.prepare(`
    INSERT INTO observations (memory_session_id, project, text, type, created_at, created_at_epoch)
    VALUES ('mem-healthy', 'proj-a', 'obs that should cascade', 'discovery', ?, ?)
  `).run(ISO, EPOCH);
  db.run('PRAGMA foreign_keys = ON');
  db.close();
}

function memorySessionFk(db: Database, table: 'observations' | 'session_summaries'): { on_update: string; on_delete: string } | undefined {
  const fks = db.query(`PRAGMA foreign_key_list(${table})`).all() as Array<{
    table: string;
    from: string;
    on_update: string;
    on_delete: string;
  }>;
  return fks.find(fk => fk.table === 'sdk_sessions' && fk.from === 'memory_session_id');
}

function hasTableLevelUniqueConstraint(db: Database): boolean {
  const indexes = db.query('PRAGMA index_list(session_summaries)').all() as Array<{ unique: number; origin: string }>;
  return indexes.some(idx => idx.unique === 1 && idx.origin === 'u');
}

describe('session_summaries ON UPDATE CASCADE survives v7 rebuild (#3849)', () => {
  let tempDir: string;

  afterEach(() => {
    if (tempDir && existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  function makeTempDbPath(): string {
    tempDir = mkdtempSync(path.join(tmpdir(), 'claude-mem-v7-cascade-'));
    return path.join(tempDir, 'claude-mem.db');
  }

  it('v7 rebuild after v21 is already stamped still leaves ON UPDATE CASCADE', () => {
    const dbPath = makeTempDbPath();
    seedDbWithUniqueConstraintAfterV21(dbPath);

    const store = new SessionStore(dbPath);

    expect(hasTableLevelUniqueConstraint(store.db)).toBe(false);
    const summaryFk = memorySessionFk(store.db, 'session_summaries');
    expect(summaryFk?.on_update).toBe('CASCADE');
    expect(summaryFk?.on_delete).toBe('CASCADE');

    const carried = store.db.prepare(
      `SELECT discovery_tokens, merged_into_project FROM session_summaries WHERE request = 'first summary'`
    ).get() as { discovery_tokens: number; merged_into_project: string };
    expect(carried.discovery_tokens).toBe(42);
    expect(carried.merged_into_project).toBe('keep-merged');

    const session = store.db.prepare(
      `SELECT id FROM sdk_sessions WHERE memory_session_id = 'mem-healthy'`
    ).get() as { id: number };
    store.ensureMemorySessionIdRegistered(session.id, 'mem-rotated');

    expect(store.db.prepare(
      `SELECT memory_session_id FROM sdk_sessions WHERE id = ?`
    ).get(session.id)).toEqual({ memory_session_id: 'mem-rotated' });
    expect(store.db.prepare(
      `SELECT memory_session_id FROM session_summaries WHERE request = 'first summary'`
    ).get()).toEqual({ memory_session_id: 'mem-rotated' });

    store.db.close();
  });

  it('repairs a database that already lost CASCADE even though version 21 is stamped', () => {
    const dbPath = makeTempDbPath();
    seedDbThatAlreadyLostCascade(dbPath);

    const store = new SessionStore(dbPath);

    const summaryFk = memorySessionFk(store.db, 'session_summaries');
    expect(summaryFk?.on_update).toBe('CASCADE');
    expect(summaryFk?.on_delete).toBe('CASCADE');
    const observationFk = memorySessionFk(store.db, 'observations');
    expect(observationFk?.on_update).toBe('CASCADE');

    const carried = store.db.prepare(`
      SELECT discovery_tokens, merged_into_project, synced_at, origin_device_id, origin_local_id, sync_rev
      FROM session_summaries WHERE request = 'already summarised'
    `).get() as {
      discovery_tokens: number;
      merged_into_project: string;
      synced_at: number;
      origin_device_id: string;
      origin_local_id: string;
      sync_rev: string;
    };
    expect(carried.discovery_tokens).toBe(7);
    expect(carried.merged_into_project).toBe('keep-merged');
    expect(carried.synced_at).toBe(99);
    expect(carried.origin_device_id).toBe('dev-1');
    expect(carried.origin_local_id).toBe('local-9');
    expect(carried.sync_rev).toBe('5');

    const session = store.db.prepare(
      `SELECT id FROM sdk_sessions WHERE memory_session_id = 'mem-healthy'`
    ).get() as { id: number };
    expect(() => store.ensureMemorySessionIdRegistered(session.id, 'mem-rotated')).not.toThrow();
    expect(store.db.prepare(
      `SELECT memory_session_id FROM session_summaries WHERE request = 'already summarised'`
    ).get()).toEqual({ memory_session_id: 'mem-rotated' });
    expect(store.db.prepare(
      `SELECT memory_session_id FROM observations WHERE text = 'healthy text'`
    ).get()).toEqual({ memory_session_id: 'mem-rotated' });

    store.db.close();
  });

  it('repairs observations that lost ON UPDATE CASCADE after v21 was stamped', () => {
    const dbPath = makeTempDbPath();
    seedDbThatLostObservationsCascade(dbPath);

    const store = new SessionStore(dbPath);

    const observationFk = memorySessionFk(store.db, 'observations');
    expect(observationFk?.on_update).toBe('CASCADE');
    expect(observationFk?.on_delete).toBe('CASCADE');

    const session = store.db.prepare(
      `SELECT id FROM sdk_sessions WHERE memory_session_id = 'mem-healthy'`
    ).get() as { id: number };
    store.ensureMemorySessionIdRegistered(session.id, 'mem-rotated');
    expect(store.db.prepare(
      `SELECT memory_session_id FROM observations WHERE text = 'obs that should cascade'`
    ).get()).toEqual({ memory_session_id: 'mem-rotated' });

    store.db.close();
  });

  it('repair is a no-op on a second boot of an already-repaired database', () => {
    const dbPath = makeTempDbPath();
    seedDbThatAlreadyLostCascade(dbPath);

    const first = new SessionStore(dbPath);
    const session = first.db.prepare(
      `SELECT id FROM sdk_sessions WHERE memory_session_id = 'mem-healthy'`
    ).get() as { id: number };
    first.ensureMemorySessionIdRegistered(session.id, 'mem-rotated');
    first.db.close();

    const second = new SessionStore(dbPath);
    expect(memorySessionFk(second.db, 'session_summaries')?.on_update).toBe('CASCADE');
    expect(second.db.prepare(
      `SELECT COUNT(*) AS n FROM session_summaries WHERE memory_session_id = 'mem-rotated'`
    ).get()).toEqual({ n: 1 });
    expect(() => second.ensureMemorySessionIdRegistered(session.id, 'mem-rotated-again')).not.toThrow();
    expect(second.db.prepare(
      `SELECT memory_session_id FROM session_summaries WHERE request = 'already summarised'`
    ).get()).toEqual({ memory_session_id: 'mem-rotated-again' });
    second.db.close();
  });
});
