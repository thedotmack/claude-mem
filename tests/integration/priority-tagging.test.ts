/**
 * Priority Tagging Integration Tests
 *
 * End-to-end flow: insert observations with different priorities via real
 * in-memory database → query via ObservationCompiler → verify priority-based
 * ordering (critical first, then important, then informational).
 *
 * Also verifies PaginationHelper includes priority in results.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { queryObservations } from '../../src/services/context/ObservationCompiler.js';
import { PaginationHelper } from '../../src/services/worker/PaginationHelper.js';
import type { DatabaseManager } from '../../src/services/worker/DatabaseManager.js';
import type { ContextConfig } from '../../src/services/context/types.js';
import type { Database } from '../../src/services/sqlite/sqlite-compat.js';
import type { MockInstance } from 'vitest';
import { logger } from '../../src/utils/logger.js';

// Suppress log output
let loggerSpies: MockInstance[] = [];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PROJECT = 'test-project';
const MEM_SESSION = 'mem-session-priority';
const CONTENT_SESSION = 'content-session-priority';

function createConfig(overrides: Partial<ContextConfig> = {}): ContextConfig {
  return {
    totalObservationCount: 50,
    fullObservationCount: 10,
    sessionCount: 5,
    showReadTokens: false,
    showWorkTokens: false,
    showSavingsAmount: false,
    showSavingsPercent: false,
    observationTypes: new Set(['discovery', 'bugfix', 'decision']),
    observationConcepts: new Set(['testing', 'architecture']),
    ...overrides,
  };
}

/** Insert a test observation with specified priority */
function insertObs(
  db: Database,
  priority: string,
  title: string,
  epoch: number,
  type = 'discovery',
): number {
  const result = db.prepare(`
    INSERT INTO observations
      (memory_session_id, project, type, priority, title, narrative,
       concepts, created_at, created_at_epoch)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    MEM_SESSION, PROJECT, type, priority, title,
    `Narrative for ${title}`,
    '["testing", "architecture"]',
    new Date(epoch).toISOString(),
    epoch,
  );
  return Number(result.lastInsertRowid);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Priority Tagging Integration', () => {
  let store: SessionStore;
  let db: Database;

  beforeEach(() => {
    loggerSpies = [
      vi.spyOn(logger, 'info').mockImplementation(() => {}),
      vi.spyOn(logger, 'debug').mockImplementation(() => {}),
      vi.spyOn(logger, 'warn').mockImplementation(() => {}),
      vi.spyOn(logger, 'error').mockImplementation(() => {}),
    ];

    store = new SessionStore(':memory:');
    db = store.db;

    // Seed an sdk_sessions row for FK constraints
    db.prepare(`
      INSERT INTO sdk_sessions
        (content_session_id, memory_session_id, project,
         started_at, started_at_epoch, status)
      VALUES (?, ?, ?, ?, ?, 'active')
    `).run(CONTENT_SESSION, MEM_SESSION, PROJECT, new Date().toISOString(), Date.now());
  });

  afterEach(() => {
    for (const spy of loggerSpies) spy.mockRestore();
    db.close();
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // ObservationCompiler ordering
  // -------------------------------------------------------------------------

  describe('queryObservations priority ordering', () => {
    it('returns critical observations before important and informational', () => {
      // Insert in reverse priority order (informational first) with same epoch
      const baseEpoch = 1700000000000;
      insertObs(db, 'informational', 'Info obs', baseEpoch);
      insertObs(db, 'important', 'Important obs', baseEpoch);
      insertObs(db, 'critical', 'Critical obs', baseEpoch);

      const results = queryObservations(store, PROJECT, createConfig());

      expect(results).toHaveLength(3);
      expect(results[0].title).toBe('Critical obs');
      expect(results[0].priority).toBe('critical');
      expect(results[1].title).toBe('Important obs');
      expect(results[1].priority).toBe('important');
      expect(results[2].title).toBe('Info obs');
      expect(results[2].priority).toBe('informational');
    });

    it('within same priority, orders by recency (newest first)', () => {
      insertObs(db, 'important', 'Older important', 1700000000000);
      insertObs(db, 'important', 'Newer important', 1700000001000);

      const results = queryObservations(store, PROJECT, createConfig());

      expect(results).toHaveLength(2);
      expect(results[0].title).toBe('Newer important');
      expect(results[1].title).toBe('Older important');
    });

    it('critical obs appear before newer informational obs', () => {
      // Critical obs is older than informational obs — critical should still come first
      insertObs(db, 'informational', 'New info', 1700000002000);
      insertObs(db, 'critical', 'Old critical', 1700000000000);

      const results = queryObservations(store, PROJECT, createConfig());

      expect(results).toHaveLength(2);
      expect(results[0].title).toBe('Old critical');
      expect(results[0].priority).toBe('critical');
      expect(results[1].title).toBe('New info');
      expect(results[1].priority).toBe('informational');
    });

    it('defaults to informational when priority column has NULL', () => {
      // Insert without specifying priority — column default kicks in
      db.prepare(`
        INSERT INTO observations
          (memory_session_id, project, type, title, concepts,
           created_at, created_at_epoch)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        MEM_SESSION, PROJECT, 'discovery', 'No-priority obs',
        '["testing"]', new Date().toISOString(), 1700000000000,
      );

      const results = queryObservations(store, PROJECT, createConfig());

      expect(results).toHaveLength(1);
      expect(results[0].priority).toBe('informational');
    });
  });

  // -------------------------------------------------------------------------
  // PaginationHelper includes priority
  // -------------------------------------------------------------------------

  describe('PaginationHelper priority field', () => {
    it('includes priority in paginated observation results', () => {
      insertObs(db, 'critical', 'Critical obs', 1700000000000);
      insertObs(db, 'informational', 'Info obs', 1700000001000);

      // PaginationHelper expects a DatabaseManager; provide a minimal shim
      const mockDbManager = { getSessionStore: () => store } as unknown as DatabaseManager;
      const pagination = new PaginationHelper(mockDbManager);
      const result = pagination.getObservations(0, 10, PROJECT);

      expect(result.items.length).toBeGreaterThanOrEqual(2);

      const critical = result.items.find(r => r.title === 'Critical obs');
      const info = result.items.find(r => r.title === 'Info obs');

      expect(critical).toBeDefined();
      expect(critical?.priority).toBe('critical');
      expect(info).toBeDefined();
      expect(info?.priority).toBe('informational');
    });
  });

  // -------------------------------------------------------------------------
  // Migration 25 column existence (lightweight check)
  // -------------------------------------------------------------------------

  describe('migration 25 (priority column)', () => {
    it('priority column exists in observations table after SessionStore init', () => {
      interface TableColumnInfo { name: string; type: string; }
      const columns = db.query('PRAGMA table_info(observations)').all() as TableColumnInfo[];
      const priorityCol = columns.find(c => c.name === 'priority');

      expect(priorityCol).toBeDefined();
      expect(priorityCol?.type).toBe('TEXT');
    });
  });
});
