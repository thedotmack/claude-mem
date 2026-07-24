// Pin-down + regression tests for #3378 (second half): a legacy DB containing
// orphaned FK children (observations / session_summaries rows whose
// memory_session_id has no sdk_sessions parent — written historically while
// foreign_keys was OFF) aborts the SessionStore constructor migration chain
// with 'FOREIGN KEY constraint failed', so dbManager.initialize() rejects and
// the worker never reports ready.
//
// Faulting mechanism these tests pin: the child-table rebuild copies that run
// with foreign_keys = ON (applySqliteConnectionPragmas sets it per
// connection and these two migrations, unlike v21/v33/v34, never disable it):
//   - v7  removeSessionSummariesUniqueConstraint: INSERT INTO
//     session_summaries_new SELECT ... FROM session_summaries
//   - v9  makeObservationsTextNullable: INSERT INTO observations_new
//     SELECT ... FROM observations
// Each orphaned row makes the copy INSERT violate the freshly created FK.
//
// The fix repairs the PARENT side: minimal stub sdk_sessions rows are created
// for orphaned memory_session_ids immediately before each rebuild copy
// (mirroring SyncApply.ensureSessionForMemoryId's stub semantics). Orphaned
// child rows are live user data served by context injection and must survive.
import { describe, it, expect, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { runOneTimeV12_4_3Cleanup } from '../../src/services/infrastructure/CleanupV12_4_3.js';

const ISO = '2025-07-01T00:00:00.000Z';
const EPOCH = 1751328000000;

interface OrphanSeedOptions {
  orphanObservation?: boolean;
  orphanSummary?: boolean;
}

/**
 * Create a v4-era database file — the exact shape initializeSchema() creates
 * (schema_versions stamped at 4) — with one healthy parent+child pair and,
 * per options, orphaned child rows inserted under PRAGMA foreign_keys = OFF,
 * mimicking historical data written before/around enforcement.
 */
function seedLegacyV4DbWithOrphans(dbPath: string, opts: OrphanSeedOptions = {}): void {
  const db = new Database(dbPath);
  db.run('PRAGMA foreign_keys = OFF');

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
  db.run(`
    CREATE TABLE observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      memory_session_id TEXT NOT NULL,
      project TEXT NOT NULL,
      text TEXT NOT NULL,
      type TEXT NOT NULL,
      created_at TEXT NOT NULL,
      created_at_epoch INTEGER NOT NULL,
      FOREIGN KEY(memory_session_id) REFERENCES sdk_sessions(memory_session_id) ON DELETE CASCADE ON UPDATE CASCADE
    )
  `);
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
      created_at TEXT NOT NULL,
      created_at_epoch INTEGER NOT NULL,
      FOREIGN KEY(memory_session_id) REFERENCES sdk_sessions(memory_session_id) ON DELETE CASCADE ON UPDATE CASCADE
    )
  `);
  db.prepare('INSERT INTO schema_versions (version, applied_at) VALUES (?, ?)').run(4, ISO);

  // Healthy pair: parent session + observation.
  db.prepare(`
    INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
    VALUES ('content-healthy', 'mem-healthy', 'proj-a', ?, ?, 'completed')
  `).run(ISO, EPOCH);
  db.prepare(`
    INSERT INTO observations (memory_session_id, project, text, type, created_at, created_at_epoch)
    VALUES ('mem-healthy', 'proj-a', 'healthy text', 'discovery', ?, ?)
  `).run(ISO, EPOCH);

  if (opts.orphanObservation) {
    db.prepare(`
      INSERT INTO observations (memory_session_id, project, text, type, created_at, created_at_epoch)
      VALUES ('mem-orphan-obs', 'proj-orphan', 'orphan observation text', 'discovery', ?, ?)
    `).run(ISO, EPOCH + 1);
  }
  if (opts.orphanSummary) {
    db.prepare(`
      INSERT INTO session_summaries (memory_session_id, project, request, created_at, created_at_epoch)
      VALUES ('mem-orphan-sum', 'proj-orphan', 'orphan summary request', ?, ?)
    `).run(ISO, EPOCH + 2);
  }

  db.run('PRAGMA foreign_keys = ON');
  db.close();
}

function count(db: Database, sql: string, ...params: Array<string | number>): number {
  return (db.prepare(sql).get(...params) as { n: number }).n;
}

describe('SessionStore migration chain over a legacy DB with orphaned FK children (#3378)', () => {
  let tempDir: string;

  afterEach(() => {
    if (tempDir && existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  function makeTempDbPath(): string {
    tempDir = mkdtempSync(path.join(tmpdir(), 'claude-mem-orphan-fk-'));
    return path.join(tempDir, 'claude-mem.db');
  }

  it('v9 observations rebuild completes over an orphaned observation and repairs its parent', () => {
    const dbPath = makeTempDbPath();
    seedLegacyV4DbWithOrphans(dbPath, { orphanObservation: true });

    // Unfixed code: this constructor throws 'FOREIGN KEY constraint failed'
    // from makeObservationsTextNullable's INSERT INTO observations_new SELECT.
    const store = new SessionStore(dbPath);

    // Orphaned observation is live user data — it must survive the rebuild.
    expect(count(store.db, 'SELECT COUNT(*) AS n FROM observations')).toBe(2);
    expect(count(store.db, `SELECT COUNT(*) AS n FROM observations WHERE memory_session_id = 'mem-orphan-obs'`)).toBe(1);

    // The missing side was the parent: a minimal stub session now exists,
    // mirroring SyncApply.ensureSessionForMemoryId stub semantics.
    expect(count(store.db, `SELECT COUNT(*) AS n FROM sdk_sessions WHERE memory_session_id = 'mem-orphan-obs'`)).toBe(1);
    const stub = store.db.prepare(
      `SELECT content_session_id, project, status FROM sdk_sessions WHERE memory_session_id = 'mem-orphan-obs'`
    ).get() as { content_session_id: string; project: string; status: string };
    expect(stub.content_session_id).toBe('mem-orphan-obs');
    expect(stub.project).toBe('proj-orphan');
    expect(stub.status).toBe('completed');

    // Healthy rows untouched; the chain ran to completion (v9 recorded).
    expect(count(store.db, `SELECT COUNT(*) AS n FROM observations WHERE memory_session_id = 'mem-healthy'`)).toBe(1);
    expect(count(store.db, 'SELECT COUNT(*) AS n FROM schema_versions WHERE version = 9')).toBe(1);

    store.db.close();
  });

  it('v7 session_summaries rebuild completes over an orphaned summary and repairs its parent', () => {
    const dbPath = makeTempDbPath();
    seedLegacyV4DbWithOrphans(dbPath, { orphanSummary: true });

    // Unfixed code: this constructor throws 'FOREIGN KEY constraint failed'
    // from removeSessionSummariesUniqueConstraint's INSERT INTO
    // session_summaries_new SELECT.
    const store = new SessionStore(dbPath);

    expect(count(store.db, 'SELECT COUNT(*) AS n FROM session_summaries')).toBe(1);
    expect(count(store.db, `SELECT COUNT(*) AS n FROM session_summaries WHERE memory_session_id = 'mem-orphan-sum'`)).toBe(1);
    expect(count(store.db, `SELECT COUNT(*) AS n FROM sdk_sessions WHERE memory_session_id = 'mem-orphan-sum'`)).toBe(1);
    expect(count(store.db, 'SELECT COUNT(*) AS n FROM schema_versions WHERE version = 7')).toBe(1);

    store.db.close();
  });

  it('boot sequence over a DB with both orphan kinds: migrations then v12.4.3 cleanup, nothing lost', () => {
    const dbPath = makeTempDbPath();
    seedLegacyV4DbWithOrphans(dbPath, { orphanObservation: true, orphanSummary: true });

    const store = new SessionStore(dbPath);
    store.db.close();

    // The next awaited boot step after dbManager.initialize(): the one-time
    // v12.4.3 cleanup (DELETE FROM sdk_sessions with foreign_keys = ON).
    runOneTimeV12_4_3Cleanup(tempDir);
    expect(existsSync(path.join(tempDir, '.cleanup-v12.4.3-applied'))).toBe(true);

    const db = new Database(dbPath, { readonly: true });
    try {
      // COUNT assertions on both tables: orphans survive, stub parents present.
      expect(count(db, 'SELECT COUNT(*) AS n FROM observations')).toBe(2);
      expect(count(db, 'SELECT COUNT(*) AS n FROM session_summaries')).toBe(1);
      expect(count(db, `SELECT COUNT(*) AS n FROM sdk_sessions WHERE memory_session_id IN ('mem-orphan-obs', 'mem-orphan-sum')`)).toBe(2);
      expect(count(db, `SELECT COUNT(*) AS n FROM sdk_sessions WHERE memory_session_id = 'mem-healthy'`)).toBe(1);
    } finally {
      db.close();
    }
  });

  it('repair is idempotent: reconstructing over the repaired DB is a no-op', () => {
    const dbPath = makeTempDbPath();
    seedLegacyV4DbWithOrphans(dbPath, { orphanObservation: true, orphanSummary: true });

    const first = new SessionStore(dbPath);
    const sessionsAfterFirst = count(first.db, 'SELECT COUNT(*) AS n FROM sdk_sessions');
    first.db.close();

    const second = new SessionStore(dbPath);
    expect(count(second.db, 'SELECT COUNT(*) AS n FROM sdk_sessions')).toBe(sessionsAfterFirst);
    expect(count(second.db, 'SELECT COUNT(*) AS n FROM observations')).toBe(2);
    expect(count(second.db, 'SELECT COUNT(*) AS n FROM session_summaries')).toBe(1);
    second.db.close();
  });
});
