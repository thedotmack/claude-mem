import { describe, it, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  createToolUsesSchema,
  getToolUsesByIds,
  purgeLinkedToolUses,
  upsertToolUse,
} from '../../src/services/sqlite/tool-uses.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 7, 12, 0, 0);

function seed(db: Database, toolUseId: string, ageDays: number, observationId: number | null): number {
  const id = upsertToolUse(db, {
    toolUseId,
    contentSessionId: 'content-session-a',
    project: 'claude-mem',
    toolName: 'Read',
    toolInput: '{"file_path":"/tmp/a.ts"}',
    toolResponse: '{"ok":true}',
    createdAtEpoch: NOW - ageDays * DAY_MS,
  });
  if (id === null) throw new Error('seed row was not written');
  if (observationId !== null) {
    db.prepare('UPDATE tool_uses SET observation_id = ? WHERE id = ?').run(observationId, id);
    createObservations(db, [observationId]);
  }
  return id;
}

function freshDb(): Database {
  const db = new Database(':memory:');
  createToolUsesSchema(db);
  // The purge only trusts a link to an observation that still exists.
  db.run('CREATE TABLE observations (id INTEGER PRIMARY KEY)');
  return db;
}

/** Make every observation id the seeds link to exist, except the ones listed. */
function createObservations(db: Database, ids: number[]): void {
  const insert = db.prepare('INSERT OR IGNORE INTO observations (id) VALUES (?)');
  for (const id of ids) insert.run(id);
}

function remainingToolUseIds(db: Database): string[] {
  return (db.query('SELECT tool_use_id FROM tool_uses ORDER BY id').all() as Array<{ tool_use_id: string }>)
    .map(row => row.tool_use_id);
}

describe('purgeLinkedToolUses', () => {
  it('does nothing when retention is 0, however old the rows are', () => {
    const db = freshDb();
    seed(db, 'old-linked', 400, 11);
    seed(db, 'old-unlinked', 400, null);

    expect(purgeLinkedToolUses(db, 0, NOW)).toBe(0);
    expect(remainingToolUseIds(db)).toEqual(['old-linked', 'old-unlinked']);
  });

  it('removes rows older than N days that are linked to an observation', () => {
    const db = freshDb();
    seed(db, 'old-linked', 40, 11);

    expect(purgeLinkedToolUses(db, 30, NOW)).toBe(1);
    expect(remainingToolUseIds(db)).toEqual([]);
  });

  it('keeps old rows with no observation: they are the only copy of that I/O', () => {
    const db = freshDb();
    seed(db, 'old-unlinked', 400, null);

    expect(purgeLinkedToolUses(db, 30, NOW)).toBe(0);
    expect(remainingToolUseIds(db)).toEqual(['old-unlinked']);
  });

  it('keeps linked rows that are still inside the window', () => {
    const db = freshDb();
    seed(db, 'recent-linked', 5, 11);

    expect(purgeLinkedToolUses(db, 30, NOW)).toBe(0);
    expect(remainingToolUseIds(db)).toEqual(['recent-linked']);
  });

  it('applies the age cutoff exactly: a row 30 days old stays, one a day older goes', () => {
    const db = freshDb();
    seed(db, 'exactly-30', 30, 11);
    seed(db, 'just-over', 31, 11);

    expect(purgeLinkedToolUses(db, 30, NOW)).toBe(1);
    expect(remainingToolUseIds(db)).toEqual(['exactly-30']);
  });

  it('purges a mixed table selectively and reports how many rows went', () => {
    const db = freshDb();
    seed(db, 'old-linked-a', 90, 1);
    seed(db, 'old-linked-b', 60, 2);
    seed(db, 'old-unlinked', 90, null);
    seed(db, 'recent-linked', 1, 3);
    seed(db, 'recent-unlinked', 1, null);

    expect(purgeLinkedToolUses(db, 30, NOW)).toBe(2);
    expect(remainingToolUseIds(db)).toEqual(['old-unlinked', 'recent-linked', 'recent-unlinked']);
  });

  it('keeps a row whose observation was deleted: it is then the only copy of that I/O', () => {
    const db = freshDb();
    seed(db, 'orphaned', 90, 11);
    seed(db, 'still-linked', 90, 12);
    db.prepare('DELETE FROM observations WHERE id = ?').run(11);

    expect(purgeLinkedToolUses(db, 30, NOW)).toBe(1);
    expect(remainingToolUseIds(db)).toEqual(['orphaned']);
  });

  it('makes get_tool_uses on a purged id return the existing not-found shape', () => {
    const db = freshDb();
    const id = seed(db, 'old-linked', 40, 11);
    expect(getToolUsesByIds(db, [id])).toHaveLength(1);

    purgeLinkedToolUses(db, 30, NOW);

    expect(getToolUsesByIds(db, [id])).toEqual([]);
    expect(getToolUsesByIds(db, ['old-linked'])).toEqual([]);
  });

  it('is a no-op on a database without a tool_uses table', () => {
    const db = new Database(':memory:');
    expect(purgeLinkedToolUses(db, 30, NOW)).toBe(0);
  });
});
