/**
 * Transactions module tests
 * Tests atomic transaction functions with in-memory database
 *
 * Sources:
 * - API patterns from src/services/sqlite/transactions.ts
 * - Type definitions from src/services/sqlite/transactions.ts
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { ClaudeMemDatabase } from '../../src/services/sqlite/Database.js';
import {
  storeObservations,
  storeObservationsAndMarkComplete,
} from '../../src/services/sqlite/transactions.js';
import { getObservationById } from '../../src/services/sqlite/Observations.js';
import { getSummaryForSession } from '../../src/services/sqlite/Summaries.js';
import {
  createSDKSession,
  updateMemorySessionId,
} from '../../src/services/sqlite/Sessions.js';
import type { ObservationInput } from '../../src/services/sqlite/observations/types.js';
import type { SummaryInput } from '../../src/services/sqlite/summaries/types.js';
import type { Database } from 'bun:sqlite';

describe('Transactions Module', () => {
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

  // Helper to create a valid summary input
  function createSummaryInput(overrides: Partial<SummaryInput> = {}): SummaryInput {
    return {
      request: 'User requested feature X',
      investigated: 'Explored the codebase',
      learned: 'Discovered pattern Y',
      completed: 'Implemented feature X',
      next_steps: 'Add tests and documentation',
      notes: 'Consider edge case Z',
      ...overrides,
    };
  }

  // Helper to create a session and return memory_session_id for FK constraints
  function createSessionWithMemoryId(contentSessionId: string, memorySessionId: string, project: string = 'test-project'): { memorySessionId: string; sessionDbId: number } {
    const sessionDbId = createSDKSession(db, contentSessionId, project, 'initial prompt');
    updateMemorySessionId(db, sessionDbId, memorySessionId);
    return { memorySessionId, sessionDbId };
  }

  describe('storeObservations', () => {
    it('should store multiple observations atomically and return result', () => {
      const { memorySessionId } = createSessionWithMemoryId('content-atomic-123', 'atomic-session-123');
      const project = 'test-project';
      const observations = [
        createObservationInput({ title: 'Obs 1' }),
        createObservationInput({ title: 'Obs 2' }),
        createObservationInput({ title: 'Obs 3' }),
      ];

      const result = storeObservations(db, memorySessionId, project, observations, null);

      expect(result.observationIds).toHaveLength(3);
      expect(result.observationIds.every((id) => typeof id === 'number')).toBe(true);
      expect(result.summaryId).toBeNull();
      expect(typeof result.createdAtEpoch).toBe('number');
    });

    it('should store all observations with same timestamp', () => {
      const { memorySessionId } = createSessionWithMemoryId('content-ts', 'timestamp-session');
      const project = 'test-project';
      const observations = [
        createObservationInput({ title: 'Obs A' }),
        createObservationInput({ title: 'Obs B' }),
      ];
      const fixedTimestamp = 1600000000000;

      const result = storeObservations(
        db,
        memorySessionId,
        project,
        observations,
        null,
        1,
        0,
        fixedTimestamp
      );

      expect(result.createdAtEpoch).toBe(fixedTimestamp);

      // Verify each observation has the same timestamp
      for (const id of result.observationIds) {
        const obs = getObservationById(db, id);
        expect(obs?.created_at_epoch).toBe(fixedTimestamp);
      }
    });

    it('should store observations with summary', () => {
      const { memorySessionId } = createSessionWithMemoryId('content-with-sum', 'with-summary-session');
      const project = 'test-project';
      const observations = [createObservationInput({ title: 'Main Obs' })];
      const summary = createSummaryInput({ request: 'Test request' });

      const result = storeObservations(db, memorySessionId, project, observations, summary);

      expect(result.observationIds).toHaveLength(1);
      expect(result.summaryId).not.toBeNull();
      expect(typeof result.summaryId).toBe('number');

      // Verify summary was stored
      const storedSummary = getSummaryForSession(db, memorySessionId);
      expect(storedSummary).not.toBeNull();
      expect(storedSummary?.request).toBe('Test request');
    });

    it('should handle empty observations array', () => {
      const { memorySessionId } = createSessionWithMemoryId('content-empty', 'empty-obs-session');
      const project = 'test-project';
      const observations: ObservationInput[] = [];

      const result = storeObservations(db, memorySessionId, project, observations, null);

      expect(result.observationIds).toHaveLength(0);
      expect(result.summaryId).toBeNull();
    });

    it('should handle summary-only (no observations)', () => {
      const { memorySessionId } = createSessionWithMemoryId('content-sum-only', 'summary-only-session');
      const project = 'test-project';
      const summary = createSummaryInput({ request: 'Summary-only request' });

      const result = storeObservations(db, memorySessionId, project, [], summary);

      expect(result.observationIds).toHaveLength(0);
      expect(result.summaryId).not.toBeNull();

      const storedSummary = getSummaryForSession(db, memorySessionId);
      expect(storedSummary?.request).toBe('Summary-only request');
    });

    it('should return correct createdAtEpoch', () => {
      const { memorySessionId } = createSessionWithMemoryId('content-epoch', 'session-epoch');
      const before = Date.now();
      const result = storeObservations(
        db,
        memorySessionId,
        'project',
        [createObservationInput()],
        null
      );
      const after = Date.now();

      expect(result.createdAtEpoch).toBeGreaterThanOrEqual(before);
      expect(result.createdAtEpoch).toBeLessThanOrEqual(after);
    });

    it('should apply promptNumber to all observations', () => {
      const { memorySessionId } = createSessionWithMemoryId('content-pn', 'prompt-num-session');
      const project = 'test-project';
      const observations = [
        createObservationInput({ title: 'Obs 1' }),
        createObservationInput({ title: 'Obs 2' }),
      ];
      const promptNumber = 5;

      const result = storeObservations(
        db,
        memorySessionId,
        project,
        observations,
        null,
        promptNumber
      );

      for (const id of result.observationIds) {
        const obs = getObservationById(db, id);
        expect(obs?.prompt_number).toBe(promptNumber);
      }
    });
  });

  describe('storeObservationsAndMarkComplete', () => {
    // Note: This function also marks a pending message as processed.
    // For testing, we need a pending_messages row to exist first.

    it('should store observations, summary, and mark message complete', () => {
      const { memorySessionId, sessionDbId } = createSessionWithMemoryId('content-complete', 'complete-session');
      const project = 'test-project';
      const observations = [createObservationInput({ title: 'Complete Obs' })];
      const summary = createSummaryInput({ request: 'Complete request' });

      // First, insert a pending message to mark as complete
      const insertStmt = db.prepare(`
        INSERT INTO pending_messages
        (session_db_id, content_session_id, message_type, created_at_epoch, status)
        VALUES (?, ?, 'observation', ?, 'processing')
      `);
      const msgResult = insertStmt.run(sessionDbId, 'content-complete', Date.now());
      const messageId = Number(msgResult.lastInsertRowid);

      const result = storeObservationsAndMarkComplete(
        db,
        memorySessionId,
        project,
        observations,
        summary,
        messageId
      );

      expect(result.observationIds).toHaveLength(1);
      expect(result.summaryId).not.toBeNull();

      // Verify message was marked as processed
      const msgStmt = db.prepare('SELECT status FROM pending_messages WHERE id = ?');
      const msg = msgStmt.get(messageId) as { status: string } | undefined;
      expect(msg?.status).toBe('processed');
    });

    it('should maintain atomicity - all operations share same timestamp', () => {
      const { memorySessionId, sessionDbId } = createSessionWithMemoryId('content-atomic-ts', 'atomic-timestamp-session');
      const project = 'test-project';
      const observations = [
        createObservationInput({ title: 'Obs 1' }),
        createObservationInput({ title: 'Obs 2' }),
      ];
      const summary = createSummaryInput();
      const fixedTimestamp = 1700000000000;

      // Create pending message
      db.prepare(`
        INSERT INTO pending_messages
        (session_db_id, content_session_id, message_type, created_at_epoch, status)
        VALUES (?, ?, 'observation', ?, 'processing')
      `).run(sessionDbId, 'content-atomic-ts', Date.now());
      const messageId = db.prepare('SELECT last_insert_rowid() as id').get() as { id: number };

      const result = storeObservationsAndMarkComplete(
        db,
        memorySessionId,
        project,
        observations,
        summary,
        messageId.id,
        1,
        0,
        fixedTimestamp
      );

      expect(result.createdAtEpoch).toBe(fixedTimestamp);

      // All observations should have same timestamp
      for (const id of result.observationIds) {
        const obs = getObservationById(db, id);
        expect(obs?.created_at_epoch).toBe(fixedTimestamp);
      }

      // Summary should have same timestamp
      const storedSummary = getSummaryForSession(db, memorySessionId);
      expect(storedSummary?.created_at_epoch).toBe(fixedTimestamp);
    });

    it('should handle null summary', () => {
      const { memorySessionId, sessionDbId } = createSessionWithMemoryId('content-no-sum', 'no-summary-session');
      const project = 'test-project';
      const observations = [createObservationInput({ title: 'Only Obs' })];

      // Create pending message
      db.prepare(`
        INSERT INTO pending_messages
        (session_db_id, content_session_id, message_type, created_at_epoch, status)
        VALUES (?, ?, 'observation', ?, 'processing')
      `).run(sessionDbId, 'content-no-sum', Date.now());
      const messageId = db.prepare('SELECT last_insert_rowid() as id').get() as { id: number };

      const result = storeObservationsAndMarkComplete(
        db,
        memorySessionId,
        project,
        observations,
        null,
        messageId.id
      );

      expect(result.observationIds).toHaveLength(1);
      expect(result.summaryId).toBeNull();
    });
  });
});
