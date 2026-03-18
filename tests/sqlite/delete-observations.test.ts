/**
 * Observation deletion tests
 * Tests deleteObservations() with in-memory database
 *
 * Sources:
 * - API patterns from src/services/sqlite/observations/delete.ts
 * - Test patterns from tests/sqlite/observations.test.ts
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { ClaudeMemDatabase } from '../../src/services/sqlite/Database.js';
import {
  storeObservation,
  getObservationById,
} from '../../src/services/sqlite/Observations.js';
import { deleteObservations } from '../../src/services/sqlite/observations/delete.js';
import {
  createSDKSession,
  updateMemorySessionId,
} from '../../src/services/sqlite/Sessions.js';
import type { ObservationInput } from '../../src/services/sqlite/observations/types.js';
import type { Database } from 'bun:sqlite';

describe('deleteObservations', () => {
  let db: Database;

  beforeEach(() => {
    db = new ClaudeMemDatabase(':memory:').db;
  });

  afterEach(() => {
    db.close();
  });

  function createObservationInput(overrides: Partial<ObservationInput> = {}): ObservationInput {
    return {
      type: 'discovery',
      title: 'Test Observation',
      subtitle: 'Test Subtitle',
      facts: ['fact1'],
      narrative: 'Test narrative',
      concepts: ['concept1'],
      files_read: ['/path/to/file.ts'],
      files_modified: [],
      ...overrides,
    };
  }

  function createSessionWithMemoryId(contentId: string, memoryId: string): string {
    const sessionId = createSDKSession(db, contentId, 'test-project', 'prompt');
    updateMemorySessionId(db, sessionId, memoryId);
    return memoryId;
  }

  /** Store an observation and return its ID */
  function storeOne(memoryId: string, title: string): number {
    return storeObservation(
      db, memoryId, 'test-project',
      createObservationInput({ title }),
    ).id;
  }

  it('should delete existing observations and return their IDs', () => {
    const mem = createSessionWithMemoryId('c-1', 'mem-1');
    const id1 = storeOne(mem, 'obs-1');
    const id2 = storeOne(mem, 'obs-2');

    const result = deleteObservations(db, [id1, id2]);

    expect(result.deleted).toEqual([id1, id2]);
    expect(result.notFound).toEqual([]);
    // Verify they're actually gone
    expect(getObservationById(db, id1)).toBeNull();
    expect(getObservationById(db, id2)).toBeNull();
  });

  it('should report non-existent IDs in notFound', () => {
    const result = deleteObservations(db, [99999, 88888]);

    expect(result.deleted).toEqual([]);
    expect(result.notFound).toEqual([99999, 88888]);
  });

  it('should return early for empty array', () => {
    const result = deleteObservations(db, []);

    expect(result.deleted).toEqual([]);
    expect(result.notFound).toEqual([]);
  });

  it('should split mixed valid and invalid IDs correctly', () => {
    const mem = createSessionWithMemoryId('c-2', 'mem-2');
    const id1 = storeOne(mem, 'obs-a');
    const fakeId = 77777;

    const result = deleteObservations(db, [id1, fakeId]);

    expect(result.deleted).toEqual([id1]);
    expect(result.notFound).toEqual([fakeId]);
    expect(getObservationById(db, id1)).toBeNull();
  });

  it('should not affect other observations', () => {
    const mem = createSessionWithMemoryId('c-3', 'mem-3');
    const id1 = storeOne(mem, 'to-delete');
    const id2 = storeOne(mem, 'to-keep');

    deleteObservations(db, [id1]);

    expect(getObservationById(db, id1)).toBeNull();
    expect(getObservationById(db, id2)).not.toBeNull();
  });

  it('should remove deleted observations from FTS index', () => {
    // FTS is initialized by SessionSearch, not ClaudeMemDatabase.
    // Set up FTS table and trigger manually for this test.
    db.run(`
      CREATE VIRTUAL TABLE IF NOT EXISTS observations_fts USING fts5(
        title, subtitle, narrative, text, facts, concepts,
        content='observations', content_rowid='id'
      );
      CREATE TRIGGER IF NOT EXISTS observations_ai AFTER INSERT ON observations BEGIN
        INSERT INTO observations_fts(rowid, title, subtitle, narrative, text, facts, concepts)
        VALUES (new.id, new.title, new.subtitle, new.narrative, new.text, new.facts, new.concepts);
      END;
      CREATE TRIGGER IF NOT EXISTS observations_ad AFTER DELETE ON observations BEGIN
        INSERT INTO observations_fts(observations_fts, rowid, title, subtitle, narrative, text, facts, concepts)
        VALUES('delete', old.id, old.title, old.subtitle, old.narrative, old.text, old.facts, old.concepts);
      END;
    `);

    const mem = createSessionWithMemoryId('c-4', 'mem-4');
    const id = storeOne(mem, 'xyzuniqueobservation');

    // Verify FTS finds it before deletion
    const beforeDelete = db
      .prepare("SELECT rowid FROM observations_fts WHERE title MATCH 'xyzuniqueobservation'")
      .all();
    expect(beforeDelete.length).toBe(1);

    deleteObservations(db, [id]);

    // FTS trigger should have cleaned up
    const afterDelete = db
      .prepare("SELECT rowid FROM observations_fts WHERE title MATCH 'xyzuniqueobservation'")
      .all();
    expect(afterDelete.length).toBe(0);
  });
});
