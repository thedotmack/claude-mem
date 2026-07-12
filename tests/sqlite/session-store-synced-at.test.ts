import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';

const SYNCED_TABLES = ['observations', 'session_summaries', 'user_prompts'] as const;

function columnNames(db: Database, table: string): Set<string> {
  return new Set((db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(col => col.name));
}

function syncedAtById(db: Database, table: string): Map<number, number | null> {
  const rows = db.prepare(`SELECT id, synced_at FROM ${table} ORDER BY id`).all() as Array<{ id: number; synced_at: number | null }>;
  return new Map(rows.map(row => [row.id, row.synced_at]));
}

function stampedCount(db: Database, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE synced_at IS NOT NULL`).get() as { n: number }).n;
}

function seedRows(db: Database): void {
  const now = new Date().toISOString();
  const epoch = Date.now();

  db.prepare(`
    INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
    VALUES (?, ?, ?, ?, ?, 'active')
  `).run('content-sync', 'memory-sync', 'sync-project', now, epoch);

  const insertObs = db.prepare(`
    INSERT INTO observations (memory_session_id, project, type, content_hash, created_at, created_at_epoch)
    VALUES ('memory-sync', 'sync-project', 'discovery', ?, ?, ?)
  `);
  for (let i = 0; i < 5; i++) insertObs.run(`hash-${i}`, now, epoch + i);

  const insertSummary = db.prepare(`
    INSERT INTO session_summaries (memory_session_id, project, request, created_at, created_at_epoch)
    VALUES ('memory-sync', 'sync-project', 'request', ?, ?)
  `);
  for (let i = 0; i < 3; i++) insertSummary.run(now, epoch + i);

  const insertPrompt = db.prepare(`
    INSERT INTO user_prompts (content_session_id, prompt_number, prompt_text, created_at, created_at_epoch)
    VALUES ('content-sync', ?, 'prompt', ?, ?)
  `);
  for (let i = 0; i < 4; i++) insertPrompt.run(i + 1, now, epoch + i);
}

/**
 * A modern (v35-era) schema WITHOUT synced_at columns, seeded by hand so the
 * migration's column adoption and legacy stamping can be exercised against
 * pre-existing rows. `throughVersion: 38` reproduces the community-edge
 * collision: schema_versions rows 36-38 exist while synced_at does not.
 */
function seedPreSyncedAtDb(db: Database, throughVersion: number): void {
  const now = new Date().toISOString();
  const epoch = Date.now();

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
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'completed', 'failed')),
      worker_port INTEGER,
      prompt_counter INTEGER DEFAULT 0,
      custom_title TEXT
    )
  `);
  db.run('CREATE UNIQUE INDEX ux_sdk_sessions_platform_content ON sdk_sessions(platform_source, content_session_id)');

  db.run(`
    CREATE TABLE observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      memory_session_id TEXT NOT NULL,
      project TEXT NOT NULL,
      text TEXT,
      type TEXT NOT NULL,
      title TEXT,
      subtitle TEXT,
      facts TEXT,
      narrative TEXT,
      concepts TEXT,
      files_read TEXT,
      files_modified TEXT,
      prompt_number INTEGER,
      discovery_tokens INTEGER DEFAULT 0,
      content_hash TEXT,
      agent_type TEXT,
      agent_id TEXT,
      merged_into_project TEXT,
      generated_by_model TEXT,
      metadata TEXT,
      created_at TEXT NOT NULL,
      created_at_epoch INTEGER NOT NULL,
      FOREIGN KEY(memory_session_id) REFERENCES sdk_sessions(memory_session_id) ON DELETE CASCADE ON UPDATE CASCADE
    )
  `);
  db.run('CREATE UNIQUE INDEX ux_observations_session_hash ON observations(memory_session_id, content_hash)');

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
      created_at TEXT NOT NULL,
      created_at_epoch INTEGER NOT NULL,
      FOREIGN KEY(memory_session_id) REFERENCES sdk_sessions(memory_session_id) ON DELETE CASCADE ON UPDATE CASCADE
    )
  `);

  db.run(`
    CREATE TABLE user_prompts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_db_id INTEGER,
      content_session_id TEXT NOT NULL,
      prompt_number INTEGER NOT NULL,
      prompt_text TEXT NOT NULL,
      created_at TEXT NOT NULL,
      created_at_epoch INTEGER NOT NULL,
      FOREIGN KEY(session_db_id) REFERENCES sdk_sessions(id) ON DELETE CASCADE
    )
  `);

  db.run(`
    CREATE TABLE pending_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_db_id INTEGER NOT NULL,
      content_session_id TEXT NOT NULL,
      tool_use_id TEXT,
      message_type TEXT NOT NULL CHECK(message_type IN ('observation', 'summarize')),
      tool_name TEXT,
      tool_input TEXT,
      tool_response TEXT,
      cwd TEXT,
      last_user_message TEXT,
      last_assistant_message TEXT,
      prompt_number INTEGER,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'processing')),
      created_at_epoch INTEGER NOT NULL,
      agent_type TEXT,
      agent_id TEXT,
      FOREIGN KEY (session_db_id) REFERENCES sdk_sessions(id) ON DELETE CASCADE
    )
  `);
  db.run(`
    CREATE UNIQUE INDEX ux_pending_session_tool
    ON pending_messages(session_db_id, tool_use_id)
    WHERE tool_use_id IS NOT NULL
  `);

  const insertVersion = db.prepare('INSERT INTO schema_versions (version, applied_at) VALUES (?, ?)');
  for (let version = 4; version <= throughVersion; version++) insertVersion.run(version, now);

  db.prepare(`
    INSERT INTO sdk_sessions (id, content_session_id, memory_session_id, project, started_at, started_at_epoch)
    VALUES (1, 'content-sync', 'memory-sync', 'sync-project', ?, ?)
  `).run(now, epoch);

  const insertObs = db.prepare(`
    INSERT INTO observations (memory_session_id, project, type, content_hash, created_at, created_at_epoch)
    VALUES ('memory-sync', 'sync-project', 'discovery', ?, ?, ?)
  `);
  for (let i = 0; i < 5; i++) insertObs.run(`hash-${i}`, now, epoch + i);

  const insertSummary = db.prepare(`
    INSERT INTO session_summaries (memory_session_id, project, request, created_at, created_at_epoch)
    VALUES ('memory-sync', 'sync-project', 'request', ?, ?)
  `);
  for (let i = 0; i < 3; i++) insertSummary.run(now, epoch + i);

  const insertPrompt = db.prepare(`
    INSERT INTO user_prompts (session_db_id, content_session_id, prompt_number, prompt_text, created_at, created_at_epoch)
    VALUES (1, 'content-sync', ?, 'prompt', ?, ?)
  `);
  for (let i = 0; i < 4; i++) insertPrompt.run(i + 1, now, epoch + i);
}

function expectStampedThroughCursors(db: Database, before: number): void {
  const observations = syncedAtById(db, 'observations');
  expect(observations.get(1)).toBeGreaterThanOrEqual(before);
  expect(observations.get(2)).toBeGreaterThanOrEqual(before);
  expect(observations.get(3)).toBeGreaterThanOrEqual(before);
  expect(observations.get(4)).toBeNull();
  expect(observations.get(5)).toBeNull();

  const summaries = syncedAtById(db, 'session_summaries');
  expect(summaries.get(1)).toBeGreaterThanOrEqual(before);
  expect(summaries.get(2)).toBeGreaterThanOrEqual(before);
  expect(summaries.get(3)).toBeNull();

  // Prompts end up NULL regardless of the legacy cursor: the v40 repair
  // migration re-nulls every prompt's synced_at right after v39 stamps them,
  // because the legacy client uploaded prompts with the broken
  // memory_session_id/project mapping and they must re-push through the
  // fixed mapper.
  const prompts = syncedAtById(db, 'user_prompts');
  expect(prompts.get(1)).toBeNull();
  expect(prompts.get(2)).toBeNull();
  expect(prompts.get(3)).toBeNull();
  expect(prompts.get(4)).toBeNull();
}

describe('SessionStore synced_at migration (v39)', () => {
  let tempDir: string;
  let missingStatePath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'claude-mem-synced-at-'));
    missingStatePath = join(tempDir, 'does-not-exist.json');
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('adds synced_at columns and partial unsynced indexes to all three tables', () => {
    const db = new Database(':memory:');
    try {
      new SessionStore(db, { cloudSyncStatePath: missingStatePath });

      for (const table of SYNCED_TABLES) {
        expect(columnNames(db, table).has('synced_at')).toBe(true);

        const index = db.prepare(`
          SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?
        `).get(`idx_${table}_unsynced`) as { sql: string } | undefined;
        expect(index?.sql).toContain('synced_at IS NULL');
      }

      const version = db.prepare('SELECT version FROM schema_versions WHERE version = 39').get() as { version: number } | undefined;
      expect(version?.version).toBe(39);

      const plan = db.prepare('EXPLAIN QUERY PLAN SELECT id FROM observations WHERE synced_at IS NULL').all() as Array<{ detail: string }>;
      expect(plan.some(row => row.detail.includes('idx_observations_unsynced'))).toBe(true);
    } finally {
      db.close();
    }
  });

  it('is idempotent: repeat construction, even without the version-39 row, does not throw or duplicate columns', () => {
    const db = new Database(':memory:');
    try {
      new SessionStore(db, { cloudSyncStatePath: missingStatePath });
      expect(() => new SessionStore(db, { cloudSyncStatePath: missingStatePath })).not.toThrow();

      // The version row is bookkeeping only — losing it must not break re-runs.
      db.run('DELETE FROM schema_versions WHERE version = 39');
      expect(() => new SessionStore(db, { cloudSyncStatePath: missingStatePath })).not.toThrow();

      for (const table of SYNCED_TABLES) {
        const syncedAtColumns = (db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
          .filter(col => col.name === 'synced_at');
        expect(syncedAtColumns.length).toBe(1);
      }
    } finally {
      db.close();
    }
  });

  it('adds columns, indexes, and stamps legacy rows even when community-edge version rows 36-38 already exist', () => {
    const db = new Database(':memory:');
    try {
      seedPreSyncedAtDb(db, 38);

      // Collision preconditions: version rows 36-38 present, synced_at absent.
      const collidingVersions = db.prepare('SELECT COUNT(*) AS n FROM schema_versions WHERE version IN (36, 37, 38)').get() as { n: number };
      expect(collidingVersions.n).toBe(3);
      for (const table of SYNCED_TABLES) {
        expect(columnNames(db, table).has('synced_at')).toBe(false);
      }

      const statePath = join(tempDir, 'cloud-sync-state.json');
      writeFileSync(statePath, JSON.stringify({
        deviceId: 'ee1b7637-test',
        lastId: 3,
        lastSummaryId: 2,
        lastPromptId: 2,
      }));

      const before = Date.now();
      new SessionStore(db, { cloudSyncStatePath: statePath });

      for (const table of SYNCED_TABLES) {
        expect(columnNames(db, table).has('synced_at')).toBe(true);
        const index = db.prepare(`
          SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?
        `).get(`idx_${table}_unsynced`) as { sql: string } | undefined;
        expect(index?.sql).toContain('synced_at IS NULL');
      }

      expectStampedThroughCursors(db, before);

      const version = db.prepare('SELECT version FROM schema_versions WHERE version = 39').get() as { version: number } | undefined;
      expect(version?.version).toBe(39);

      // The state file is left in place — later phases still read it.
      expect(existsSync(statePath)).toBe(true);
    } finally {
      db.close();
    }
  });

  it('stamps rows at or below the legacy cursors on a v35-era DB when cloud-sync-state.json exists', () => {
    const db = new Database(':memory:');
    try {
      seedPreSyncedAtDb(db, 35);

      const statePath = join(tempDir, 'cloud-sync-state.json');
      writeFileSync(statePath, JSON.stringify({
        deviceId: 'ee1b7637-test',
        lastId: 3,
        lastSummaryId: 2,
        lastPromptId: 2,
      }));

      const before = Date.now();
      new SessionStore(db, { cloudSyncStatePath: statePath });

      expectStampedThroughCursors(db, before);
    } finally {
      db.close();
    }
  });

  it('stamps nothing when no state file exists', () => {
    const db = new Database(':memory:');
    try {
      seedPreSyncedAtDb(db, 35);

      new SessionStore(db, { cloudSyncStatePath: missingStatePath });

      for (const table of SYNCED_TABLES) {
        expect(columnNames(db, table).has('synced_at')).toBe(true);
        expect(stampedCount(db, table)).toBe(0);
      }
    } finally {
      db.close();
    }
  });

  it('does not re-run stamping once the columns exist, even if a state file appears later', () => {
    const db = new Database(':memory:');
    try {
      new SessionStore(db, { cloudSyncStatePath: missingStatePath });
      seedRows(db);

      const statePath = join(tempDir, 'cloud-sync-state.json');
      writeFileSync(statePath, JSON.stringify({ deviceId: 'late', lastId: 5, lastSummaryId: 3, lastPromptId: 4 }));

      new SessionStore(db, { cloudSyncStatePath: statePath });

      for (const table of SYNCED_TABLES) {
        expect(stampedCount(db, table)).toBe(0);
      }
    } finally {
      db.close();
    }
  });

  it('stamps nothing when the state file contains the JSON literal null', () => {
    const db = new Database(':memory:');
    try {
      seedPreSyncedAtDb(db, 38);

      const statePath = join(tempDir, 'cloud-sync-state.json');
      writeFileSync(statePath, 'null');

      expect(() => new SessionStore(db, { cloudSyncStatePath: statePath })).not.toThrow();

      // The migration must complete: version recorded, columns added, no rows stamped.
      const version = db.prepare('SELECT version FROM schema_versions WHERE version = 39').get() as { version: number } | undefined;
      expect(version?.version).toBe(39);

      for (const table of SYNCED_TABLES) {
        expect(columnNames(db, table).has('synced_at')).toBe(true);
        expect(stampedCount(db, table)).toBe(0);
      }
    } finally {
      db.close();
    }
  });

  it('stamps nothing when the state file is unreadable JSON', () => {
    const db = new Database(':memory:');
    try {
      seedPreSyncedAtDb(db, 35);

      const statePath = join(tempDir, 'cloud-sync-state.json');
      writeFileSync(statePath, 'not json{');

      expect(() => new SessionStore(db, { cloudSyncStatePath: statePath })).not.toThrow();

      expect(stampedCount(db, 'observations')).toBe(0);
    } finally {
      db.close();
    }
  });
});

describe('SessionStore v40 prompt requeue (one-time cloud repair)', () => {
  let tempDir: string;
  let missingStatePath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'claude-mem-v40-requeue-'));
    missingStatePath = join(tempDir, 'does-not-exist.json');
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('records version 40 and never re-nulls prompts stamped after the repair ran', () => {
    const db = new Database(':memory:');
    try {
      new SessionStore(db, { cloudSyncStatePath: missingStatePath });

      const version = db.prepare('SELECT version FROM schema_versions WHERE version = 40').get() as { version: number } | undefined;
      expect(version?.version).toBe(40);

      // Prompts synced through the FIXED mapper after the repair must keep
      // their stamps across restarts — a repeat requeue would re-push the
      // whole history on every worker boot.
      seedRows(db);
      db.run('UPDATE user_prompts SET synced_at = 1751234567890');
      new SessionStore(db, { cloudSyncStatePath: missingStatePath });

      expect(stampedCount(db, 'user_prompts')).toBe(4);
    } finally {
      db.close();
    }
  });
});

describe('SessionStore prompt re-push hooks (memory id lands after first sync)', () => {
  let tempDir: string;
  let missingStatePath: string;
  let db: Database;
  let store: SessionStore;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'claude-mem-prompt-requeue-'));
    missingStatePath = join(tempDir, 'does-not-exist.json');
    db = new Database(':memory:');
    store = new SessionStore(db, { cloudSyncStatePath: missingStatePath });

    const now = new Date().toISOString();
    const epoch = Date.now();
    const insertSession = db.prepare(`
      INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
      VALUES (?, ?, 'proj', ?, ?, 'active')
    `);
    insertSession.run('sess-1', 'mem-a', now, epoch);
    insertSession.run('sess-2', 'mem-b', now, epoch);

    // All prompts start out synced (as if the pre-registration push happened).
    const insertPrompt = db.prepare(`
      INSERT INTO user_prompts (session_db_id, content_session_id, prompt_number, prompt_text, created_at, created_at_epoch, synced_at)
      VALUES (?, ?, ?, 'prompt', ?, ?, 1751234567890)
    `);
    insertPrompt.run(1, 'sess-1', 1, now, epoch);
    insertPrompt.run(1, 'sess-1', 2, now, epoch);
    insertPrompt.run(2, 'sess-2', 1, now, epoch);
  });

  afterEach(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('updateMemorySessionId requeues only that session\'s prompts', () => {
    store.updateMemorySessionId(1, 'mem-a2');

    const prompts = syncedAtById(db, 'user_prompts');
    expect(prompts.get(1)).toBeNull();
    expect(prompts.get(2)).toBeNull();
    expect(prompts.get(3)).toBe(1751234567890); // other session untouched
  });

  it('updateMemorySessionId(null) clears the mapping without requeueing', () => {
    store.updateMemorySessionId(1, null);

    // Re-pushing now would only re-send the fallback shape — nothing to repair.
    expect(stampedCount(db, 'user_prompts')).toBe(3);
  });

  it('ensureMemorySessionIdRegistered requeues on change and no-ops when already registered', () => {
    store.ensureMemorySessionIdRegistered(1, 'mem-a');
    expect(stampedCount(db, 'user_prompts')).toBe(3);

    store.ensureMemorySessionIdRegistered(1, 'mem-a3');
    const prompts = syncedAtById(db, 'user_prompts');
    expect(prompts.get(1)).toBeNull();
    expect(prompts.get(2)).toBeNull();
    expect(prompts.get(3)).toBe(1751234567890);
  });
});
