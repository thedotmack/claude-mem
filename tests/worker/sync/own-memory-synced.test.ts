import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { ownMemorySynced } from '../../../src/services/sync/own-memory-synced.js';

// The columns ownMemorySynced reads, as SessionStore creates them, and the v47 launch ledger (SessionStore
// SYNC_LAUNCH_EXCLUSIONS_DDL). SessionStore itself needs the full dependency tree, so the schema is spelled out here.
function database({ ledger = true } = {}): Database {
  const db = new Database(':memory:');
  for (const table of ['observations', 'session_summaries', 'user_prompts']) {
    db.run(`CREATE TABLE ${table} (id INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT, memory_session_id TEXT,
      synced_at INTEGER, origin_device_id TEXT, origin_local_id TEXT, sync_rev TEXT NOT NULL DEFAULT '1')`);
  }
  if (ledger) {
    db.run(`CREATE TABLE sync_launch_exclusions (
      kind TEXT NOT NULL CHECK (kind IN ('observation', 'summary', 'prompt', 'work_state')),
      origin_local_id TEXT NOT NULL, through_rev TEXT NOT NULL, PRIMARY KEY (kind, origin_local_id))`);
  }
  return db;
}

const LAUNCH = 1_790_000_000_000;
const ACK = LAUNCH + 60_000;

function insert(db: Database, table: string, row: { syncedAt: number | null; rev?: string; originDevice?: string | null }): number {
  return Number(db.prepare(`INSERT INTO ${table} (project, memory_session_id, synced_at, origin_device_id, sync_rev) VALUES ('p', 'm', ?, ?, ?)`)
    .run(row.syncedAt, row.originDevice ?? null, row.rev ?? '1').lastInsertRowid);
}

/** A row the v47 baseline stamped without a hub acknowledgement, recorded with the revision it covers. */
function preLaunch(db: Database, table: string, kind: string, rev = '1'): number {
  const id = insert(db, table, { syncedAt: LAUNCH, rev });
  db.prepare('INSERT INTO sync_launch_exclusions (kind, origin_local_id, through_rev) VALUES (?, ?, ?)').run(kind, String(id), rev);
  return id;
}

describe('ownMemorySynced: whether the hub ever acknowledged a memory from this computer', () => {
  it('is false for an empty database and for a corpus the launch baseline stamped without any acknowledgement', () => {
    const db = database();
    expect(ownMemorySynced(db)).toBe(false);
    preLaunch(db, 'observations', 'observation');
    preLaunch(db, 'session_summaries', 'summary');
    expect(ownMemorySynced(db)).toBe(false);
  });

  it('is true once the hub acknowledges a new observation, or a new summary', () => {
    const observations = database();
    preLaunch(observations, 'observations', 'observation');
    insert(observations, 'observations', { syncedAt: null });
    expect(ownMemorySynced(observations)).toBe(false);
    insert(observations, 'observations', { syncedAt: ACK });
    expect(ownMemorySynced(observations)).toBe(true);

    const summaries = database();
    insert(summaries, 'session_summaries', { syncedAt: ACK });
    expect(ownMemorySynced(summaries)).toBe(true);
  });

  it('counts an edit of a pre-launch row only once the hub acknowledges its newer revision', () => {
    const db = database();
    const id = preLaunch(db, 'observations', 'observation', '9');
    // Waiting to push: the edit cleared the stamp.
    db.prepare("UPDATE observations SET sync_rev = '10', synced_at = NULL WHERE id = ?").run(id);
    expect(ownMemorySynced(db)).toBe(false);
    db.prepare('UPDATE observations SET synced_at = ? WHERE id = ?').run(ACK, id);
    expect(ownMemorySynced(db)).toBe(true);
    // Revisions compare as decimals, not as text ("10" > "9").
    db.prepare("UPDATE observations SET sync_rev = '9' WHERE id = ?").run(id);
    expect(ownMemorySynced(db)).toBe(false);
  });

  it('never counts replica rows from other devices, quarantined rows, or prompts', () => {
    const db = database();
    insert(db, 'observations', { syncedAt: ACK, originDevice: 'other-device' });
    insert(db, 'session_summaries', { syncedAt: ACK, originDevice: 'other-device' });
    insert(db, 'observations', { syncedAt: -1 });
    insert(db, 'user_prompts', { syncedAt: ACK });
    expect(ownMemorySynced(db)).toBe(false);
  });

  it('counts nothing without the launch ledger, where a stamp cannot be told from the baseline', () => {
    const db = database({ ledger: false });
    insert(db, 'observations', { syncedAt: ACK });
    expect(ownMemorySynced(db)).toBe(false);
  });

  it('skips a table that predates the sync columns', () => {
    const db = new Database(':memory:');
    db.run('CREATE TABLE observations (id INTEGER PRIMARY KEY, project TEXT)');
    db.run(`CREATE TABLE session_summaries (id INTEGER PRIMARY KEY, synced_at INTEGER, origin_device_id TEXT, sync_rev TEXT NOT NULL DEFAULT '1')`);
    db.run(`CREATE TABLE sync_launch_exclusions (kind TEXT NOT NULL, origin_local_id TEXT NOT NULL, through_rev TEXT NOT NULL, PRIMARY KEY (kind, origin_local_id))`);
    db.run('INSERT INTO observations (project) VALUES (\'p\')');
    expect(ownMemorySynced(db)).toBe(false);
    db.prepare("INSERT INTO session_summaries (synced_at, origin_device_id, sync_rev) VALUES (?, NULL, '1')").run(ACK);
    expect(ownMemorySynced(db)).toBe(true);
  });
});
