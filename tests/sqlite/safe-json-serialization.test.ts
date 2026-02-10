/**
 * Tests for safe JSON serialization in transactions (Issue #855)
 *
 * Verifies that malformed LLM responses (especially from Gemini) don't
 * corrupt the database. The safeJsonStringifyArray function should handle:
 * - Non-array values gracefully
 * - Non-string array elements
 * - Normal string arrays
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { ClaudeMemDatabase } from '../../src/services/sqlite/Database.js';
import { storeObservations } from '../../src/services/sqlite/transactions.js';
import { getObservationById } from '../../src/services/sqlite/Observations.js';
import {
  createSDKSession,
  updateMemorySessionId,
} from '../../src/services/sqlite/Sessions.js';
import type { ObservationInput } from '../../src/services/sqlite/observations/types.js';
import type { Database } from 'bun:sqlite';

describe('Safe JSON Serialization (Issue #855)', () => {
  let db: Database;

  beforeEach(() => {
    db = new ClaudeMemDatabase(':memory:').db;
  });

  afterEach(() => {
    db.close();
  });

  function createSession(): string {
    const sessionDbId = createSDKSession(db, 'content-855', 'test-project', 'test prompt');
    const memorySessionId = 'mem-855-test';
    updateMemorySessionId(db, sessionDbId, memorySessionId);
    return memorySessionId;
  }

  it('should store observations with normal string arrays', () => {
    const memorySessionId = createSession();
    const obs: ObservationInput = {
      type: 'discovery',
      title: 'Normal Test',
      subtitle: null,
      facts: ['fact1', 'fact2'],
      narrative: 'test narrative',
      concepts: ['concept1'],
      files_read: ['/path/file.ts'],
      files_modified: [],
    };

    const result = storeObservations(db, memorySessionId, 'test-project', [obs], null);
    expect(result.observationIds).toHaveLength(1);

    const stored = getObservationById(db, result.observationIds[0]);
    expect(stored).not.toBeNull();
    // Verify the JSON was stored correctly
    expect(JSON.parse(stored!.facts as string)).toEqual(['fact1', 'fact2']);
    expect(JSON.parse(stored!.concepts as string)).toEqual(['concept1']);
    expect(JSON.parse(stored!.files_read as string)).toEqual(['/path/file.ts']);
    expect(JSON.parse(stored!.files_modified as string)).toEqual([]);
  });

  it('should handle empty arrays gracefully', () => {
    const memorySessionId = createSession();
    const obs: ObservationInput = {
      type: 'discovery',
      title: 'Empty Arrays',
      subtitle: null,
      facts: [],
      narrative: null,
      concepts: [],
      files_read: [],
      files_modified: [],
    };

    const result = storeObservations(db, memorySessionId, 'test-project', [obs], null);
    expect(result.observationIds).toHaveLength(1);

    const stored = getObservationById(db, result.observationIds[0]);
    expect(JSON.parse(stored!.facts as string)).toEqual([]);
  });

  it('should handle non-string elements in arrays by converting to strings', () => {
    const memorySessionId = createSession();
    // Simulate malformed parser output where numbers end up in arrays
    const obs: ObservationInput = {
      type: 'discovery',
      title: 'Non-string elements',
      subtitle: null,
      facts: [123 as unknown as string, true as unknown as string, 'valid'],
      narrative: null,
      concepts: [],
      files_read: [],
      files_modified: [],
    };

    const result = storeObservations(db, memorySessionId, 'test-project', [obs], null);
    expect(result.observationIds).toHaveLength(1);

    const stored = getObservationById(db, result.observationIds[0]);
    const facts = JSON.parse(stored!.facts as string);
    // Non-string values should be converted to strings
    expect(facts).toEqual(['123', 'true', 'valid']);
  });

  it('should handle null summary fields without throwing', () => {
    const memorySessionId = createSession();
    const obs: ObservationInput = {
      type: 'discovery',
      title: 'Summary null test',
      subtitle: null,
      facts: [],
      narrative: null,
      concepts: [],
      files_read: [],
      files_modified: [],
    };

    // Summary with null fields (common from Gemini responses)
    const summary = {
      request: null as unknown as string,
      investigated: null as unknown as string,
      learned: 'something',
      completed: null as unknown as string,
      next_steps: null as unknown as string,
      notes: null,
    };

    const result = storeObservations(db, memorySessionId, 'test-project', [obs], summary);
    expect(result.summaryId).not.toBeNull();
  });
});
