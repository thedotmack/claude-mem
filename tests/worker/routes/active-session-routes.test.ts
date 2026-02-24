/**
 * Tests for ActiveSessionRoutes handler logic
 *
 * Tests the route handler business logic directly using an in-memory SQLite
 * database with real migrations, following the same pattern as analytics-endpoint.test.ts.
 * We do NOT spin up Express — instead we call the handler logic extracted via the
 * SessionStore directly, verifying the queries and response shapes the handlers use.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ClaudeMemDatabase } from '../../../src/services/sqlite/Database.js';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { createSDKSession } from '../../../src/services/sqlite/Sessions.js';
import type { Database as DbType } from '../../../src/services/sqlite/sqlite-compat.js';

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
}

interface CloseStaleResponse {
  closedCount: number;
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
  return closed ? { success: true } : null;
}

function handleCloseStale(store: SessionStore): CloseStaleResponse {
  const threshold = Date.now() - STALE_THRESHOLD_MS;
  const closedCount = store.closeStaleSessionsOlderThan(threshold);
  return { closedCount };
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

      expect(result).toEqual({ success: true });
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

  it('has a setupRoutes method', async () => {
    const { ActiveSessionRoutes } = await import('../../../src/services/worker/http/routes/ActiveSessionRoutes.js');
    const { DatabaseManager } = await import('../../../src/services/worker/DatabaseManager.js');

    const dbManager = new DatabaseManager();
    const routes = new ActiveSessionRoutes(dbManager);
    expect(typeof routes.setupRoutes).toBe('function');
  });
});
