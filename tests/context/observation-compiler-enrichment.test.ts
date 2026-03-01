/**
 * ObservationCompiler enrichment tests (Task 7)
 *
 * Tests that context injection correctly handles enrichment fields:
 * - Excludes superseded observations (non-NULL supersedes_id)
 * - Sorts pinned observations before non-pinned at same priority
 * - Returns enrichment fields in Observation objects
 * - Increments access_count after query
 * - Backward compat: observations with NULL enrichment fields still returned
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { queryObservations, queryObservationsMulti } from '../../src/services/context/ObservationCompiler.js';
import type { ContextConfig } from '../../src/services/context/types.js';

// ---------------------------------------------------------------------------
// Test DB setup
// ---------------------------------------------------------------------------

function createTestDb() {
  const innerDb = new Database(':memory:');
  innerDb.pragma('journal_mode = WAL');

  innerDb.exec(`
    CREATE TABLE observations (
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

  return innerDb;
}

function insertObservation(
  innerDb: Database.Database,
  overrides: Partial<Record<string, unknown>> = {}
) {
  const defaults = {
    memory_session_id: 'sess-1',
    project: 'test-proj',
    type: 'discovery',
    title: 'Test obs',
    subtitle: null,
    facts: '["fact-1"]',
    narrative: 'Test narrative',
    concepts: '["how-it-works"]',
    files_read: '[]',
    files_modified: '[]',
    prompt_number: 1,
    discovery_tokens: 100,
    read_tokens: 50,
    priority: 'informational',
    topics: null,
    entities: null,
    event_date: null,
    pinned: 0,
    access_count: 0,
    supersedes_id: null,
    created_at: new Date().toISOString(),
    created_at_epoch: Date.now(),
    ...overrides,
  };

  const cols = Object.keys(defaults).join(', ');
  const placeholders = Object.keys(defaults).map(() => '?').join(', ');
  const stmt = innerDb.prepare(`INSERT INTO observations (${cols}) VALUES (${placeholders})`);
  const result = stmt.run(...Object.values(defaults));
  return Number(result.lastInsertRowid);
}

const defaultConfig: ContextConfig = {
  observationTypes: new Set(['discovery', 'decision', 'bugfix']),
  observationConcepts: new Set(['how-it-works']),
  totalObservationCount: 50,
};

// Wrap raw DB as SessionStore-like object
function wrapDb(innerDb: Database.Database) {
  return { db: innerDb } as { db: Database.Database };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

let innerDb: Database.Database;

beforeEach(() => {
  innerDb = createTestDb();
});

afterEach(() => {
  innerDb.close();
});

describe('queryObservations — superseded exclusion', () => {
  it('should exclude observations with non-NULL supersedes_id', () => {
    insertObservation(innerDb, { title: 'Active obs', supersedes_id: null });
    insertObservation(innerDb, { title: 'Superseded obs', supersedes_id: 'obs-123' });

    const results = queryObservations(wrapDb(innerDb) as any, 'test-proj', defaultConfig);
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('Active obs');
  });
});

describe('queryObservations — pinned sorting', () => {
  it('should sort pinned observations before non-pinned at same priority', () => {
    const now = Date.now();
    insertObservation(innerDb, {
      title: 'Non-pinned',
      pinned: 0,
      priority: 'informational',
      created_at_epoch: now - 1000,
    });
    insertObservation(innerDb, {
      title: 'Pinned',
      pinned: 1,
      priority: 'informational',
      created_at_epoch: now - 2000,
    });

    const results = queryObservations(wrapDb(innerDb) as any, 'test-proj', defaultConfig);
    expect(results).toHaveLength(2);
    expect(results[0].title).toBe('Pinned');
    expect(results[1].title).toBe('Non-pinned');
  });
});

describe('queryObservations — enrichment fields returned', () => {
  it('should return topics, entities, event_date, pinned, access_count, supersedes_id', () => {
    insertObservation(innerDb, {
      topics: '["auth","migration"]',
      entities: '[{"name":"Alice","type":"person"}]',
      event_date: '2026-03-15',
      pinned: 1,
      access_count: 5,
    });

    const results = queryObservations(wrapDb(innerDb) as any, 'test-proj', defaultConfig);
    expect(results).toHaveLength(1);
    expect(results[0].topics).toBe('["auth","migration"]');
    expect(results[0].entities).toBe('[{"name":"Alice","type":"person"}]');
    expect(results[0].event_date).toBe('2026-03-15');
    expect(results[0].pinned).toBe(1);
    expect(results[0].access_count).toBe(5);
    expect(results[0].supersedes_id).toBeNull();
  });
});

describe('queryObservations — backward compat', () => {
  it('should return observations with NULL enrichment fields', () => {
    insertObservation(innerDb, {
      topics: null,
      entities: null,
      event_date: null,
    });

    const results = queryObservations(wrapDb(innerDb) as any, 'test-proj', defaultConfig);
    expect(results).toHaveLength(1);
    expect(results[0].topics).toBeNull();
    expect(results[0].entities).toBeNull();
    expect(results[0].event_date).toBeNull();
  });
});

describe('queryObservationsMulti — enrichment support', () => {
  it('should exclude superseded and include enrichment fields', () => {
    insertObservation(innerDb, {
      title: 'Active multi',
      project: 'test-proj',
      topics: '["deploy"]',
    });
    insertObservation(innerDb, {
      title: 'Superseded multi',
      project: 'test-proj',
      supersedes_id: 'old-obs',
    });

    const results = queryObservationsMulti(wrapDb(innerDb) as any, ['test-proj'], defaultConfig);
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('Active multi');
    expect(results[0].topics).toBe('["deploy"]');
  });
});

describe('queryObservations — access_count increment', () => {
  it('should increment access_count after query', async () => {
    const obsId = insertObservation(innerDb, { access_count: 0 });

    queryObservations(wrapDb(innerDb) as any, 'test-proj', defaultConfig);

    // access_count increment is fire-and-forget via setImmediate
    // Wait a tick for the async update to execute
    await new Promise(resolve => setImmediate(resolve));

    const row = innerDb.prepare('SELECT access_count FROM observations WHERE id = ?').get(obsId) as { access_count: number };
    expect(row.access_count).toBe(1);
  });
});
