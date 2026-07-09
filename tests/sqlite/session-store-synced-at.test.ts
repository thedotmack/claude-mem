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

function seedRows(db: Database): void {
  const now = new Date().toISOString();
  const epoch = Date.now();

  db.prepare(`
    INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
    VALUES (?, ?, ?, ?, ?, 'active')
  `).run('content-sync', 'memory-sync', 'sync-project', now, epoch);

  const insertObs = db.prepare(`
    INSERT INTO observations (memory_session_id, project, type, created_at, created_at_epoch)
    VALUES ('memory-sync', 'sync-project', 'discovery', ?, ?)
  `);
  for (let i = 0; i < 5; i++) insertObs.run(now, epoch + i);

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

/** Re-run the v36 migration over an already-migrated db with a specific state file path. */
function rerunSyncedAtMigration(db: Database, cloudSyncStatePath: string): SessionStore {
  db.run('DELETE FROM schema_versions WHERE version = 36');
  return new SessionStore(db, { cloudSyncStatePath });
}

describe('SessionStore synced_at migration (v36)', () => {
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

      const version = db.prepare('SELECT version FROM schema_versions WHERE version = 36').get() as { version: number } | undefined;
      expect(version?.version).toBe(36);

      const plan = db.prepare('EXPLAIN QUERY PLAN SELECT id FROM observations WHERE synced_at IS NULL').all() as Array<{ detail: string }>;
      expect(plan.some(row => row.detail.includes('idx_observations_unsynced'))).toBe(true);
    } finally {
      db.close();
    }
  });

  it('is idempotent: constructing twice and re-running the migration over migrated tables does not throw', () => {
    const db = new Database(':memory:');
    try {
      new SessionStore(db, { cloudSyncStatePath: missingStatePath });
      expect(() => new SessionStore(db, { cloudSyncStatePath: missingStatePath })).not.toThrow();

      // Version row lost but columns already present: PRAGMA guard must skip the ALTER.
      expect(() => rerunSyncedAtMigration(db, missingStatePath)).not.toThrow();

      for (const table of SYNCED_TABLES) {
        const syncedAtColumns = (db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
          .filter(col => col.name === 'synced_at');
        expect(syncedAtColumns.length).toBe(1);
      }
    } finally {
      db.close();
    }
  });

  it('stamps rows at or below the legacy cursors when cloud-sync-state.json exists', () => {
    const db = new Database(':memory:');
    try {
      new SessionStore(db, { cloudSyncStatePath: missingStatePath });
      seedRows(db);

      // Pre-stamped rows must keep their original timestamp.
      db.run('UPDATE observations SET synced_at = 12345 WHERE id = 1');

      const statePath = join(tempDir, 'cloud-sync-state.json');
      writeFileSync(statePath, JSON.stringify({
        deviceId: 'ee1b7637-test',
        lastId: 3,
        lastSummaryId: 2,
        lastPromptId: 2,
      }));

      const before = Date.now();
      rerunSyncedAtMigration(db, statePath);

      const observations = syncedAtById(db, 'observations');
      expect(observations.get(1)).toBe(12345);
      expect(observations.get(2)).toBeGreaterThanOrEqual(before);
      expect(observations.get(3)).toBeGreaterThanOrEqual(before);
      expect(observations.get(4)).toBeNull();
      expect(observations.get(5)).toBeNull();

      const summaries = syncedAtById(db, 'session_summaries');
      expect(summaries.get(1)).toBeGreaterThanOrEqual(before);
      expect(summaries.get(2)).toBeGreaterThanOrEqual(before);
      expect(summaries.get(3)).toBeNull();

      const prompts = syncedAtById(db, 'user_prompts');
      expect(prompts.get(1)).toBeGreaterThanOrEqual(before);
      expect(prompts.get(2)).toBeGreaterThanOrEqual(before);
      expect(prompts.get(3)).toBeNull();
      expect(prompts.get(4)).toBeNull();

      // The state file is left in place — later phases still read it.
      expect(existsSync(statePath)).toBe(true);
    } finally {
      db.close();
    }
  });

  it('stamps nothing when no state file exists', () => {
    const db = new Database(':memory:');
    try {
      new SessionStore(db, { cloudSyncStatePath: missingStatePath });
      seedRows(db);

      rerunSyncedAtMigration(db, missingStatePath);

      for (const table of SYNCED_TABLES) {
        const stamped = db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE synced_at IS NOT NULL`).get() as { n: number };
        expect(stamped.n).toBe(0);
      }
    } finally {
      db.close();
    }
  });

  it('stamps nothing when the state file contains the JSON literal null', () => {
    const db = new Database(':memory:');
    try {
      new SessionStore(db, { cloudSyncStatePath: missingStatePath });
      seedRows(db);

      const statePath = join(tempDir, 'cloud-sync-state.json');
      writeFileSync(statePath, 'null');

      expect(() => rerunSyncedAtMigration(db, statePath)).not.toThrow();

      // The migration must complete: version recorded, so the constructor does not re-run it.
      const version = db.prepare('SELECT version FROM schema_versions WHERE version = 36').get() as { version: number } | undefined;
      expect(version?.version).toBe(36);

      for (const table of SYNCED_TABLES) {
        const stamped = db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE synced_at IS NOT NULL`).get() as { n: number };
        expect(stamped.n).toBe(0);
      }
    } finally {
      db.close();
    }
  });

  it('stamps nothing when the state file is unreadable JSON', () => {
    const db = new Database(':memory:');
    try {
      new SessionStore(db, { cloudSyncStatePath: missingStatePath });
      seedRows(db);

      const statePath = join(tempDir, 'cloud-sync-state.json');
      writeFileSync(statePath, 'not json{');

      expect(() => rerunSyncedAtMigration(db, statePath)).not.toThrow();

      const stamped = db.prepare('SELECT COUNT(*) AS n FROM observations WHERE synced_at IS NOT NULL').get() as { n: number };
      expect(stamped.n).toBe(0);
    } finally {
      db.close();
    }
  });
});
