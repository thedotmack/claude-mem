
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

describe('Transactions Module', () => {
  let dbWrapper: ClaudeMemDatabase;
  let db: ClaudeMemDatabase['db'];

  beforeEach(() => {
    dbWrapper = new ClaudeMemDatabase(':memory:');
    db = dbWrapper.db;
  });

  afterEach(() => {
    db.close();
  });

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

  function createSessionWithMemoryId(contentSessionId: string, memorySessionId: string, project: string = 'test-project'): { memorySessionId: string; sessionDbId: number } {
    const sessionDbId = createSDKSession(db, contentSessionId, project, 'initial prompt');
    updateMemorySessionId(db, sessionDbId, memorySessionId);
    return { memorySessionId, sessionDbId };
  }

  describe('storeObservations', () => {
    it('should store multiple observations atomically and return result', async () => {
      const { memorySessionId } = createSessionWithMemoryId('content-atomic-123', 'atomic-session-123');
      const project = 'test-project';
      const observations = [
        createObservationInput({ title: 'Obs 1' }),
        createObservationInput({ title: 'Obs 2' }),
        createObservationInput({ title: 'Obs 3' }),
      ];

      const result = await storeObservations(dbWrapper, memorySessionId, project, observations, null);

      expect(result.observationIds).toHaveLength(3);
      expect(result.observationIds.every((id) => typeof id === 'number')).toBe(true);
      expect(result.summaryId).toBeNull();
      expect(typeof result.createdAtEpoch).toBe('number');
    });

    it('should store all observations with same timestamp', async () => {
      const { memorySessionId } = createSessionWithMemoryId('content-ts', 'timestamp-session');
      const project = 'test-project';
      const observations = [
        createObservationInput({ title: 'Obs A' }),
        createObservationInput({ title: 'Obs B' }),
      ];
      const fixedTimestamp = 1600000000000;

      const result = await storeObservations(
        dbWrapper,
        memorySessionId,
        project,
        observations,
        null,
        1,
        0,
        fixedTimestamp
      );

      expect(result.createdAtEpoch).toBe(fixedTimestamp);

      for (const id of result.observationIds) {
        const obs = getObservationById(db, id);
        expect(obs?.created_at_epoch).toBe(fixedTimestamp);
      }
    });

    it('should store observations with summary', async () => {
      const { memorySessionId } = createSessionWithMemoryId('content-with-sum', 'with-summary-session');
      const project = 'test-project';
      const observations = [createObservationInput({ title: 'Main Obs' })];
      const summary = createSummaryInput({ request: 'Test request' });

      const result = await storeObservations(dbWrapper, memorySessionId, project, observations, summary);

      expect(result.observationIds).toHaveLength(1);
      expect(result.summaryId).not.toBeNull();
      expect(typeof result.summaryId).toBe('number');

      const storedSummary = getSummaryForSession(db, memorySessionId);
      expect(storedSummary).not.toBeNull();
      expect(storedSummary?.request).toBe('Test request');
    });

    it('should handle empty observations array', async () => {
      const { memorySessionId } = createSessionWithMemoryId('content-empty', 'empty-obs-session');
      const project = 'test-project';
      const observations: ObservationInput[] = [];

      const result = await storeObservations(dbWrapper, memorySessionId, project, observations, null);

      expect(result.observationIds).toHaveLength(0);
      expect(result.summaryId).toBeNull();
    });

    it('should handle summary-only (no observations)', async () => {
      const { memorySessionId } = createSessionWithMemoryId('content-sum-only', 'summary-only-session');
      const project = 'test-project';
      const summary = createSummaryInput({ request: 'Summary-only request' });

      const result = await storeObservations(dbWrapper, memorySessionId, project, [], summary);

      expect(result.observationIds).toHaveLength(0);
      expect(result.summaryId).not.toBeNull();

      const storedSummary = getSummaryForSession(db, memorySessionId);
      expect(storedSummary?.request).toBe('Summary-only request');
    });

    it('should return correct createdAtEpoch', async () => {
      const { memorySessionId } = createSessionWithMemoryId('content-epoch', 'session-epoch');
      const before = Date.now();
      const result = await storeObservations(
        dbWrapper,
        memorySessionId,
        'project',
        [createObservationInput()],
        null
      );
      const after = Date.now();

      expect(result.createdAtEpoch).toBeGreaterThanOrEqual(before);
      expect(result.createdAtEpoch).toBeLessThanOrEqual(after);
    });

    it('should apply promptNumber to all observations', async () => {
      const { memorySessionId } = createSessionWithMemoryId('content-pn', 'prompt-num-session');
      const project = 'test-project';
      const observations = [
        createObservationInput({ title: 'Obs 1' }),
        createObservationInput({ title: 'Obs 2' }),
      ];
      const promptNumber = 5;

      const result = await storeObservations(
        dbWrapper,
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

    it('dedups by content_hash across separate calls — same (sessionId, title, narrative) returns same id', async () => {
      const { memorySessionId } = createSessionWithMemoryId('content-dedup', 'session-dedup');
      const project = 'test-project';
      const observation = createObservationInput({
        title: 'Identical Title',
        narrative: 'Identical narrative content for dedup test',
      });

      const first = await storeObservations(dbWrapper, memorySessionId, project, [observation], null);
      const second = await storeObservations(dbWrapper, memorySessionId, project, [observation], null);

      expect(first.observationIds).toHaveLength(1);
      expect(second.observationIds).toHaveLength(1);
      // Critical: dedup-by-content-hash must yield the same row id across
      // calls. This is the load-bearing semantic preserved by the libSQL
      // conversion (PHASE_1_HANDOFF.md §2 Step 2).
      expect(second.observationIds[0]).toBe(first.observationIds[0]);
    });
  });

  describe('storeObservationsAndMarkComplete', () => {

    it('should store observations, summary, and mark message complete', async () => {
      const { memorySessionId, sessionDbId } = createSessionWithMemoryId('content-complete', 'complete-session');
      const project = 'test-project';
      const observations = [createObservationInput({ title: 'Complete Obs' })];
      const summary = createSummaryInput({ request: 'Complete request' });

      const insertStmt = db.prepare(`
        INSERT INTO pending_messages
        (session_db_id, content_session_id, message_type, created_at_epoch, status)
        VALUES (?, ?, 'observation', ?, 'processing')
      `);
      const msgResult = insertStmt.run(sessionDbId, 'content-complete', Date.now());
      const messageId = Number(msgResult.lastInsertRowid);

      const result = await storeObservationsAndMarkComplete(
        dbWrapper,
        memorySessionId,
        project,
        observations,
        summary,
        messageId
      );

      expect(result.observationIds).toHaveLength(1);
      expect(result.summaryId).not.toBeNull();

      const msgStmt = db.prepare('SELECT status FROM pending_messages WHERE id = ?');
      const msg = msgStmt.get(messageId) as { status: string } | undefined;
      expect(msg?.status).toBe('processed');
    });

    it('should maintain atomicity - all operations share same timestamp', async () => {
      const { memorySessionId, sessionDbId } = createSessionWithMemoryId('content-atomic-ts', 'atomic-timestamp-session');
      const project = 'test-project';
      const observations = [
        createObservationInput({ title: 'Obs 1' }),
        createObservationInput({ title: 'Obs 2' }),
      ];
      const summary = createSummaryInput();
      const fixedTimestamp = 1700000000000;

      db.prepare(`
        INSERT INTO pending_messages
        (session_db_id, content_session_id, message_type, created_at_epoch, status)
        VALUES (?, ?, 'observation', ?, 'processing')
      `).run(sessionDbId, 'content-atomic-ts', Date.now());
      const messageId = db.prepare('SELECT last_insert_rowid() as id').get() as { id: number };

      const result = await storeObservationsAndMarkComplete(
        dbWrapper,
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

      for (const id of result.observationIds) {
        const obs = getObservationById(db, id);
        expect(obs?.created_at_epoch).toBe(fixedTimestamp);
      }

      const storedSummary = getSummaryForSession(db, memorySessionId);
      expect(storedSummary?.created_at_epoch).toBe(fixedTimestamp);
    });

    it('should handle null summary', async () => {
      const { memorySessionId, sessionDbId } = createSessionWithMemoryId('content-no-sum', 'no-summary-session');
      const project = 'test-project';
      const observations = [createObservationInput({ title: 'Only Obs' })];

      db.prepare(`
        INSERT INTO pending_messages
        (session_db_id, content_session_id, message_type, created_at_epoch, status)
        VALUES (?, ?, 'observation', ?, 'processing')
      `).run(sessionDbId, 'content-no-sum', Date.now());
      const messageId = db.prepare('SELECT last_insert_rowid() as id').get() as { id: number };

      const result = await storeObservationsAndMarkComplete(
        dbWrapper,
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
