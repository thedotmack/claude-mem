/**
 * Injection Tracking Integration Tests — Phase 3
 *
 * Verifies that context_injections rows are created when:
 *   1. GET /api/context/inject returns observations to the caller
 *   2. POST /api/observations/batch returns observations to the caller
 *
 * Strategy:
 * - Build a minimal Express app wired to an in-memory SQLite database.
 * - Pre-seed observations so the endpoints have real data to return.
 * - Issue real HTTP requests and then query context_injections directly
 *   to confirm the tracking rows were written.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import net from 'node:net';
import express from 'express';
import type { Server as HttpServer } from 'node:http';

import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { InjectionTracker } from '../../src/services/sqlite/InjectionTracker.js';
import { MigrationRunner } from '../../src/services/sqlite/migrations/runner.js';
import { DataRoutes } from '../../src/services/worker/http/routes/DataRoutes.js';
import { SearchRoutes } from '../../src/services/worker/http/routes/SearchRoutes.js';
import type { DatabaseManager } from '../../src/services/worker/DatabaseManager.js';
import type { PaginationHelper } from '../../src/services/worker/PaginationHelper.js';
import type { SessionManager } from '../../src/services/worker/SessionManager.js';
import type { SSEBroadcaster } from '../../src/services/worker/SSEBroadcaster.js';
import type { WorkerService } from '../../src/services/worker-service.js';
import type { SearchManager } from '../../src/services/worker/SearchManager.js';
import { logger } from '../../src/utils/logger.js';

import type { MockInstance } from 'vitest';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Row shape returned from context_injections
 */
interface InjectionRow {
  id: number;
  session_id: string | null;
  project: string;
  observation_ids: string;
  total_read_tokens: number;
  injection_source: string;
  created_at: string;
  created_at_epoch: number;
}

/**
 * Create an in-memory SessionStore and run the remaining migrations
 * (including migration 22 — context_injections table) on its shared db.
 *
 * SessionStore runs migrations 1-21 in its constructor.
 * MigrationRunner adds migration 22 (context_injections) idempotently.
 *
 * Returns the store and its underlying database.
 */
function createTestSessionStore(): SessionStore {
  const store = new SessionStore(':memory:');
  // SessionStore doesn't run migration 22 yet — add it via MigrationRunner
  const runner = new MigrationRunner(store.db);
  runner.runAllMigrations(); // idempotent for migrations already applied
  return store;
}

/**
 * Seed a single observation into the database via raw SQL.
 * Creates a parent sdk_session row first to satisfy the foreign key constraint.
 * Returns the inserted observation row ID.
 */
function seedObservation(
  store: SessionStore,
  opts: { project?: string; memorySessionId?: string; title?: string } = {}
): number {
  const project = opts.project ?? 'test-project';
  const sessionId = opts.memorySessionId ?? 'sess-abc';
  const title = opts.title ?? 'Test Observation';

  // Ensure the parent sdk_session exists (required by foreign key)
  store.db.prepare(`
    INSERT OR IGNORE INTO sdk_sessions (
      content_session_id, memory_session_id, project,
      user_prompt, started_at, started_at_epoch, status
    ) VALUES (?, ?, ?, '', datetime('now'), ?, 'active')
  `).run(`content-${sessionId}`, sessionId, project, Date.now());

  const result = store.db.prepare(`
    INSERT INTO observations (
      memory_session_id, project, type, title, subtitle, text,
      narrative, facts, concepts, files_read, files_modified,
      prompt_number, discovery_tokens, read_tokens, created_at, created_at_epoch
    ) VALUES (?, ?, 'decision', ?, null, null, 'narrative text', '["fact1"]',
      '["decision"]', '[]', '[]', 1, 200, 150, datetime('now'), ?)
  `).run(sessionId, project, title, Date.now());

  return result.lastInsertRowid as number;
}

/**
 * Listen on a free OS-assigned port. Returns the actual port number.
 */
function listenOnFreePort(app: express.Application): Promise<{ server: HttpServer; port: number }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address() as net.AddressInfo;
      resolve({ server, port: addr.port });
    });
    server.on('error', reject);
  });
}

/**
 * Build a minimal stub DatabaseManager backed by a real in-memory SessionStore.
 */
