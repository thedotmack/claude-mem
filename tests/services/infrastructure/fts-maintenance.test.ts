import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runPeriodicFtsOptimize } from '../../../src/services/infrastructure/FtsMaintenance.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function ftsBlockBytes(db: Database): number {
  const row = db
    .query('SELECT IFNULL(SUM(LENGTH(block)), 0) AS bytes FROM user_prompts_fts_data')
    .get() as { bytes: number };
  return row.bytes;
}

// Build a user_prompts + external-content FTS mirror, then insert-and-delete a
// pile of rows so the FTS index accumulates delete-marker segments — the exact
// bloat shape from #2793.
function seedBloatedFts(db: Database): void {
  db.run('PRAGMA journal_mode = WAL');
  db.run('CREATE TABLE user_prompts (id INTEGER PRIMARY KEY, prompt_text TEXT)');
  db.run(`
    CREATE VIRTUAL TABLE user_prompts_fts USING fts5(
      prompt_text,
      content='user_prompts',
      content_rowid='id'
    )
  `);
  db.run(`
    CREATE TRIGGER user_prompts_ai AFTER INSERT ON user_prompts BEGIN
      INSERT INTO user_prompts_fts(rowid, prompt_text) VALUES (new.id, new.prompt_text);
    END;
    CREATE TRIGGER user_prompts_ad AFTER DELETE ON user_prompts BEGIN
      INSERT INTO user_prompts_fts(user_prompts_fts, rowid, prompt_text) VALUES('delete', old.id, old.prompt_text);
    END;
  `);

  const insert = db.prepare('INSERT INTO user_prompts (prompt_text) VALUES (?)');
  const body = 'lorem ipsum dolor sit amet consectetur adipiscing elit '.repeat(200);
  for (let i = 0; i < 400; i++) {
    insert.run(`${body} row-${i}`);
  }
  db.run('DELETE FROM user_prompts');
}

describe('runPeriodicFtsOptimize', () => {
  let tempDir: string;
  let db: Database | null = null;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'claude-mem-fts-'));
  });

  afterEach(() => {
    db?.close();
    db = null;
    try {
      rmSync(tempDir, { force: true, recursive: true });
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes('EBUSY')) throw error;
    }
  });

  it('optimizes existing FTS indexes, reclaims delete-marker bloat, and writes a marker', () => {
    db = new Database(join(tempDir, 'fts.db'));
    seedBloatedFts(db);
    const before = ftsBlockBytes(db);
    expect(before).toBeGreaterThan(0);

    const result = runPeriodicFtsOptimize(db, { dataDir: tempDir, now: 1_000_000 });

    expect(result.optimized).toBe(true);
    expect(result.tables).toContain('user_prompts_fts');
    // optimize merges the insert+delete segments, dropping deleted-row content.
    expect(ftsBlockBytes(db)).toBeLessThan(before);
    expect(existsSync(join(tempDir, '.fts-optimize-applied'))).toBe(true);
  });

  it('is throttled: a second run inside the interval is a no-op', () => {
    db = new Database(join(tempDir, 'fts.db'));
    seedBloatedFts(db);

    const first = runPeriodicFtsOptimize(db, { dataDir: tempDir, now: 1_000_000, intervalMs: DAY_MS });
    expect(first.optimized).toBe(true);

    const second = runPeriodicFtsOptimize(db, { dataDir: tempDir, now: 1_000_000 + DAY_MS - 1, intervalMs: DAY_MS });
    expect(second.optimized).toBe(false);
    expect(second.tables).toEqual([]);
  });

  it('runs again once the interval has elapsed', () => {
    db = new Database(join(tempDir, 'fts.db'));
    seedBloatedFts(db);

    runPeriodicFtsOptimize(db, { dataDir: tempDir, now: 1_000_000, intervalMs: DAY_MS });
    const later = runPeriodicFtsOptimize(db, { dataDir: tempDir, now: 1_000_000 + DAY_MS + 1, intervalMs: DAY_MS });

    expect(later.optimized).toBe(true);
    expect(later.tables).toContain('user_prompts_fts');
  });

  it('skips gracefully when no FTS tables exist, still writing the marker', () => {
    db = new Database(join(tempDir, 'fts.db'));
    db.run('CREATE TABLE unrelated (id INTEGER PRIMARY KEY)');

    const result = runPeriodicFtsOptimize(db, { dataDir: tempDir, now: 1_000_000 });

    expect(result.optimized).toBe(false);
    expect(result.tables).toEqual([]);
    const marker = JSON.parse(readFileSync(join(tempDir, '.fts-optimize-applied'), 'utf-8'));
    expect(marker.tables).toEqual([]);
  });
});
