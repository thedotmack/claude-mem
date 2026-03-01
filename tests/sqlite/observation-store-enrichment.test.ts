/**
 * Storage layer enrichment tests (Task 5)
 *
 * Tests that all 3 INSERT paths correctly persist topics, entities, event_date
 * with empty-array-to-NULL coercion for backfill checkpoint compatibility.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { storeObservation } from '../../src/services/sqlite/observations/store.js';
import {
  storeObservations,
  storeObservationsAndMarkComplete,
} from '../../src/services/sqlite/transactions.js';
import type { ObservationInput } from '../../src/services/sqlite/observations/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');

  // Create observations table with all enrichment columns
  db.exec(`
    CREATE TABLE IF NOT EXISTS observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      memory_session_id TEXT NOT NULL,
      project TEXT NOT NULL DEFAULT 'default',
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
      read_tokens INTEGER,
      priority TEXT DEFAULT 'informational',
      topics TEXT,
      entities TEXT,
      event_date TEXT,
      pinned INTEGER DEFAULT 0,
      access_count INTEGER DEFAULT 0,
      supersedes_id TEXT,
      created_at TEXT NOT NULL,
      created_at_epoch INTEGER NOT NULL
    )
  `);

  // Create session_summaries table (needed by transactions)
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_summaries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      memory_session_id TEXT NOT NULL,
      project TEXT NOT NULL DEFAULT 'default',
      request TEXT,
      investigated TEXT,
      learned TEXT,
      completed TEXT,
      next_steps TEXT,
      notes TEXT,
      prompt_number INTEGER,
      discovery_tokens INTEGER DEFAULT 0,
      created_at TEXT NOT NULL,
      created_at_epoch INTEGER NOT NULL
    )
  `);

  // Create pending_messages table (needed by storeObservationsAndMarkComplete)
  db.exec(`
    CREATE TABLE IF NOT EXISTS pending_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      memory_session_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      project TEXT NOT NULL DEFAULT 'default',
      tool_input TEXT,
      tool_response TEXT,
      prompt_number INTEGER,
      discovery_tokens INTEGER DEFAULT 0,
      status TEXT DEFAULT 'pending',
      created_at_epoch INTEGER NOT NULL,
      completed_at_epoch INTEGER
    )
  `);

  return db;
}

function makeObservation(overrides: Partial<ObservationInput> = {}): ObservationInput {
  return {
    type: 'discovery',
    title: 'Test observation',
    subtitle: null,
    facts: ['fact-1'],
    narrative: 'Test narrative',
    concepts: ['how-it-works'],
    files_read: [],
    files_modified: [],
    ...overrides,
  };
}

function getObservation(db: Database.Database, id: number) {
  return db.prepare('SELECT * FROM observations WHERE id = ?').get(id) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

let db: Database.Database;

beforeEach(() => {
  db = createTestDb();
});

afterEach(() => {
  db.close();
});

// ---------------------------------------------------------------------------
// storeObservation (store.ts)
// ---------------------------------------------------------------------------

describe('storeObservation — enrichment fields', () => {
  it('should persist topics as JSON string', () => {
    const obs = makeObservation({ topics: ['auth', 'migration'] });
    const { id } = storeObservation(db, 'sess-1', 'proj', obs);
    const row = getObservation(db, id);
    expect(row.topics).toBe('["auth","migration"]');
  });

  it('should persist entities as JSON string', () => {
    const obs = makeObservation({
      entities: [
        { name: 'Alice', type: 'person' },
        { name: 'Redis', type: 'system' },
      ],
    });
    const { id } = storeObservation(db, 'sess-1', 'proj', obs);
    const row = getObservation(db, id);
    expect(JSON.parse(row.entities as string)).toEqual([
      { name: 'Alice', type: 'person' },
      { name: 'Redis', type: 'system' },
    ]);
  });

  it('should persist event_date as string', () => {
    const obs = makeObservation({ event_date: '2026-03-15' });
    const { id } = storeObservation(db, 'sess-1', 'proj', obs);
    const row = getObservation(db, id);
    expect(row.event_date).toBe('2026-03-15');
  });

  it('should store NULL for empty topics array (backfill checkpoint)', () => {
    const obs = makeObservation({ topics: [] });
    const { id } = storeObservation(db, 'sess-1', 'proj', obs);
    const row = getObservation(db, id);
    expect(row.topics).toBeNull();
  });

  it('should store NULL for empty entities array (backfill checkpoint)', () => {
    const obs = makeObservation({ entities: [] });
    const { id } = storeObservation(db, 'sess-1', 'proj', obs);
    const row = getObservation(db, id);
    expect(row.entities).toBeNull();
  });

  it('should store NULL when enrichment fields are undefined', () => {
    const obs = makeObservation(); // no topics/entities/event_date
    const { id } = storeObservation(db, 'sess-1', 'proj', obs);
    const row = getObservation(db, id);
    expect(row.topics).toBeNull();
    expect(row.entities).toBeNull();
    expect(row.event_date).toBeNull();
  });

  it('should round-trip enrichment data correctly', () => {
    const obs = makeObservation({
      topics: ['deployment', 'ci-cd'],
      entities: [{ name: 'GitHub Actions', type: 'system' }],
      event_date: '2026-04-01',
    });
    const { id } = storeObservation(db, 'sess-1', 'proj', obs);
    const row = getObservation(db, id);
    expect(JSON.parse(row.topics as string)).toEqual(['deployment', 'ci-cd']);
    expect(JSON.parse(row.entities as string)).toEqual([{ name: 'GitHub Actions', type: 'system' }]);
    expect(row.event_date).toBe('2026-04-01');
  });
});

// ---------------------------------------------------------------------------
// storeObservations (transactions.ts)
// ---------------------------------------------------------------------------

describe('storeObservations — enrichment fields', () => {
  it('should persist enrichment fields in transaction path', () => {
    const obs = makeObservation({
      topics: ['auth'],
      entities: [{ name: 'Alice', type: 'person' }],
      event_date: '2026-03-15',
    });
    const result = storeObservations(db, 'sess-1', 'proj', [obs], null);
    const row = getObservation(db, result.observationIds[0]);
    expect(JSON.parse(row.topics as string)).toEqual(['auth']);
    expect(JSON.parse(row.entities as string)).toEqual([{ name: 'Alice', type: 'person' }]);
    expect(row.event_date).toBe('2026-03-15');
  });

  it('should coerce empty arrays to NULL in transaction path', () => {
    const obs = makeObservation({ topics: [], entities: [] });
    const result = storeObservations(db, 'sess-1', 'proj', [obs], null);
    const row = getObservation(db, result.observationIds[0]);
    expect(row.topics).toBeNull();
    expect(row.entities).toBeNull();
  });

  it('should calculate read_tokens in transaction path', () => {
    const obs = makeObservation({ narrative: 'This is a long narrative with many words' });
    const result = storeObservations(db, 'sess-1', 'proj', [obs], null);
    const row = getObservation(db, result.observationIds[0]);
    expect(row.read_tokens).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// storeObservationsAndMarkComplete (transactions.ts)
// ---------------------------------------------------------------------------

describe('storeObservationsAndMarkComplete — enrichment fields', () => {
  it('should persist enrichment fields with message completion', () => {
    // Insert a pending message first
    db.prepare(`
      INSERT INTO pending_messages (memory_session_id, session_id, project, status, created_at_epoch)
      VALUES ('sess-1', 'claude-sess', 'proj', 'processing', ?)
    `).run(Date.now());
    const msgId = Number(db.prepare('SELECT last_insert_rowid() as id').get()!.id);

    const obs = makeObservation({
      topics: ['testing', 'tdd'],
      entities: [{ name: 'Vitest', type: 'technology' }],
      event_date: '2026-03-01',
    });
    const result = storeObservationsAndMarkComplete(db, 'sess-1', 'proj', [obs], null, msgId);
    const row = getObservation(db, result.observationIds[0]);
    expect(JSON.parse(row.topics as string)).toEqual(['testing', 'tdd']);
    expect(JSON.parse(row.entities as string)).toEqual([{ name: 'Vitest', type: 'technology' }]);
    expect(row.event_date).toBe('2026-03-01');
  });

  it('should coerce empty arrays to NULL with message completion', () => {
    db.prepare(`
      INSERT INTO pending_messages (memory_session_id, session_id, project, status, created_at_epoch)
      VALUES ('sess-1', 'claude-sess', 'proj', 'processing', ?)
    `).run(Date.now());
    const msgId = Number(db.prepare('SELECT last_insert_rowid() as id').get()!.id);

    const obs = makeObservation({ topics: [], entities: [] });
    const result = storeObservationsAndMarkComplete(db, 'sess-1', 'proj', [obs], null, msgId);
    const row = getObservation(db, result.observationIds[0]);
    expect(row.topics).toBeNull();
    expect(row.entities).toBeNull();
  });

  it('should calculate read_tokens with message completion', () => {
    db.prepare(`
      INSERT INTO pending_messages (memory_session_id, session_id, project, status, created_at_epoch)
      VALUES ('sess-1', 'claude-sess', 'proj', 'processing', ?)
    `).run(Date.now());
    const msgId = Number(db.prepare('SELECT last_insert_rowid() as id').get()!.id);

    const obs = makeObservation({ narrative: 'Long narrative content for token estimation' });
    const result = storeObservationsAndMarkComplete(db, 'sess-1', 'proj', [obs], null, msgId);
    const row = getObservation(db, result.observationIds[0]);
    expect(row.read_tokens).toBeGreaterThan(0);
  });
});
