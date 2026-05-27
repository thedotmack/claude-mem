import { describe, it, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { MigrationRunner } from '../../../../src/services/sqlite/migrations/runner.js';

interface ColumnInfo {
  name: string;
  dflt_value: unknown;
  notnull: number;
}

interface IndexRow {
  name: string;
}

interface SchemaVersionRow {
  version: number;
}

describe('migration v35: pending_messages fold columns', () => {
  it('adds fold_key and fold_count columns + index', () => {
    const db = new Database(':memory:');
    const runner = new MigrationRunner(db);
    runner.runAllMigrations();

    const cols = db.prepare('PRAGMA table_info(pending_messages)').all() as ColumnInfo[];
    const names = cols.map((c) => c.name);
    expect(names).toContain('fold_key');
    expect(names).toContain('fold_count');

    const foldCount = cols.find((c) => c.name === 'fold_count')!;
    expect(foldCount.notnull).toBe(1);
    expect(String(foldCount.dflt_value)).toBe('1');

    const idx = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_pending_fold'")
      .get() as IndexRow | undefined;
    expect(idx).toBeTruthy();

    const recorded = db
      .prepare('SELECT version FROM schema_versions WHERE version = ?')
      .get(35) as SchemaVersionRow | undefined;
    expect(recorded?.version).toBe(35);
  });

  it('is idempotent (running twice does not throw)', () => {
    const db = new Database(':memory:');
    const runner = new MigrationRunner(db);
    runner.runAllMigrations();
    expect(() => runner.runAllMigrations()).not.toThrow();
  });

  it('migration v36 adds fold_window_seconds column and records the version', () => {
    const db = new Database(':memory:');
    new MigrationRunner(db).runAllMigrations();

    const cols = db.prepare('PRAGMA table_info(pending_messages)').all() as ColumnInfo[];
    const names = cols.map((c) => c.name);
    expect(names).toContain('fold_window_seconds');

    const col = cols.find((c) => c.name === 'fold_window_seconds')!;
    expect(col.notnull).toBe(0); // nullable so pre-fold rows backfill as NULL

    const recorded = db
      .prepare('SELECT version FROM schema_versions WHERE version = ?')
      .get(36) as SchemaVersionRow | undefined;
    expect(recorded?.version).toBe(36);
  });

  it('upgrades legacy databases that lack the fold columns', () => {
    const db = new Database(':memory:');

    // Boot to a fresh, fully-migrated baseline first…
    new MigrationRunner(db).runAllMigrations();

    // …then simulate a pre-v35 install by dropping fold_key/fold_count and
    // rolling the recorded schema version back to 34.
    db.run('DROP INDEX IF EXISTS idx_pending_fold');
    db.run('ALTER TABLE pending_messages DROP COLUMN fold_key');
    db.run('ALTER TABLE pending_messages DROP COLUMN fold_count');
    db.prepare('DELETE FROM schema_versions WHERE version = ?').run(35);

    const beforeNames = (db.prepare('PRAGMA table_info(pending_messages)').all() as ColumnInfo[])
      .map((c) => c.name);
    expect(beforeNames).not.toContain('fold_key');
    expect(beforeNames).not.toContain('fold_count');

    new MigrationRunner(db).runAllMigrations();

    const afterCols = db.prepare('PRAGMA table_info(pending_messages)').all() as ColumnInfo[];
    const afterNames = afterCols.map((c) => c.name);
    expect(afterNames).toContain('fold_key');
    expect(afterNames).toContain('fold_count');

    const idx = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_pending_fold'")
      .get() as IndexRow | undefined;
    expect(idx).toBeTruthy();
  });
});
