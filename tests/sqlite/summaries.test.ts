/**
 * Summaries module tests
 * Tests modular summary functions with in-memory database
 *
 * Sources:
 * - API patterns from src/services/sqlite/summaries/store.ts
 * - API patterns from src/services/sqlite/summaries/get.ts
 * - Type definitions from src/services/sqlite/summaries/types.ts
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { ClaudeMemDatabase } from '../../src/services/sqlite/Database.js';
import {
  storeSummary,
  getSummaryForSession,
} from '../../src/services/sqlite/Summaries.js';
import {
  createSDKSession,
  updateMemorySessionId,
} from '../../src/services/sqlite/Sessions.js';
import type { SummaryInput } from '../../src/services/sqlite/summaries/types.js';
import type { Database } from 'bun:sqlite';

describe('Summaries Module', () => {
  let db: Database;

  beforeEach(() => {
    db = new ClaudeMemDatabase(':memory:').db;
  });

  afterEach(() => {
    db.close();
  });

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
  function createSessionWithMemoryId(contentSessionId: string, memorySessionId: string, project: string = 'test-project'): string {
    const sessionId = createSDKSession(db, contentSessionId, project, 'initial prompt');
    updateMemorySessionId(db, sessionId, memorySessionId);
    return memorySessionId;
  }

  describe('storeSummary', () => {
    it('should store summary and return id and createdAtEpoch', () => {
      const memorySessionId = createSessionWithMemoryId('content-sum-123', 'mem-session-sum-123');
      const project = 'test-project';
      const summary = createSummaryInput();

      const result = storeSummary(db, memorySessionId, project, summary);

      expect(typeof result.id).toBe('number');
      expect(result.id).toBeGreaterThan(0);
      expect(typeof result.createdAtEpoch).toBe('number');
      expect(result.createdAtEpoch).toBeGreaterThan(0);
    });

    it('should store all summary fields correctly', () => {
      const memorySessionId = createSessionWithMemoryId('content-sum-456', 'mem-session-sum-456');
      const project = 'test-project';
      const summary = createSummaryInput({
        request: 'Refactor the database layer',
        investigated: 'Analyzed current schema',
        learned: 'Found N+1 query issues',
        completed: 'Optimized queries',
        next_steps: 'Monitor performance',
        notes: 'May need caching',
      });

      const result = storeSummary(db, memorySessionId, project, summary, 1, 500);

      const stored = getSummaryForSession(db, memorySessionId);
      expect(stored).not.toBeNull();
      expect(stored?.request).toBe('Refactor the database layer');
      expect(stored?.investigated).toBe('Analyzed current schema');
      expect(stored?.learned).toBe('Found N+1 query issues');
      expect(stored?.completed).toBe('Optimized queries');
      expect(stored?.next_steps).toBe('Monitor performance');
      expect(stored?.notes).toBe('May need caching');
      expect(stored?.prompt_number).toBe(1);
    });

    it('should respect overrideTimestampEpoch', () => {
      const memorySessionId = createSessionWithMemoryId('content-sum-789', 'mem-session-sum-789');
      const project = 'test-project';
      const summary = createSummaryInput();
      const pastTimestamp = 1650000000000; // Apr 15, 2022

      const result = storeSummary(
        db,
        memorySessionId,
        project,
        summary,
        1,
        0,
        pastTimestamp
      );

      expect(result.createdAtEpoch).toBe(pastTimestamp);

      const stored = getSummaryForSession(db, memorySessionId);
      expect(stored?.created_at_epoch).toBe(pastTimestamp);
    });

    it('should use current time when overrideTimestampEpoch not provided', () => {
      const memorySessionId = createSessionWithMemoryId('content-sum-now', 'session-sum-now');
      const before = Date.now();
      const result = storeSummary(
        db,
        memorySessionId,
        'project',
        createSummaryInput()
      );
      const after = Date.now();

      expect(result.createdAtEpoch).toBeGreaterThanOrEqual(before);
      expect(result.createdAtEpoch).toBeLessThanOrEqual(after);
    });

    it('should handle null notes', () => {
      const memorySessionId = createSessionWithMemoryId('content-sum-null', 'session-sum-null');
      const summary = createSummaryInput({ notes: null });

      const result = storeSummary(db, memorySessionId, 'project', summary);
      const stored = getSummaryForSession(db, memorySessionId);

      expect(stored).not.toBeNull();
      expect(stored?.notes).toBeNull();
    });
  });

  describe('getSummaryForSession', () => {
    it('should retrieve summary by memory_session_id', () => {
      const memorySessionId = createSessionWithMemoryId('content-unique', 'unique-mem-session');
      const summary = createSummaryInput({ request: 'Unique request' });

      storeSummary(db, memorySessionId, 'project', summary);

      const retrieved = getSummaryForSession(db, memorySessionId);

      expect(retrieved).not.toBeNull();
      expect(retrieved?.request).toBe('Unique request');
    });

    it('should return null for session with no summary', () => {
      const retrieved = getSummaryForSession(db, 'nonexistent-session');

      expect(retrieved).toBeNull();
    });

    it('should return most recent summary when multiple exist', () => {
      const memorySessionId = createSessionWithMemoryId('content-multi', 'multi-summary-session');

      // Store older summary
      storeSummary(
        db,
        memorySessionId,
        'project',
        createSummaryInput({ request: 'First request' }),
        1,
        0,
        1000000000000
      );

      // Store newer summary
      storeSummary(
        db,
        memorySessionId,
        'project',
        createSummaryInput({ request: 'Second request' }),
        2,
        0,
        2000000000000
      );

      const retrieved = getSummaryForSession(db, memorySessionId);

      expect(retrieved).not.toBeNull();
      expect(retrieved?.request).toBe('Second request');
      expect(retrieved?.prompt_number).toBe(2);
    });

    it('should return summary with all expected fields', () => {
      const memorySessionId = createSessionWithMemoryId('content-fields', 'fields-check-session');
      const summary = createSummaryInput();

      storeSummary(db, memorySessionId, 'project', summary, 1, 100, 1500000000000);

      const retrieved = getSummaryForSession(db, memorySessionId);

      expect(retrieved).not.toBeNull();
      expect(retrieved).toHaveProperty('request');
      expect(retrieved).toHaveProperty('investigated');
      expect(retrieved).toHaveProperty('learned');
      expect(retrieved).toHaveProperty('completed');
      expect(retrieved).toHaveProperty('next_steps');
      expect(retrieved).toHaveProperty('notes');
      expect(retrieved).toHaveProperty('prompt_number');
      expect(retrieved).toHaveProperty('created_at');
      expect(retrieved).toHaveProperty('created_at_epoch');
    });
  });
});