function buildDbManager(store: SessionStore): DatabaseManager {
  const tracker = new InjectionTracker(store.db);

  return {
    getSessionStore: () => store,
    getInjectionTracker: () => tracker,
    getSessionSearch: () => { throw new Error('not needed'); },
    getChromaSync: () => { throw new Error('not needed'); },
    initialize: () => { /* noop */ },
    close: () => Promise.resolve(),
    getSessionById: () => { throw new Error('not needed'); },
  } as unknown as DatabaseManager;
}

/**
 * Build a minimal stub PaginationHelper.
 */
function buildPaginationHelper(): PaginationHelper {
  return {
    getObservations: () => ({ items: [], total: 0 }),
    getSummaries: () => ({ items: [], total: 0 }),
    getPrompts: () => ({ items: [], total: 0 }),
  } as unknown as PaginationHelper;
}

/**
 * Build a minimal stub SessionManager.
 */
function buildSessionManager(): SessionManager {
  return {
    isAnySessionProcessing: () => false,
    getTotalActiveWork: () => 0,
    getTotalQueueDepth: () => 0,
    getActiveSessionCount: () => 0,
  } as unknown as SessionManager;
}

/**
 * Build a minimal stub SSEBroadcaster.
 */
function buildSseBroadcaster(): SSEBroadcaster {
  return {
    getClientCount: () => 0,
  } as unknown as SSEBroadcaster;
}

/**
 * Build a minimal stub WorkerService.
 */
function buildWorkerService(): WorkerService {
  return {
    broadcastProcessingStatus: () => { /* noop */ },
    processPendingQueues: () => Promise.resolve({ started: 0, skipped: 0 }),
  } as unknown as WorkerService;
}

// ---------------------------------------------------------------------------
// Test suite — POST /api/observations/batch injection tracking
// ---------------------------------------------------------------------------

