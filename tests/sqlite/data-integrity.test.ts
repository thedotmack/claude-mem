
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { ClaudeMemDatabase } from '../../src/services/sqlite/Database.js';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import {
  storeObservation,
  computeObservationContentHash,
} from '../../src/services/sqlite/observations/store.js';
import {
  createSDKSession,
  updateMemorySessionId,
} from '../../src/services/sqlite/Sessions.js';
import { storeObservations } from '../../src/services/sqlite/transactions.js';
import type { ObservationInput } from '../../src/services/sqlite/observations/types.js';
import { Database } from 'bun:sqlite';

function createObservationInput(overrides: Partial<ObservationInput> = {}): ObservationInput {
  return {
    type: 'discovery',
    title: 'Test Observation',
    subtitle: 'Test Subtitle',
    facts: ['fact1', 'fact2'],
    narrative: 'Test narrative content',
    concepts: ['concept1', 'concept2'],
    files_read: ['/path/to/file1.ts'],
    files_modified: ['/path/to/file2.ts'],
    ...overrides,
  };
}

function createSessionWithMemoryId(db: Database, contentSessionId: string, memorySessionId: string, project: string = 'test-project'): string {
  const sessionId = createSDKSession(db, contentSessionId, project, 'initial prompt');
  updateMemorySessionId(db, sessionId, memorySessionId);
  return memorySessionId;
}

