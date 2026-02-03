/**
 * Observations module tests
 * Tests modular observation functions with in-memory database
 *
 * Sources:
 * - API patterns from src/services/sqlite/observations/store.ts
 * - API patterns from src/services/sqlite/observations/get.ts
 * - API patterns from src/services/sqlite/observations/recent.ts
 * - Type definitions from src/services/sqlite/observations/types.ts
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { ClaudeMemDatabase } from '../../src/services/sqlite/Database.js';
import {
  storeObservation,
  getObservationById,
  getRecentObservations,
} from '../../src/services/sqlite/Observations.js';
import {
  createSDKSession,
  updateMemorySessionId,
} from '../../src/services/sqlite/Sessions.js';
import { getRecentObservationsForSession } from '../../src/services/sqlite/observations/get.js';
import type { ObservationInput } from '../../src/services/sqlite/observations/types.js';
import type { Database } from 'bun:sqlite';

describe('Observations Module', () => {
  let db: Database;

  beforeEach(() => {
    db = new ClaudeMemDatabase(':memory:').db;
  });

  afterEach(() => {
    db.close();
  });

  // Helper to create a valid observation input
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

  // Helper to create a session and return memory_session_id for FK constraints
  function createSessionWithMemoryId(contentSessionId: string, memorySessionId: string, project: string = 'test-project'): string {
    const sessionId = createSDKSession(db, contentSessionId, project, 'initial prompt');
    updateMemorySessionId(db, sessionId, memorySessionId);
    return memorySessionId;
  }

  describe('storeObservation', () => {
    it('should store observation and return id and createdAtEpoch', () => {
      const memorySessionId = createSessionWithMemoryId('content-123', 'mem-session-123');
      const project = 'test-project';
      const observation = createObservationInput();

      const result = storeObservation(db, memorySessionId, project, observation);

      expect(typeof result.id).toBe('number');
      expect(result.id).toBeGreaterThan(0);
      expect(typeof result.createdAtEpoch).toBe('number');
      expect(result.createdAtEpoch).toBeGreaterThan(0);
    });

    it('should store all observation fields correctly', () => {
      const memorySessionId = createSessionWithMemoryId('content-456', 'mem-session-456');
      const project = 'test-project';
      const observation = createObservationInput({
        type: 'bugfix',
        title: 'Fixed critical bug',
        subtitle: 'Memory leak',
        facts: ['leak found', 'patched'],
        narrative: 'Fixed memory leak in parser',
        concepts: ['memory', 'gc'],
        files_read: ['/src/parser.ts'],
        files_modified: ['/src/parser.ts', '/tests/parser.test.ts'],
      });

      const result = storeObservation(db, memorySessionId, project, observation, 1, 100);

      const stored = getObservationById(db, result.id);
      expect(stored).not.toBeNull();
      expect(stored?.type).toBe('bugfix');
      expect(stored?.title).toBe('Fixed critical bug');
      expect(stored?.memory_session_id).toBe(memorySessionId);
      expect(stored?.project).toBe(project);
    });

    it('should respect overrideTimestampEpoch', () => {
      const memorySessionId = createSessionWithMemoryId('content-789', 'mem-session-789');
      const project = 'test-project';
      const observation = createObservationInput();
      const pastTimestamp = 1600000000000; // Sep 13, 2020

      const result = storeObservation(
        db,
        memorySessionId,
        project,
        observation,
        1,
        0,
        pastTimestamp
      );

      expect(result.createdAtEpoch).toBe(pastTimestamp);

      const stored = getObservationById(db, result.id);
      expect(stored?.created_at_epoch).toBe(pastTimestamp);
      // Verify ISO string matches epoch
      expect(new Date(stored!.created_at).getTime()).toBe(pastTimestamp);
    });

    it('should use current time when overrideTimestampEpoch not provided', () => {
      const memorySessionId = createSessionWithMemoryId('content-now', 'session-now');
      const before = Date.now();
      const result = storeObservation(
        db,
        memorySessionId,
        'project',
        createObservationInput()
      );
      const after = Date.now();

      expect(result.createdAtEpoch).toBeGreaterThanOrEqual(before);
      expect(result.createdAtEpoch).toBeLessThanOrEqual(after);
    });

    it('should handle null subtitle and narrative', () => {
      const memorySessionId = createSessionWithMemoryId('content-null', 'session-null');
      const observation = createObservationInput({
        subtitle: null,
        narrative: null,
      });

      const result = storeObservation(db, memorySessionId, 'project', observation);
      const stored = getObservationById(db, result.id);

      expect(stored).not.toBeNull();
      expect(stored?.id).toBe(result.id);
    });
  });

  describe('getObservationById', () => {
    it('should retrieve observation by ID', () => {
      const memorySessionId = createSessionWithMemoryId('content-get', 'session-get');
      const observation = createObservationInput({ title: 'Unique Title' });
      const result = storeObservation(db, memorySessionId, 'project', observation);

      const retrieved = getObservationById(db, result.id);

      expect(retrieved).not.toBeNull();
      expect(retrieved?.id).toBe(result.id);
      expect(retrieved?.title).toBe('Unique Title');
    });

    it('should return null for non-existent observation', () => {
      const retrieved = getObservationById(db, 99999);

      expect(retrieved).toBeNull();
    });
  });

  describe('getRecentObservations', () => {
    it('should return observations ordered by date DESC', () => {
      const project = 'test-project';

      // Create sessions and store observations with different timestamps (oldest first)
      const mem1 = createSessionWithMemoryId('content-1', 'session1', project);
      const mem2 = createSessionWithMemoryId('content-2', 'session2', project);
      const mem3 = createSessionWithMemoryId('content-3', 'session3', project);

      storeObservation(db, mem1, project, createObservationInput(), 1, 0, 1000000000000);
      storeObservation(db, mem2, project, createObservationInput(), 2, 0, 2000000000000);
      storeObservation(db, mem3, project, createObservationInput(), 3, 0, 3000000000000);

      const recent = getRecentObservations(db, project, 10);

      expect(recent.length).toBe(3);
      // Most recent first (DESC order)
      expect(recent[0].prompt_number).toBe(3);
      expect(recent[1].prompt_number).toBe(2);
      expect(recent[2].prompt_number).toBe(1);
    });

    it('should respect limit parameter', () => {
      const project = 'test-project';

      const mem1 = createSessionWithMemoryId('content-lim1', 'session-lim1', project);
      const mem2 = createSessionWithMemoryId('content-lim2', 'session-lim2', project);
      const mem3 = createSessionWithMemoryId('content-lim3', 'session-lim3', project);

      storeObservation(db, mem1, project, createObservationInput(), 1, 0, 1000000000000);
      storeObservation(db, mem2, project, createObservationInput(), 2, 0, 2000000000000);
      storeObservation(db, mem3, project, createObservationInput(), 3, 0, 3000000000000);

      const recent = getRecentObservations(db, project, 2);

      expect(recent.length).toBe(2);
    });

    it('should filter by project', () => {
      const memA1 = createSessionWithMemoryId('content-a1', 'session-a1', 'project-a');
      const memB1 = createSessionWithMemoryId('content-b1', 'session-b1', 'project-b');
      const memA2 = createSessionWithMemoryId('content-a2', 'session-a2', 'project-a');

      storeObservation(db, memA1, 'project-a', createObservationInput());
      storeObservation(db, memB1, 'project-b', createObservationInput());
      storeObservation(db, memA2, 'project-a', createObservationInput());

      const recentA = getRecentObservations(db, 'project-a', 10);
      const recentB = getRecentObservations(db, 'project-b', 10);

      expect(recentA.length).toBe(2);
      expect(recentB.length).toBe(1);
    });

    it('should return empty array for project with no observations', () => {
      const recent = getRecentObservations(db, 'nonexistent-project', 10);

      expect(recent).toEqual([]);
    });
  });

  describe('getRecentObservationsForSession', () => {
    it('should return recent observations for a specific session', () => {
      const memorySessionId = createSessionWithMemoryId('content-recent', 'mem-recent');
      const project = 'test-project';

      // Store 3 observations with explicit timestamps to ensure ordering
      storeObservation(db, memorySessionId, project, createObservationInput({ title: 'Obs 1' }), 1, 0, 1000);
      storeObservation(db, memorySessionId, project, createObservationInput({ title: 'Obs 2' }), 2, 0, 2000);
      storeObservation(db, memorySessionId, project, createObservationInput({ title: 'Obs 3' }), 3, 0, 3000);

      const recent = getRecentObservationsForSession(db, memorySessionId, 5);

      expect(recent.length).toBe(3);
      // Should be in reverse chronological order (DESC)
      expect(recent[0].title).toBe('Obs 3');
      expect(recent[1].title).toBe('Obs 2');
      expect(recent[2].title).toBe('Obs 1');
    });

    it('should respect limit parameter', () => {
      const memorySessionId = createSessionWithMemoryId('content-limit', 'mem-limit');
      const project = 'test-project';

      // Store 10 observations with explicit timestamps
      for (let i = 1; i <= 10; i++) {
        storeObservation(db, memorySessionId, project, createObservationInput({ title: `Obs ${i}` }), i, 0, i * 1000);
      }

      const recent = getRecentObservationsForSession(db, memorySessionId, 3);

      expect(recent.length).toBe(3);
      // Should return the most recent 3
      expect(recent[0].title).toBe('Obs 10');
      expect(recent[1].title).toBe('Obs 9');
      expect(recent[2].title).toBe('Obs 8');
    });

    it('should throw error for limit <= 0', () => {
      const memorySessionId = createSessionWithMemoryId('content-zero', 'mem-zero');

      expect(() => {
        getRecentObservationsForSession(db, memorySessionId, 0);
      }).toThrow('Invalid limit: 0');

      expect(() => {
        getRecentObservationsForSession(db, memorySessionId, -5);
      }).toThrow('Invalid limit: -5');
    });

    it('should throw error for limit > MAX_SAFE_LIMIT', () => {
      const memorySessionId = createSessionWithMemoryId('content-huge', 'mem-huge');

      expect(() => {
        getRecentObservationsForSession(db, memorySessionId, 1001);
      }).toThrow('Invalid limit: 1001');

      expect(() => {
        getRecentObservationsForSession(db, memorySessionId, 999999);
      }).toThrow('Invalid limit: 999999');
    });

    it('should return empty array for session with no observations', () => {
      const memorySessionId = createSessionWithMemoryId('content-empty', 'mem-empty');

      const recent = getRecentObservationsForSession(db, memorySessionId, 5);

      expect(recent).toEqual([]);
    });

    it('should only return observations for specified session', () => {
      const sessionA = createSessionWithMemoryId('content-a', 'mem-session-a');
      const sessionB = createSessionWithMemoryId('content-b', 'mem-session-b');
      const project = 'test-project';

      // Store observations for session A with explicit timestamps
      storeObservation(db, sessionA, project, createObservationInput({ title: 'Session A - 1' }), 1, 0, 1000);
      storeObservation(db, sessionA, project, createObservationInput({ title: 'Session A - 2' }), 2, 0, 2000);

      // Store observations for session B
      storeObservation(db, sessionB, project, createObservationInput({ title: 'Session B - 1' }), 1, 0, 3000);

      const recentA = getRecentObservationsForSession(db, sessionA, 10);
      const recentB = getRecentObservationsForSession(db, sessionB, 10);

      expect(recentA.length).toBe(2);
      expect(recentA[0].title).toBe('Session A - 2');
      expect(recentA[1].title).toBe('Session A - 1');

      expect(recentB.length).toBe(1);
      expect(recentB[0].title).toBe('Session B - 1');
    });

    it('should return observations with nullable type fields', () => {
      const memorySessionId = createSessionWithMemoryId('content-nullable', 'mem-nullable');
      const project = 'test-project';

      storeObservation(db, memorySessionId, project, createObservationInput({
        title: 'Test',
        subtitle: null,
        type: 'discovery'
      }));

      const recent = getRecentObservationsForSession(db, memorySessionId, 5);

      expect(recent.length).toBe(1);
      expect(recent[0].title).toBe('Test');
      expect(recent[0].subtitle).toBeNull();
      expect(recent[0].type).toBe('discovery');
    });
  });
});