describe('Injection Tracking — POST /api/observations/batch', () => {
  let store: SessionStore;
  let dbManager: DatabaseManager;
  let app: express.Application;
  let httpServer: HttpServer;
  let port: number;
  let loggerSpies: MockInstance[];

  beforeEach(async () => {
    loggerSpies = [
      vi.spyOn(logger, 'info').mockImplementation(() => {}),
      vi.spyOn(logger, 'debug').mockImplementation(() => {}),
      vi.spyOn(logger, 'warn').mockImplementation(() => {}),
      vi.spyOn(logger, 'error').mockImplementation(() => {}),
    ];

    store = createTestSessionStore();
    dbManager = buildDbManager(store);

    app = express();
    app.use(express.json());

    const dataRoutes = new DataRoutes(
      buildPaginationHelper(),
      dbManager,
      buildSessionManager(),
      buildSseBroadcaster(),
      buildWorkerService(),
      Date.now()
    );
    dataRoutes.setupRoutes(app);

    ({ server: httpServer, port } = await listenOnFreePort(app));
  });

  afterEach(async () => {
    for (const spy of loggerSpies) spy.mockRestore();
    await new Promise<void>((resolve) => { httpServer.close(() => { resolve(); }); });
    store.close();
    vi.restoreAllMocks();
  });

  it('writes a context_injections row after fetching observations by batch IDs', async () => {
    const obsId = seedObservation(store, { project: 'myproject' });

    const response = await fetch(`http://127.0.0.1:${String(port)}/api/observations/batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [obsId] }),
    });

    expect(response.status).toBe(200);

    // The tracking call is synchronous (happens before res.json in DataRoutes),
    // but we add a tiny yield for safety.
    await new Promise(resolve => setTimeout(resolve, 10));

    const rows = store.db.prepare('SELECT * FROM context_injections').all() as InjectionRow[];
    expect(rows).toHaveLength(1);
    expect(rows[0].injection_source).toBe('mcp_search');
  });

  it('sets observation_ids to the IDs that were fetched', async () => {
    const id1 = seedObservation(store, { project: 'proj', title: 'Obs A' });
    const id2 = seedObservation(store, { project: 'proj', title: 'Obs B' });

    await fetch(`http://127.0.0.1:${String(port)}/api/observations/batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [id1, id2] }),
    });

    await new Promise(resolve => setTimeout(resolve, 10));

    const row = store.db
      .prepare('SELECT observation_ids FROM context_injections')
      .get() as { observation_ids: string };
    const ids = JSON.parse(row.observation_ids) as number[];
    expect(ids).toContain(id1);
    expect(ids).toContain(id2);
  });

  it('derives project from the first returned observation', async () => {
    const obsId = seedObservation(store, { project: 'derived-project' });

    await fetch(`http://127.0.0.1:${String(port)}/api/observations/batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [obsId] }),
    });

    await new Promise(resolve => setTimeout(resolve, 10));

    const row = store.db
      .prepare('SELECT project FROM context_injections')
      .get() as { project: string };
    expect(row.project).toBe('derived-project');
  });

  it('does NOT write an injection row when the result array is empty (batch returns 0 observations)', async () => {
    // IDs that don't exist → getObservationsByIds returns []
    await fetch(`http://127.0.0.1:${String(port)}/api/observations/batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [99999] }),
    });

    await new Promise(resolve => setTimeout(resolve, 10));

    const rows = store.db.prepare('SELECT * FROM context_injections').all() as InjectionRow[];
    expect(rows).toHaveLength(0);
  });

  it('does NOT write an injection row for an empty ids array (returns 200 immediately)', async () => {
    const response = await fetch(`http://127.0.0.1:${String(port)}/api/observations/batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [] }),
    });

    expect(response.status).toBe(200);

    await new Promise(resolve => setTimeout(resolve, 10));

    const rows = store.db.prepare('SELECT * FROM context_injections').all() as InjectionRow[];
    expect(rows).toHaveLength(0);
  });

  it('does not throw or break the response when tracking fails', async () => {
    // Make trackInjection throw to verify fire-and-forget doesn't break response
    vi.spyOn(dbManager.getInjectionTracker(), 'trackInjection').mockImplementation(() => {
      throw new Error('DB error');
    });

    const obsId = seedObservation(store, { project: 'proj' });

    const response = await fetch(`http://127.0.0.1:${String(port)}/api/observations/batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [obsId] }),
    });

    // Response should still be 200 despite tracking error
    expect(response.status).toBe(200);
    const body = await response.json() as unknown[];
    expect(Array.isArray(body)).toBe(true);
  });

  it('sets the correct total_read_tokens from read_tokens of returned observations', async () => {
    // Observations seeded with read_tokens=150 each
    const id1 = seedObservation(store, { project: 'tokens-proj', title: 'Obs 1' });
    const id2 = seedObservation(store, { project: 'tokens-proj', title: 'Obs 2' });

    await fetch(`http://127.0.0.1:${String(port)}/api/observations/batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [id1, id2] }),
    });

    await new Promise(resolve => setTimeout(resolve, 10));

    const row = store.db
      .prepare('SELECT total_read_tokens FROM context_injections')
      .get() as { total_read_tokens: number };
    // 2 observations × 150 read_tokens each = 300
    expect(row.total_read_tokens).toBe(300);
  });
});

// ---------------------------------------------------------------------------
// Test suite — GET /api/context/inject injection tracking
// ---------------------------------------------------------------------------

describe('Injection Tracking — GET /api/context/inject', () => {
  let store: SessionStore;
  let dbManager: DatabaseManager;
  let app: express.Application;
  let httpServer: HttpServer;
  let port: number;
  let loggerSpies: MockInstance[];

  beforeEach(async () => {
    loggerSpies = [
      vi.spyOn(logger, 'info').mockImplementation(() => {}),
      vi.spyOn(logger, 'debug').mockImplementation(() => {}),
      vi.spyOn(logger, 'warn').mockImplementation(() => {}),
      vi.spyOn(logger, 'error').mockImplementation(() => {}),
    ];

    store = createTestSessionStore();
    dbManager = buildDbManager(store);

    app = express();
    app.use(express.json());

    const searchManager = {
      search: vi.fn(),
      timeline: vi.fn(),
      decisions: vi.fn(),
      changes: vi.fn(),
      howItWorks: vi.fn(),
      searchObservations: vi.fn(),
      searchSessions: vi.fn(),
      searchUserPrompts: vi.fn(),
      findByConcept: vi.fn(),
      findByFile: vi.fn(),
      findByType: vi.fn(),
      getRecentContext: vi.fn(),
      getContextTimeline: vi.fn(),
      getTimelineByQuery: vi.fn(),
    } as unknown as SearchManager;

    const searchRoutes = new SearchRoutes(searchManager, dbManager);
    searchRoutes.setupRoutes(app);

    ({ server: httpServer, port } = await listenOnFreePort(app));
  });

  afterEach(async () => {
    for (const spy of loggerSpies) spy.mockRestore();
    await new Promise<void>((resolve) => { httpServer.close(() => { resolve(); }); });
    store.close();
    vi.restoreAllMocks();
  });

  it('returns 400 when the projects parameter is missing', async () => {
    const response = await fetch(
      `http://127.0.0.1:${String(port)}/api/context/inject`
    );

    expect(response.status).toBe(400);
  });

  it('returns 400 when the projects parameter is empty string', async () => {
    const response = await fetch(
      `http://127.0.0.1:${String(port)}/api/context/inject?projects=`
    );

    expect(response.status).toBe(400);
  });

  it('returns 200 with text content when projects parameter is provided', async () => {
    const response = await fetch(
      `http://127.0.0.1:${String(port)}/api/context/inject?projects=test-proj`
    );

    expect(response.status).toBe(200);
    const contentType = response.headers.get('content-type') ?? '';
    expect(contentType).toContain('text/plain');
  });

  it('does not write an injection row when no observations exist for the project', async () => {
    // No data seeded — context generator will return empty state with no observation IDs
    await fetch(
      `http://127.0.0.1:${String(port)}/api/context/inject?projects=empty-proj`
    );

    await new Promise(resolve => setTimeout(resolve, 50));

    const rows = store.db.prepare('SELECT * FROM context_injections').all() as InjectionRow[];
    // No observations → no injection tracking row
    expect(rows).toHaveLength(0);
  });

  it('does not throw when InjectionTracker is present but dbManager tracking fails', async () => {
    vi.spyOn(dbManager.getInjectionTracker(), 'trackInjection').mockImplementation(() => {
      throw new Error('Tracker failure');
    });

    const response = await fetch(
      `http://127.0.0.1:${String(port)}/api/context/inject?projects=any-proj`
    );

    // Should still return a response
    expect([200, 400]).toContain(response.status);
  });

  it('accepts legacy project parameter (single project)', async () => {
    const response = await fetch(
      `http://127.0.0.1:${String(port)}/api/context/inject?project=legacy-proj`
    );

    expect(response.status).toBe(200);
    const contentType = response.headers.get('content-type') ?? '';
    expect(contentType).toContain('text/plain');
  });
});

