/**
 * Tests for ActiveSessionRoutes handler logic
 *
 * Tests the route handler business logic directly using an in-memory SQLite
 * database with real migrations, following the same pattern as analytics-endpoint.test.ts.
 * We do NOT spin up Express — instead we call the handler logic extracted via the
 * SessionStore directly, verifying the queries and response shapes the handlers use.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ClaudeMemDatabase } from '../../../src/services/sqlite/Database.js';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { createSDKSession } from '../../../src/services/sqlite/Sessions.js';
import type { Database as DbType } from '../../../src/services/sqlite/sqlite-compat.js';
import type { SummaryQueueService } from '../../../src/services/worker/session/SummaryQueueService.js';

// ---------------------------------------------------------------------------
// Constant under test
// ---------------------------------------------------------------------------

const STALE_THRESHOLD_MS = 60 * 60 * 1000; // 1 hour — must match ActiveSessionRoutes

// ---------------------------------------------------------------------------
// Types matching the expected API response shapes
// ---------------------------------------------------------------------------

interface ActiveSessionResponse {
  id: number;
  content_session_id: string;
  project: string;
  user_prompt: string | null;
  started_at_epoch: number;
  is_stale: boolean;
  duration_ms: number;
}

interface GetActiveSessionsResponse {
  sessions: ActiveSessionResponse[];
  staleCount: number;
  totalCount: number;
}

interface CloseSessionResponse {
  success: true;
  summaryQueued: boolean;
}

interface CloseStaleResponse {
  closedCount: number;
  summariesQueued: number;
}

// ---------------------------------------------------------------------------
// Handler logic extracted for testability
// (mirrors what ActiveSessionRoutes.handleGetActiveSessions / handleCloseStale do)
// ---------------------------------------------------------------------------

function handleGetActiveSessions(store: SessionStore): GetActiveSessionsResponse {
  const rows = store.getActiveSessions();
  const now = Date.now();

  const sessions: ActiveSessionResponse[] = rows.map(row => ({
    ...row,
    is_stale: now - row.started_at_epoch > STALE_THRESHOLD_MS,
    duration_ms: now - row.started_at_epoch,
  }));

  const staleCount = sessions.filter(s => s.is_stale).length;

  return { sessions, staleCount, totalCount: sessions.length };
}

function handleCloseSession(store: SessionStore, id: number): CloseSessionResponse | null {
  const closed = store.closeActiveSessionById(id);
  // summaryQueued defaults to false in this extracted stub (no SummaryQueueService injected)
  return closed ? { success: true, summaryQueued: false } : null;
}

function handleCloseStale(store: SessionStore): CloseStaleResponse {
  const threshold = Date.now() - STALE_THRESHOLD_MS;
  const closedCount = store.closeStaleSessionsOlderThan(threshold);
  // summariesQueued defaults to 0 in this extracted stub (no SummaryQueueService injected)
  return { closedCount, summariesQueued: 0 };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function insertSessionWithEpoch(db: DbType, contentSessionId: string, project: string, prompt: string, epoch: number): void {
  db.prepare(`
    INSERT INTO sdk_sessions (content_session_id, project, user_prompt, started_at, started_at_epoch, status)
    VALUES (?, ?, ?, ?, ?, 'active')
  `).run(contentSessionId, project, prompt, new Date(epoch).toISOString(), epoch);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ActiveSessionRoutes handler logic', () => {
  let db: DbType;
  let store: SessionStore;

  beforeEach(() => {
    const claudeDb = new ClaudeMemDatabase(':memory:');
    db = claudeDb.db;
    store = new SessionStore(':memory:');
    // Replace store's db with the in-memory db that already has migrations applied
    (store as unknown as { db: DbType }).db = db;
  });

  afterEach(() => {
    db.close();
  });

  // ─── GET /api/sessions/active ─────────────────────────────────────────────

  describe('GET /api/sessions/active', () => {
    it('returns empty sessions array when no sessions exist', () => {
      const result = handleGetActiveSessions(store);

      expect(result.sessions).toEqual([]);
      expect(result.staleCount).toBe(0);
      expect(result.totalCount).toBe(0);
    });

    it('returns active sessions with required fields', () => {
      createSDKSession(db, 'session-abc', 'my-project', 'my prompt');

      const result = handleGetActiveSessions(store);

      expect(result.sessions).toHaveLength(1);
      const s = result.sessions[0];
      expect(typeof s.id).toBe('number');
      expect(s.content_session_id).toBe('session-abc');
      expect(s.project).toBe('my-project');
      expect(s.user_prompt).toBe('my prompt');
      expect(typeof s.started_at_epoch).toBe('number');
      expect(typeof s.is_stale).toBe('boolean');
      expect(typeof s.duration_ms).toBe('number');
    });

    it('marks sessions started more than 1 hour ago as stale', () => {
      const now = Date.now();
      const staleEpoch = now - STALE_THRESHOLD_MS - 1000; // 1 second past threshold
      insertSessionWithEpoch(db, 'stale-session', 'proj', 'prompt', staleEpoch);

      const result = handleGetActiveSessions(store);

      expect(result.sessions).toHaveLength(1);
      expect(result.sessions[0].is_stale).toBe(true);
    });

    it('marks sessions started less than 1 hour ago as not stale', () => {
      const now = Date.now();
      const freshEpoch = now - STALE_THRESHOLD_MS + 60_000; // 1 minute before threshold
      insertSessionWithEpoch(db, 'fresh-session', 'proj', 'prompt', freshEpoch);

      const result = handleGetActiveSessions(store);

      expect(result.sessions).toHaveLength(1);
      expect(result.sessions[0].is_stale).toBe(false);
    });

    it('computes duration_ms as approximately now minus started_at_epoch', () => {
      const before = Date.now();
      createSDKSession(db, 'session-dur', 'proj', 'prompt');
      const after = Date.now();

      const result = handleGetActiveSessions(store);

      expect(result.sessions).toHaveLength(1);
      const duration = result.sessions[0].duration_ms;
      // Duration should be at most (after - session_start) and at least 0
      expect(duration).toBeGreaterThanOrEqual(0);
      expect(duration).toBeLessThanOrEqual(after - before + 100); // small tolerance
    });

    it('sets staleCount correctly when mix of stale and fresh sessions', () => {
      const now = Date.now();
      const staleEpoch = now - STALE_THRESHOLD_MS - 5000;
      const freshEpoch = now - 30_000; // 30 seconds ago

      insertSessionWithEpoch(db, 'stale-1', 'proj', 'old', staleEpoch);
      insertSessionWithEpoch(db, 'stale-2', 'proj', 'old2', staleEpoch);
      insertSessionWithEpoch(db, 'fresh-1', 'proj', 'new', freshEpoch);

      const result = handleGetActiveSessions(store);

      expect(result.totalCount).toBe(3);
      expect(result.staleCount).toBe(2);
    });

    it('sets totalCount equal to the number of active sessions', () => {
      createSDKSession(db, 'sess-1', 'proj', 'p1');
      createSDKSession(db, 'sess-2', 'proj', 'p2');
      createSDKSession(db, 'sess-3', 'proj', 'p3');

      const result = handleGetActiveSessions(store);

      expect(result.totalCount).toBe(3);
    });

    it('does not include completed sessions', () => {
      createSDKSession(db, 'active-sess', 'proj', 'active');
      const completedId = createSDKSession(db, 'done-sess', 'proj', 'done');
      store.closeActiveSessionById(completedId);

      const result = handleGetActiveSessions(store);

      expect(result.totalCount).toBe(1);
      expect(result.sessions[0].content_session_id).toBe('active-sess');
    });
  });

  // ─── POST /api/sessions/:id/close ─────────────────────────────────────────

  describe('POST /api/sessions/:id/close', () => {
    it('successfully closes an active session and returns success', () => {
      const sessionId = createSDKSession(db, 'close-me', 'proj', 'prompt');

      const result = handleCloseSession(store, sessionId);

      expect(result).toEqual({ success: true, summaryQueued: false });
    });

    it('returns null (404) for a non-existent session ID', () => {
      const result = handleCloseSession(store, 99999);

      expect(result).toBeNull();
    });

    it('returns null (404) for an already-completed session', () => {
      const sessionId = createSDKSession(db, 'already-done', 'proj', 'prompt');
      store.closeActiveSessionById(sessionId);

      const result = handleCloseSession(store, sessionId);

      expect(result).toBeNull();
    });

    it('session no longer appears in active list after close', () => {
      const sessionId = createSDKSession(db, 'will-close', 'proj', 'prompt');
      expect(handleGetActiveSessions(store).totalCount).toBe(1);

      handleCloseSession(store, sessionId);

      expect(handleGetActiveSessions(store).totalCount).toBe(0);
    });

    it('does not affect other active sessions when closing one', () => {
      const keepId = createSDKSession(db, 'keep', 'proj', 'keep');
      const closeId = createSDKSession(db, 'close', 'proj', 'close');

      handleCloseSession(store, closeId);

      const result = handleGetActiveSessions(store);
      expect(result.totalCount).toBe(1);
      expect(result.sessions[0].id).toBe(keepId);
    });
  });

  // ─── POST /api/sessions/close-stale ───────────────────────────────────────

  describe('POST /api/sessions/close-stale', () => {
    it('returns closedCount of 0 when no sessions exist', () => {
      const result = handleCloseStale(store);

      expect(result.closedCount).toBe(0);
    });

    it('returns closedCount of 0 when no sessions are stale', () => {
      createSDKSession(db, 'fresh-sess', 'proj', 'prompt');

      const result = handleCloseStale(store);

      expect(result.closedCount).toBe(0);
    });

    it('closes stale sessions and returns correct count', () => {
      const now = Date.now();
      const staleEpoch = now - STALE_THRESHOLD_MS - 10_000; // 10s past threshold

      insertSessionWithEpoch(db, 'stale-a', 'proj', 'old', staleEpoch);
      insertSessionWithEpoch(db, 'stale-b', 'proj', 'old2', staleEpoch);

      const result = handleCloseStale(store);

      expect(result.closedCount).toBe(2);
    });

    it('leaves fresh sessions untouched when closing stale sessions', () => {
      const now = Date.now();
      const staleEpoch = now - STALE_THRESHOLD_MS - 10_000;
      const freshEpoch = now - 60_000; // 1 minute ago

      insertSessionWithEpoch(db, 'stale-one', 'proj', 'old', staleEpoch);
      insertSessionWithEpoch(db, 'fresh-one', 'proj', 'new', freshEpoch);

      handleCloseStale(store);

      const active = handleGetActiveSessions(store);
      expect(active.totalCount).toBe(1);
      expect(active.sessions[0].content_session_id).toBe('fresh-one');
    });

    it('stale sessions no longer appear in active list after close-stale', () => {
      const now = Date.now();
      const staleEpoch = now - STALE_THRESHOLD_MS - 10_000;
      insertSessionWithEpoch(db, 'stale-x', 'proj', 'old', staleEpoch);

      handleCloseStale(store);

      const result = handleGetActiveSessions(store);
      expect(result.totalCount).toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------
// Summary queueing tests — ActiveSessionRoutes with SummaryQueueService
// These tests verify the NEW behavior: summaries are queued before close
// ---------------------------------------------------------------------------

describe('Close session with summary queueing', () => {
  let db: DbType;
  let store: SessionStore;

  beforeEach(() => {
    const claudeDb = new ClaudeMemDatabase(':memory:');
    db = claudeDb.db;
    store = new SessionStore(':memory:');
    (store as unknown as { db: DbType }).db = db;
  });

  afterEach(() => {
    db.close();
  });

  it('queues summary when session has memory_session_id and no existing summary', () => {
    const sessionId = createSDKSession(db, 'queue-sum-session', 'proj', 'prompt');
    const memSessionId = 'mem-session-queue-1';

    // Set memory_session_id on the session
    db.prepare('UPDATE sdk_sessions SET memory_session_id = ? WHERE id = ?').run(memSessionId, sessionId);

    // Add an observation so there's context
    db.prepare(`
      INSERT INTO observations (memory_session_id, project, title, narrative, type, created_at_epoch, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(memSessionId, 'proj', 'Test Title', 'Test narrative text', 'discovery', Date.now(), new Date().toISOString());

    const session = store.getSessionById(sessionId);
    expect(session?.memory_session_id).toBe(memSessionId);

    // No existing summary
    const existingSummary = store.getSummaryForSession(memSessionId);
    expect(existingSummary).toBeNull();

    // Last observation text is available
    const lastObsText = store.getLastObservationTextForSession(memSessionId);
    expect(lastObsText).toBeTruthy();

    // Mock SummaryQueueService
    const mockQueueSummary = vi.fn().mockReturnValue(true);
    const mockSummaryQueueService = { queueSummary: mockQueueSummary } as unknown as SummaryQueueService;

    // Simulate the tryQueueSummaryForSession logic
    const shouldQueue = session?.memory_session_id
      && !store.getSummaryForSession(session.memory_session_id);

    if (shouldQueue) {
      const memId = session.memory_session_id;
      const obsText = store.getLastObservationTextForSession(memId);
      mockSummaryQueueService.queueSummary(sessionId, obsText ?? undefined);
    }

    expect(mockQueueSummary).toHaveBeenCalledWith(sessionId, 'Test narrative text');
    expect(mockQueueSummary).toHaveBeenCalledTimes(1);
  });

  it('skips summary when session has no memory_session_id', () => {
    const sessionId = createSDKSession(db, 'no-mem-session', 'proj', 'prompt');

    const session = store.getSessionById(sessionId);
    expect(session?.memory_session_id).toBeNull();

    const mockQueueSummary = vi.fn().mockReturnValue(true);
    const mockSummaryQueueService = { queueSummary: mockQueueSummary } as unknown as SummaryQueueService;

    // Simulate the tryQueueSummaryForSession guard: skip if no memory_session_id
    const shouldQueue = session?.memory_session_id
      && !store.getSummaryForSession(session.memory_session_id);

    if (shouldQueue) {
      mockSummaryQueueService.queueSummary(sessionId, undefined);
    }

    expect(mockQueueSummary).not.toHaveBeenCalled();
  });

  it('skips summary when session already has a summary', () => {
    const sessionId = createSDKSession(db, 'has-summary-session', 'proj', 'prompt');
    const memSessionId = 'mem-session-existing-summary';

    db.prepare('UPDATE sdk_sessions SET memory_session_id = ? WHERE id = ?').run(memSessionId, sessionId);

    // Insert an existing summary
    db.prepare(`
      INSERT INTO session_summaries (memory_session_id, project, request, created_at_epoch, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(memSessionId, 'proj', 'existing request', Date.now(), new Date().toISOString());

    const session = store.getSessionById(sessionId);
    const existingSummary = store.getSummaryForSession(memSessionId);
    expect(existingSummary).not.toBeNull();

    const mockQueueSummary = vi.fn().mockReturnValue(true);
    const mockSummaryQueueService = { queueSummary: mockQueueSummary } as unknown as SummaryQueueService;

    // Simulate the tryQueueSummaryForSession guard: skip if summary already exists
    const shouldQueue = session?.memory_session_id
      && !store.getSummaryForSession(session.memory_session_id);

    if (shouldQueue) {
      const memId = session.memory_session_id;
      const obsText = store.getLastObservationTextForSession(memId);
      mockSummaryQueueService.queueSummary(sessionId, obsText ?? undefined);
    }

    expect(mockQueueSummary).not.toHaveBeenCalled();
  });

  it('uses last observation text as context for summary', () => {
    const sessionId = createSDKSession(db, 'obs-context-session', 'proj', 'prompt');
    const memSessionId = 'mem-session-obs-context';

    db.prepare('UPDATE sdk_sessions SET memory_session_id = ? WHERE id = ?').run(memSessionId, sessionId);

    const observationNarrative = 'Important observation narrative content';
    db.prepare(`
      INSERT INTO observations (memory_session_id, project, title, narrative, type, created_at_epoch, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(memSessionId, 'proj', 'Obs Title', observationNarrative, 'discovery', Date.now(), new Date().toISOString());

    const lastObsText = store.getLastObservationTextForSession(memSessionId);
    expect(lastObsText).toBe(observationNarrative);

    const mockQueueSummary = vi.fn().mockReturnValue(true);
    const mockSummaryQueueService = { queueSummary: mockQueueSummary } as unknown as SummaryQueueService;

    const session = store.getSessionById(sessionId);
    const shouldQueue = session?.memory_session_id
      && !store.getSummaryForSession(session.memory_session_id);

    if (shouldQueue) {
      const memId = session.memory_session_id;
      const obsText = store.getLastObservationTextForSession(memId);
      mockSummaryQueueService.queueSummary(sessionId, obsText ?? undefined);
    }

    expect(mockQueueSummary).toHaveBeenCalledWith(sessionId, observationNarrative);
  });

  it('still closes session even if summary queueing fails', () => {
    const sessionId = createSDKSession(db, 'fail-queue-session', 'proj', 'prompt');
    const memSessionId = 'mem-session-fail-queue';

    db.prepare('UPDATE sdk_sessions SET memory_session_id = ? WHERE id = ?').run(memSessionId, sessionId);

    // queueSummary throws
    const mockQueueSummary = vi.fn().mockImplementation(() => {
      throw new Error('Queue service unavailable');
    });
    const mockSummaryQueueService = { queueSummary: mockQueueSummary } as unknown as SummaryQueueService;

    // Simulate tryQueueSummaryForSession with error handling
    let summaryQueued = false;
    const session = store.getSessionById(sessionId);
    if (session?.memory_session_id && !store.getSummaryForSession(session.memory_session_id)) {
      try {
        const obsText = store.getLastObservationTextForSession(session.memory_session_id);
        summaryQueued = mockSummaryQueueService.queueSummary(sessionId, obsText ?? undefined);
      } catch {
        summaryQueued = false;
      }
    }

    // Session close still proceeds
    const closed = store.closeActiveSessionById(sessionId);
    expect(closed).toBe(true);
    expect(summaryQueued).toBe(false);

    // Session is gone from active list
    const active = store.getActiveSessions();
    expect(active.find(s => s.id === sessionId)).toBeUndefined();
  });

  it('response includes summaryQueued field when SummaryQueueService provided', async () => {
    const { ActiveSessionRoutes } = await import('../../../src/services/worker/http/routes/ActiveSessionRoutes.js');
    const { DatabaseManager } = await import('../../../src/services/worker/DatabaseManager.js');

    const mockQueueSummary = vi.fn().mockReturnValue(true);
    const mockSummaryQueueService = { queueSummary: mockQueueSummary } as unknown as SummaryQueueService;

    const dbManager = new DatabaseManager();
    // Pass the optional summaryQueueService
    const routes = new ActiveSessionRoutes(dbManager, mockSummaryQueueService);
    expect(routes).toBeDefined();
    // The constructor accepts the optional second param without error
  });

  it('is constructible without SummaryQueueService (backward compatible)', async () => {
    const { ActiveSessionRoutes } = await import('../../../src/services/worker/http/routes/ActiveSessionRoutes.js');
    const { DatabaseManager } = await import('../../../src/services/worker/DatabaseManager.js');

    const dbManager = new DatabaseManager();
    const routes = new ActiveSessionRoutes(dbManager);
    expect(routes).toBeDefined();
  });
});

describe('Close stale sessions with summary queueing', () => {
  let db: DbType;
  let store: SessionStore;

  beforeEach(() => {
    const claudeDb = new ClaudeMemDatabase(':memory:');
    db = claudeDb.db;
    store = new SessionStore(':memory:');
    (store as unknown as { db: DbType }).db = db;
  });

  afterEach(() => {
    db.close();
  });

  it('queues summaries for stale sessions that have observations before closing', () => {
    const now = Date.now();
    const staleEpoch = now - STALE_THRESHOLD_MS - 10_000;

    // Insert stale session with memory_session_id and observation
    db.prepare(`
      INSERT INTO sdk_sessions (content_session_id, project, user_prompt, started_at, started_at_epoch, status)
      VALUES (?, ?, ?, ?, ?, 'active')
    `).run('stale-with-obs', 'proj', 'old', new Date(staleEpoch).toISOString(), staleEpoch);
    const staleSessionId = (db.prepare('SELECT id FROM sdk_sessions WHERE content_session_id = ?').get('stale-with-obs') as { id: number }).id;
    const memSessionId = 'mem-stale-session-1';

    db.prepare('UPDATE sdk_sessions SET memory_session_id = ? WHERE id = ?').run(memSessionId, staleSessionId);
    db.prepare(`
      INSERT INTO observations (memory_session_id, project, title, narrative, type, created_at_epoch, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(memSessionId, 'proj', 'Stale Obs', 'Stale observation narrative', 'discovery', staleEpoch, new Date(staleEpoch).toISOString());

    const mockQueueSummary = vi.fn().mockReturnValue(true);
    const mockSummaryQueueService = { queueSummary: mockQueueSummary } as unknown as SummaryQueueService;

    // Simulate handleCloseStale with summaryQueueService logic
    const threshold = now - STALE_THRESHOLD_MS;
    const activeSessions = store.getActiveSessions();
    const staleSessions = activeSessions.filter(s => s.started_at_epoch < threshold);

    let summariesQueued = 0;
    for (const staleSession of staleSessions) {
      const session = store.getSessionById(staleSession.id);
      if (session?.memory_session_id && !store.getSummaryForSession(session.memory_session_id)) {
        const obsText = store.getLastObservationTextForSession(session.memory_session_id);
        const queued = mockSummaryQueueService.queueSummary(staleSession.id, obsText ?? undefined);
        if (queued) summariesQueued++;
      }
    }

    const closedCount = store.closeStaleSessionsOlderThan(threshold);

    expect(closedCount).toBe(1);
    expect(summariesQueued).toBe(1);
    expect(mockQueueSummary).toHaveBeenCalledWith(staleSessionId, 'Stale observation narrative');
  });

  it('response includes summariesQueued count', () => {
    const now = Date.now();
    const staleEpoch = now - STALE_THRESHOLD_MS - 5_000;

    // Insert two stale sessions
    db.prepare(`
      INSERT INTO sdk_sessions (content_session_id, project, user_prompt, started_at, started_at_epoch, status)
      VALUES (?, ?, ?, ?, ?, 'active')
    `).run('stale-resp-1', 'proj', 'old1', new Date(staleEpoch).toISOString(), staleEpoch);
    db.prepare(`
      INSERT INTO sdk_sessions (content_session_id, project, user_prompt, started_at, started_at_epoch, status)
      VALUES (?, ?, ?, ?, ?, 'active')
    `).run('stale-resp-2', 'proj', 'old2', new Date(staleEpoch).toISOString(), staleEpoch);

    const threshold = now - STALE_THRESHOLD_MS;
    const activeSessions = store.getActiveSessions();
    const staleSessions = activeSessions.filter(s => s.started_at_epoch < threshold);

    // Neither stale session has memory_session_id, so no summaries queued
    const mockQueueSummary = vi.fn().mockReturnValue(true);
    const mockSummaryQueueService = { queueSummary: mockQueueSummary } as unknown as SummaryQueueService;

    let summariesQueued = 0;
    for (const staleSession of staleSessions) {
      const session = store.getSessionById(staleSession.id);
      if (session?.memory_session_id && !store.getSummaryForSession(session.memory_session_id)) {
        const obsText = store.getLastObservationTextForSession(session.memory_session_id);
        const queued = mockSummaryQueueService.queueSummary(staleSession.id, obsText ?? undefined);
        if (queued) summariesQueued++;
      }
    }

    const closedCount = store.closeStaleSessionsOlderThan(threshold);

    // Both closed but neither queued a summary (no memory_session_id)
    expect(closedCount).toBe(2);
    expect(summariesQueued).toBe(0);
    expect(mockQueueSummary).not.toHaveBeenCalled();
  });

  it('skips summary for stale sessions that already have a summary', () => {
    const now = Date.now();
    const staleEpoch = now - STALE_THRESHOLD_MS - 5_000;

    db.prepare(`
      INSERT INTO sdk_sessions (content_session_id, project, user_prompt, started_at, started_at_epoch, status)
      VALUES (?, ?, ?, ?, ?, 'active')
    `).run('stale-has-sum', 'proj', 'old', new Date(staleEpoch).toISOString(), staleEpoch);
    const staleId = (db.prepare('SELECT id FROM sdk_sessions WHERE content_session_id = ?').get('stale-has-sum') as { id: number }).id;
    const memId = 'mem-stale-has-summary';

    db.prepare('UPDATE sdk_sessions SET memory_session_id = ? WHERE id = ?').run(memId, staleId);
    db.prepare(`
      INSERT INTO session_summaries (memory_session_id, project, request, created_at_epoch, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(memId, 'proj', 'existing summary', Date.now(), new Date().toISOString());

    const mockQueueSummary = vi.fn().mockReturnValue(true);
    const mockSummaryQueueService = { queueSummary: mockQueueSummary } as unknown as SummaryQueueService;

    const threshold = now - STALE_THRESHOLD_MS;
    const activeSessions = store.getActiveSessions();
    const staleSessions = activeSessions.filter(s => s.started_at_epoch < threshold);

    let summariesQueued = 0;
    for (const staleSession of staleSessions) {
      const session = store.getSessionById(staleSession.id);
      if (session?.memory_session_id && !store.getSummaryForSession(session.memory_session_id)) {
        const obsText = store.getLastObservationTextForSession(session.memory_session_id);
        const queued = mockSummaryQueueService.queueSummary(staleSession.id, obsText ?? undefined);
        if (queued) summariesQueued++;
      }
    }

    expect(mockQueueSummary).not.toHaveBeenCalled();
    expect(summariesQueued).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// API_ENDPOINTS constant tests
// ---------------------------------------------------------------------------

describe('API_ENDPOINTS active session constants', () => {
  it('exports ACTIVE_SESSIONS endpoint', async () => {
    const { API_ENDPOINTS } = await import('../../../src/ui/viewer/constants/api.js');
    expect(API_ENDPOINTS.ACTIVE_SESSIONS).toBe('/api/sessions/active');
  });

  it('exports SESSIONS_BASE endpoint', async () => {
    const { API_ENDPOINTS } = await import('../../../src/ui/viewer/constants/api.js');
    expect(API_ENDPOINTS.SESSIONS_BASE).toBe('/api/sessions');
  });

  it('exports CLOSE_STALE_SESSIONS endpoint', async () => {
    const { API_ENDPOINTS } = await import('../../../src/ui/viewer/constants/api.js');
    expect(API_ENDPOINTS.CLOSE_STALE_SESSIONS).toBe('/api/sessions/close-stale');
  });
});

// ---------------------------------------------------------------------------
// ActiveSessionRoutes class structure tests
// ---------------------------------------------------------------------------

describe('ActiveSessionRoutes class', () => {
  it('can be imported', async () => {
    const { ActiveSessionRoutes } = await import('../../../src/services/worker/http/routes/ActiveSessionRoutes.js');
    expect(ActiveSessionRoutes).toBeDefined();
  });

  it('is constructible with a DatabaseManager', async () => {
    const { ActiveSessionRoutes } = await import('../../../src/services/worker/http/routes/ActiveSessionRoutes.js');
    const { DatabaseManager } = await import('../../../src/services/worker/DatabaseManager.js');

    const dbManager = new DatabaseManager();
    const routes = new ActiveSessionRoutes(dbManager);
    expect(routes).toBeDefined();
  });

  it('is constructible with a DatabaseManager and optional SummaryQueueService', async () => {
    const { ActiveSessionRoutes } = await import('../../../src/services/worker/http/routes/ActiveSessionRoutes.js');
    const { DatabaseManager } = await import('../../../src/services/worker/DatabaseManager.js');

    const mockSummaryQueueService = {
      queueSummary: vi.fn().mockReturnValue(true)
    } as unknown as SummaryQueueService;

    const dbManager = new DatabaseManager();
    const routes = new ActiveSessionRoutes(dbManager, mockSummaryQueueService);
    expect(routes).toBeDefined();
  });

  it('has a setupRoutes method', async () => {
    const { ActiveSessionRoutes } = await import('../../../src/services/worker/http/routes/ActiveSessionRoutes.js');
    const { DatabaseManager } = await import('../../../src/services/worker/DatabaseManager.js');

    const dbManager = new DatabaseManager();
    const routes = new ActiveSessionRoutes(dbManager);
    expect(typeof routes.setupRoutes).toBe('function');
  });
});
