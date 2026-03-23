/**
 * Migration 24: provenance columns
 * Tests that node, platform, instance columns are added to observations and sdk_sessions.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { MigrationRunner } from '../../src/services/sqlite/migrations/runner.js';

describe('Migration 24: provenance columns', () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(':memory:');
    // Run all migrations so schema is fully up to date
    const runner = new MigrationRunner(db);
    runner.runAllMigrations();
  });

  afterEach(() => {
    db.close();
  });

  it('adds node, platform, instance columns to observations', () => {
    const info = db.query('PRAGMA table_info(observations)').all() as { name: string }[];
    const names = info.map(c => c.name);
    expect(names).toContain('node');
    expect(names).toContain('platform');
    expect(names).toContain('instance');
  });

  it('adds node, platform, instance columns to sdk_sessions', () => {
    const info = db.query('PRAGMA table_info(sdk_sessions)').all() as { name: string }[];
    const names = info.map(c => c.name);
    expect(names).toContain('node');
    expect(names).toContain('platform');
    expect(names).toContain('instance');
  });

  it('provenance columns in observations are nullable (no NOT NULL constraint)', () => {
    const info = db.query('PRAGMA table_info(observations)').all() as { name: string; notnull: number }[];
    for (const col of ['node', 'platform', 'instance']) {
      const column = info.find(c => c.name === col);
      expect(column).toBeDefined();
      expect(column!.notnull).toBe(0);
    }
  });

  it('provenance columns in sdk_sessions are nullable (no NOT NULL constraint)', () => {
    const info = db.query('PRAGMA table_info(sdk_sessions)').all() as { name: string; notnull: number }[];
    for (const col of ['node', 'platform', 'instance']) {
      const column = info.find(c => c.name === col);
      expect(column).toBeDefined();
      expect(column!.notnull).toBe(0);
    }
  });

  it('creates idx_observations_node index', () => {
    const indexes = db.query("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_observations_node'").all() as { name: string }[];
    expect(indexes.length).toBe(1);
    expect(indexes[0].name).toBe('idx_observations_node');
  });

  it('records migration version 24 in schema_versions', () => {
    const row = db.query('SELECT version FROM schema_versions WHERE version = 24').get() as { version: number } | undefined;
    expect(row).toBeDefined();
    expect(row!.version).toBe(24);
  });

  it('is idempotent — running migrations twice does not throw', () => {
    expect(() => {
      const runner = new MigrationRunner(db);
      runner.runAllMigrations();
    }).not.toThrow();
  });

  it('allows inserting observations with NULL provenance columns', () => {
    // Create a session first (FK requirement)
    db.run(`INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch)
            VALUES ('cs-test', 'ms-test', 'test-project', '2025-01-01T00:00:00Z', 1735689600)`);

    expect(() => {
      db.run(`INSERT INTO observations (memory_session_id, project, text, type, created_at, created_at_epoch)
              VALUES ('ms-test', 'test-project', 'test text', 'discovery', '2025-01-01T00:00:00Z', 1735689600)`);
    }).not.toThrow();
  });

  it('allows inserting observations with explicit provenance values', () => {
    db.run(`INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch)
            VALUES ('cs-prov', 'ms-prov', 'test-project', '2025-01-01T00:00:00Z', 1735689600)`);

    db.run(`INSERT INTO observations (memory_session_id, project, text, type, created_at, created_at_epoch, node, platform, instance)
            VALUES ('ms-prov', 'test-project', 'test text', 'discovery', '2025-01-01T00:00:00Z', 1735689600, 'MSM4M', 'darwin', 'inst-abc123')`);

    const row = db.query("SELECT node, platform, instance FROM observations WHERE memory_session_id = 'ms-prov'").get() as { node: string; platform: string; instance: string } | undefined;
    expect(row).toBeDefined();
    expect(row!.node).toBe('MSM4M');
    expect(row!.platform).toBe('darwin');
    expect(row!.instance).toBe('inst-abc123');
  });
});