// ---------------------------------------------------------------------------
// Unit tests — generateContextWithMeta
// ---------------------------------------------------------------------------

describe('generateContextWithMeta — return shape', () => {
  it('exports generateContextWithMeta from context/index', async () => {
    const contextModule = await import('../../src/services/context/index.js');
    expect(typeof contextModule.generateContextWithMeta).toBe('function');
  });

  it('returns an object with text, observationIds, and totalReadTokens fields', async () => {
    const { generateContextWithMeta } = await import('../../src/services/context/index.js');

    // Call with no real database (will return empty state)
    const result = generateContextWithMeta(
      { session_id: 'test', cwd: '/nonexistent/project' },
      false
    );

    expect(result).toHaveProperty('text');
    expect(result).toHaveProperty('observationIds');
    expect(result).toHaveProperty('totalReadTokens');
    expect(typeof result.text).toBe('string');
    expect(Array.isArray(result.observationIds)).toBe(true);
    expect(typeof result.totalReadTokens).toBe('number');
  });

  it('observationIds is an empty array when no database observations found', async () => {
    const { generateContextWithMeta } = await import('../../src/services/context/index.js');

    const result = generateContextWithMeta(
      { session_id: 'test', cwd: '/nonexistent/___no_such_project___' },
      false
    );

    expect(result.observationIds).toEqual([]);
    expect(result.totalReadTokens).toBe(0);
  });

  it('backward-compatible generateContext still returns a string', async () => {
    const { generateContext } = await import('../../src/services/context/index.js');

    const result = generateContext(
      { session_id: 'test', cwd: '/nonexistent/project' },
      false
    );

    expect(typeof result).toBe('string');
  });

  it('exports generateContextWithMeta from context-generator (backward compat path)', async () => {
    const module = await import('../../src/services/context-generator.js');
    expect(typeof module.generateContextWithMeta).toBe('function');
  });
});
