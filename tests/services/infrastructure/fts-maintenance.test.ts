import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  reclaimFtsBloatInBoundedSteps,
  scheduleOneTimeFtsBloatReclaim,
} from '../../../src/services/infrastructure/FtsMaintenance.js';

const RECLAIM_MARKER_FILENAME = '.fts-bloat-reclaim-started';

function ftsBlockBytes(db: Database): number {
  const row = db
    .query('SELECT IFNULL(SUM(LENGTH(block)), 0) AS bytes FROM observations_fts_data')
    .get() as { bytes: number };
  return row.bytes;
}

// An observations table with an external-content FTS mirror, churned the way the pre-v53
// unscoped update trigger did on every bookkeeping write, so the index accumulates
// delete-marker segments — the #2793 bloat shape.
function seedBloatedObservationsFts(db: Database): void {
  db.run('PRAGMA journal_mode = WAL');
  db.run('CREATE TABLE observations (id INTEGER PRIMARY KEY, title TEXT, sync_rev INTEGER DEFAULT 0)');
  db.run(`CREATE VIRTUAL TABLE observations_fts USING fts5(title, content='observations', content_rowid='id')`);
  db.run(`
    CREATE TRIGGER observations_ai AFTER INSERT ON observations BEGIN
      INSERT INTO observations_fts(rowid, title) VALUES (new.id, new.title);
    END;
    CREATE TRIGGER observations_au AFTER UPDATE ON observations BEGIN
      INSERT INTO observations_fts(observations_fts, rowid, title) VALUES('delete', old.id, old.title);
      INSERT INTO observations_fts(rowid, title) VALUES (new.id, new.title);
    END;
  `);

  const insert = db.prepare('INSERT INTO observations (title) VALUES (?)');
  const body = 'lorem ipsum dolor sit amet consectetur adipiscing elit '.repeat(50);
  for (let i = 0; i < 400; i++) {
    insert.run(`${body} row${i}`);
  }
  for (let round = 0; round < 3; round++) {
    db.run('UPDATE observations SET sync_rev = sync_rev + 1');
  }
}

async function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

describe('FTS bloat reclaim', () => {
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

  it('merges a bloated index in bounded steps and drops its dead content', async () => {
    db = new Database(join(tempDir, 'fts.db'));
    seedBloatedObservationsFts(db);
    const bytesBefore = ftsBlockBytes(db);

    const results = await reclaimFtsBloatInBoundedSteps(db, { pagesPerMergeStep: 8, pauseBetweenMergeStepsMs: 0 });

    expect(results.map(result => result.table)).toEqual(['observations_fts']);
    expect(results[0].mergeSteps).toBeGreaterThan(1);
    expect(ftsBlockBytes(db)).toBeLessThan(bytesBefore);
    const hits = db.query(`SELECT rowid FROM observations_fts WHERE observations_fts MATCH 'row123'`).all();
    expect(hits).toHaveLength(1);
  });

  it('skips a database without the FTS tables', async () => {
    db = new Database(join(tempDir, 'fts.db'));
    db.run('CREATE TABLE unrelated (id INTEGER PRIMARY KEY)');

    expect(await reclaimFtsBloatInBoundedSteps(db)).toEqual([]);
  });

  it('writes its marker before any work, never holds the process open, and schedules only once', () => {
    db = new Database(join(tempDir, 'fts.db'));
    seedBloatedObservationsFts(db);

    const timer = scheduleOneTimeFtsBloatReclaim(db, { dataDir: tempDir, startDelayMs: 60_000 });

    expect(timer).not.toBeNull();
    expect(existsSync(join(tempDir, RECLAIM_MARKER_FILENAME))).toBe(true);
    expect(timer!.hasRef()).toBe(false);
    clearTimeout(timer!);
    expect(scheduleOneTimeFtsBloatReclaim(db, { dataDir: tempDir })).toBeNull();
  });

  it('runs the reclaim when the scheduled timer fires', async () => {
    db = new Database(join(tempDir, 'fts.db'));
    seedBloatedObservationsFts(db);
    const bytesBefore = ftsBlockBytes(db);

    scheduleOneTimeFtsBloatReclaim(db, { dataDir: tempDir, startDelayMs: 0, pagesPerMergeStep: 8, pauseBetweenMergeStepsMs: 0 });

    await waitFor(() => ftsBlockBytes(db!) < bytesBefore);
  });
});