function seedLegacyContentHashScenario(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS schema_versions (
      id INTEGER PRIMARY KEY,
      version INTEGER UNIQUE NOT NULL,
      applied_at TEXT NOT NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS sdk_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content_session_id TEXT UNIQUE NOT NULL,
      memory_session_id TEXT UNIQUE,
      project TEXT NOT NULL,
      platform_source TEXT NOT NULL DEFAULT 'claude',
      user_prompt TEXT,
      started_at TEXT NOT NULL,
      started_at_epoch INTEGER NOT NULL,
      completed_at TEXT,
      completed_at_epoch INTEGER,
      status TEXT CHECK(status IN ('active', 'completed', 'failed')) NOT NULL DEFAULT 'active'
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS observations (
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
      created_at TEXT NOT NULL,
      created_at_epoch INTEGER NOT NULL,
      content_hash TEXT,
      FOREIGN KEY(memory_session_id) REFERENCES sdk_sessions(memory_session_id) ON DELETE CASCADE
    )
  `);

  const now = new Date().toISOString();
  const epoch = Date.now();
  db.prepare(`
    INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
    VALUES (?, ?, ?, ?, ?, 'active')
  `).run('content-a', 'session-a', 'legacy-project', now, epoch);
  db.prepare(`
    INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
    VALUES (?, ?, ?, ?, ?, 'active')
  `).run('content-b', 'session-b', 'legacy-project', now, epoch + 1);

  db.prepare('INSERT INTO schema_versions (version, applied_at) VALUES (?, ?)').run(22, now);

  db.prepare(`
    INSERT INTO observations (memory_session_id, project, type, created_at, created_at_epoch, content_hash)
    VALUES (?, ?, 'discovery', ?, ?, ?)
  `).run('session-a', 'legacy-project', now, epoch, null);
  db.prepare(`
    INSERT INTO observations (memory_session_id, project, type, created_at, created_at_epoch, content_hash)
    VALUES (?, ?, 'discovery', ?, ?, ?)
  `).run('session-a', 'legacy-project', now, epoch + 1, null);
  db.prepare(`
    INSERT INTO observations (memory_session_id, project, type, created_at, created_at_epoch, content_hash)
    VALUES (?, ?, 'discovery', ?, ?, ?)
  `).run('session-a', 'legacy-project', now, epoch + 2, null);
  db.prepare(`
    INSERT INTO observations (memory_session_id, project, type, created_at, created_at_epoch, content_hash)
    VALUES (?, ?, 'discovery', ?, ?, ?)
  `).run('session-b', 'legacy-project', now, epoch + 3, null);
  db.prepare(`
    INSERT INTO observations (memory_session_id, project, type, created_at, created_at_epoch, content_hash)
    VALUES (?, ?, 'discovery', ?, ?, ?)
  `).run('session-b', 'legacy-project', now, epoch + 4, null);
  db.prepare(`
    INSERT INTO observations (memory_session_id, project, type, created_at, created_at_epoch, content_hash)
    VALUES (?, ?, 'discovery', ?, ?, ?)
  `).run('session-a', 'legacy-project', now, epoch + 5, 'non-null-duplicate');
  db.prepare(`
    INSERT INTO observations (memory_session_id, project, type, created_at, created_at_epoch, content_hash)
    VALUES (?, ?, 'discovery', ?, ?, ?)
  `).run('session-a', 'legacy-project', now, epoch + 6, 'non-null-duplicate');
}

describe('TRIAGE-03: Data Integrity', () => {
  let db: Database;

  beforeEach(() => {
    db = new ClaudeMemDatabase(':memory:').db;
  });

  afterEach(() => {
    db.close();
  });

  describe('Content-hash deduplication', () => {
    it('computeObservationContentHash produces consistent hashes', () => {
      const hash1 = computeObservationContentHash('session-1', 'Title A', 'Narrative A');
      const hash2 = computeObservationContentHash('session-1', 'Title A', 'Narrative A');
      expect(hash1).toBe(hash2);
      expect(hash1.length).toBe(16);
    });

    it('computeObservationContentHash produces different hashes for different content', () => {
      const hash1 = computeObservationContentHash('session-1', 'Title A', 'Narrative A');
      const hash2 = computeObservationContentHash('session-1', 'Title B', 'Narrative B');
      expect(hash1).not.toBe(hash2);
    });

    it('computeObservationContentHash handles nulls', () => {
      const hash = computeObservationContentHash('session-1', null, null);
      expect(hash.length).toBe(16);
    });

    it('computeObservationContentHash avoids collision from field boundary ambiguity', () => {
      const hash1 = computeObservationContentHash('session-abc', 'debug log', '');
      const hash2 = computeObservationContentHash('session-ab', 'cdebug log', '');
      const hash3 = computeObservationContentHash('session-', 'abcdebug log', '');
      const hash4 = computeObservationContentHash('', 'session-abcdebug log', '');
      const hashes = new Set([hash1, hash2, hash3, hash4]);
      expect(hashes.size).toBe(4);
    });

    it('storeObservation deduplicates identical observations within 30s window', () => {
      const memId = createSessionWithMemoryId(db, 'content-dedup-1', 'mem-dedup-1');
      const obs = createObservationInput({ title: 'Same Title', narrative: 'Same Narrative' });

      const now = Date.now();
      const result1 = storeObservation(db, memId, 'test-project', obs, 1, 0, now);
      const result2 = storeObservation(db, memId, 'test-project', obs, 1, 0, now + 1000);

      expect(result2.id).toBe(result1.id);
    });

    it('storeObservation deduplicates identical content regardless of time gap (UNIQUE constraint)', () => {
      const memId = createSessionWithMemoryId(db, 'content-dedup-2', 'mem-dedup-2');
      const obs = createObservationInput({ title: 'Same Title', narrative: 'Same Narrative' });

      const now = Date.now();
      const result1 = storeObservation(db, memId, 'test-project', obs, 1, 0, now);
      const result2 = storeObservation(db, memId, 'test-project', obs, 1, 0, now + 31_000);

      expect(result2.id).toBe(result1.id);
    });

    it('storeObservation allows different content at same time', () => {
      const memId = createSessionWithMemoryId(db, 'content-dedup-3', 'mem-dedup-3');
      const obs1 = createObservationInput({ title: 'Title A', narrative: 'Narrative A' });
      const obs2 = createObservationInput({ title: 'Title B', narrative: 'Narrative B' });

      const now = Date.now();
      const result1 = storeObservation(db, memId, 'test-project', obs1, 1, 0, now);
      const result2 = storeObservation(db, memId, 'test-project', obs2, 1, 0, now);

      expect(result2.id).not.toBe(result1.id);
    });

    it('content_hash column is populated on new observations', () => {
      const memId = createSessionWithMemoryId(db, 'content-hash-col', 'mem-hash-col');
      const obs = createObservationInput();

      storeObservation(db, memId, 'test-project', obs);

      const row = db.prepare('SELECT content_hash FROM observations LIMIT 1').get() as { content_hash: string };
      expect(row.content_hash).toBeTruthy();
      expect(row.content_hash.length).toBe(16);
    });
  });

  describe('Transaction-level deduplication', () => {
    it('storeObservations deduplicates within a batch', () => {
      const memId = createSessionWithMemoryId(db, 'content-tx-1', 'mem-tx-1');
      const obs = createObservationInput({ title: 'Duplicate', narrative: 'Same content' });

      const result = storeObservations(db, memId, 'test-project', [obs, obs, obs], null);

      expect(result.observationIds.length).toBe(3);
      expect(result.observationIds[1]).toBe(result.observationIds[0]);
      expect(result.observationIds[2]).toBe(result.observationIds[0]);

      const count = db.prepare('SELECT COUNT(*) as count FROM observations').get() as { count: number };
      expect(count.count).toBe(1);
    });
  });

  describe('Empty project string guard', () => {
    it('storeObservation replaces empty project with cwd-derived name', () => {
      const memId = createSessionWithMemoryId(db, 'content-empty-proj', 'mem-empty-proj');
      const obs = createObservationInput();

      const result = storeObservation(db, memId, '', obs);
      const row = db.prepare('SELECT project FROM observations WHERE id = ?').get(result.id) as { project: string };

      expect(row.project).toBeTruthy();
      expect(row.project.length).toBeGreaterThan(0);
    });
  });

  describe('Migration parity', () => {
    it('SessionStore should preserve legacy NULL content_hash rows while deduplicating non-NULL duplicates', () => {
      const legacyDb = new Database(':memory:');
      try {
        seedLegacyContentHashScenario(legacyDb);
        new SessionStore(legacyDb);

        const totals = legacyDb.prepare('SELECT COUNT(*) as count FROM observations').get() as { count: number };
        expect(totals.count).toBe(6);

        const remainingNulls = legacyDb.prepare('SELECT COUNT(*) as count FROM observations WHERE content_hash IS NULL').get() as { count: number };
        expect(remainingNulls.count).toBe(0);

        const sessionANulls = legacyDb.prepare(`
          SELECT COUNT(*) as count
            FROM observations
           WHERE memory_session_id = 'session-a'
             AND content_hash GLOB '__null_migration_*__'
        `).get() as { count: number };
        expect(sessionANulls.count).toBe(3);

        const sessionBNulls = legacyDb.prepare(`
          SELECT COUNT(*) as count
            FROM observations
           WHERE memory_session_id = 'session-b'
             AND content_hash GLOB '__null_migration_*__'
        `).get() as { count: number };
        expect(sessionBNulls.count).toBe(2);

        const duplicateHashRows = legacyDb.prepare(`
          SELECT COUNT(*) as count
            FROM observations
           WHERE memory_session_id = 'session-a'
             AND content_hash = 'non-null-duplicate'
        `).get() as { count: number };
        expect(duplicateHashRows.count).toBe(1);
      } finally {
        legacyDb.close();
      }
    });
  });
});
