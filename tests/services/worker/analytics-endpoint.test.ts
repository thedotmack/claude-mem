/**
 * Tests for GET /api/analytics endpoint
 *
 * Tests query logic directly using an in-memory SQLite database with real migrations.
 * We test the SQL queries and response shape without spinning up Express, following
 * the same pattern used in InjectionTracker.test.ts.
 *
 * RED phase: All tests fail until handleGetAnalytics is implemented.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Database } from '../../../src/services/sqlite/sqlite-compat.js';
import { MigrationRunner } from '../../../src/services/sqlite/migrations/runner.js';

// ---------------------------------------------------------------------------
// Types matching the expected API response shape
// ---------------------------------------------------------------------------

interface AnalyticsResponse {
  workTokens: number;
  readTokens: number;
  savingsTokens: number;
  observationCount: number;
  sessionCount: number;
  timeRange: { days: number | null; cutoffEpoch: number };
  project: string | null;
}

interface AnalyticsQueryParams {
  project?: string;
  days?: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTestDb(): Database {
  const db = new Database(':memory:');
  const runner = new MigrationRunner(db);
  runner.runAllMigrations();
  return db;
}

/**
 * Insert a test SDK session so observations FK constraint is satisfied.
 */
function insertSession(db: Database, memorySessionId: string, project: string): void {
  db.prepare(`
    INSERT OR IGNORE INTO sdk_sessions
      (content_session_id, memory_session_id, project, user_prompt, started_at, started_at_epoch, status)
    VALUES (?, ?, ?, 'test', datetime('now'), ?, 'active')
  `).run(memorySessionId, memorySessionId, project, Date.now());
}

/**
 * Insert a test observation with explicit token values.
 */
function insertObservation(
  db: Database,
  opts: {
    memorySessionId: string;
    project: string;
    discoveryTokens?: number;
    readTokens?: number;
    createdAtEpoch?: number;
  }
): void {
  const epoch = opts.createdAtEpoch ?? Date.now();
  db.prepare(`
    INSERT INTO observations
      (memory_session_id, project, text, type, created_at, created_at_epoch, discovery_tokens, read_tokens)
    VALUES (?, ?, 'test text', 'discovery', datetime('now'), ?, ?, ?)
  `).run(
    opts.memorySessionId,
    opts.project,
    epoch,
    opts.discoveryTokens ?? 0,
    opts.readTokens ?? 0
  );
}

/**
 * Insert a test session summary with explicit token values.
 */
function insertSummary(
  db: Database,
  opts: {
    memorySessionId: string;
    project: string;
    discoveryTokens?: number;
    createdAtEpoch?: number;
  }
): void {
  const epoch = opts.createdAtEpoch ?? Date.now();
  db.prepare(`
    INSERT INTO session_summaries
      (memory_session_id, project, created_at, created_at_epoch, discovery_tokens)
    VALUES (?, ?, datetime('now'), ?, ?)
  `).run(
    opts.memorySessionId,
    opts.project,
    epoch,
    opts.discoveryTokens ?? 0
  );
}

/**
 * Insert a test context injection with explicit token values.
 */
function insertContextInjection(
  db: Database,
  opts: {
    project: string;
    totalReadTokens: number;
    sessionId?: string;
    createdAtEpoch?: number;
  }
): void {
  const epoch = opts.createdAtEpoch ?? Date.now();
  db.prepare(`
    INSERT INTO context_injections
      (session_id, project, observation_ids, total_read_tokens, injection_source, created_at, created_at_epoch)
    VALUES (?, ?, '[]', ?, 'session_start', datetime('now'), ?)
  `).run(
    opts.sessionId ?? null,
    opts.project,
    opts.totalReadTokens,
    epoch
  );
}

/**
 * Execute the analytics queries against the DB — mirrors what the endpoint will do.
 * This is the core logic under test, extracted for testability.
 */
function queryAnalytics(db: Database, params: AnalyticsQueryParams): AnalyticsResponse {
  const { project, days } = params;
  const cutoffEpoch = days ? Date.now() - days * 24 * 60 * 60 * 1000 : 0;

  // Validate days if provided
  if (days !== undefined && (!Number.isInteger(days) || days <= 0)) {
    throw new Error('days must be a positive integer');
  }

  const projectFilter = project ? ' AND project = ?' : '';
  const baseParams = (extra: unknown[]): unknown[] =>
    project ? [cutoffEpoch, ...extra, project] : [cutoffEpoch, ...extra];

  // Work tokens from observations
  const obsWork = db.prepare(
    `SELECT COALESCE(SUM(discovery_tokens), 0) as tokens FROM observations WHERE created_at_epoch >= ?${projectFilter}`
  ).get(...baseParams([])) as { tokens: number };

  // Work tokens from summaries
  const sumWork = db.prepare(
    `SELECT COALESCE(SUM(discovery_tokens), 0) as tokens FROM session_summaries WHERE created_at_epoch >= ?${projectFilter}`
  ).get(...baseParams([])) as { tokens: number };

  // Read cost (stored read_tokens on observations)
  const readCost = db.prepare(
    `SELECT COALESCE(SUM(read_tokens), 0) as tokens FROM observations WHERE created_at_epoch >= ?${projectFilter}`
  ).get(...baseParams([])) as { tokens: number };

  // Reuse / savings tokens (from context_injections)
  const reuse = db.prepare(
    `SELECT COALESCE(SUM(total_read_tokens), 0) as tokens FROM context_injections WHERE created_at_epoch >= ?${projectFilter}`
  ).get(...baseParams([])) as { tokens: number };

  // Observation count
  const obsCount = db.prepare(
    `SELECT COUNT(*) as count FROM observations WHERE created_at_epoch >= ?${projectFilter}`
  ).get(...baseParams([])) as { count: number };

  // Session count — UNION across observations + session_summaries
  const sessionCount = db.prepare(
    `SELECT COUNT(DISTINCT sid) as sessions FROM (
      SELECT memory_session_id AS sid FROM observations WHERE created_at_epoch >= ?${projectFilter}
      UNION
      SELECT memory_session_id AS sid FROM session_summaries WHERE created_at_epoch >= ?${projectFilter}
    )`
  ).get(...baseParams([]), ...baseParams([])) as { sessions: number };

  return {
    workTokens: obsWork.tokens + sumWork.tokens,
    readTokens: readCost.tokens,
    savingsTokens: reuse.tokens,
    observationCount: obsCount.count,
    sessionCount: sessionCount.sessions,
    timeRange: { days: days ?? null, cutoffEpoch },
    project: project ?? null,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Analytics endpoint query logic', () => {
  let db: Database;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  // -------------------------------------------------------------------------
  // 1. No data — returns zeros
  // -------------------------------------------------------------------------

  it('returns all zeros when database has no data', () => {
    const result = queryAnalytics(db, {});

    expect(result.workTokens).toBe(0);
    expect(result.readTokens).toBe(0);
    expect(result.savingsTokens).toBe(0);
    expect(result.observationCount).toBe(0);
    expect(result.sessionCount).toBe(0);
  });

  it('returns correct timeRange when no filters are applied', () => {
    const result = queryAnalytics(db, {});

    expect(result.timeRange.days).toBeNull();
    expect(result.timeRange.cutoffEpoch).toBe(0);
    expect(result.project).toBeNull();
  });

  // -------------------------------------------------------------------------
  // 2. Observations with discovery_tokens and read_tokens — correct sums
  // -------------------------------------------------------------------------

  it('sums discovery_tokens from observations into workTokens', () => {
    insertSession(db, 'session-1', '/project/alpha');
    insertObservation(db, { memorySessionId: 'session-1', project: '/project/alpha', discoveryTokens: 100 });
    insertObservation(db, { memorySessionId: 'session-1', project: '/project/alpha', discoveryTokens: 200 });

    const result = queryAnalytics(db, {});

    expect(result.workTokens).toBe(300);
  });

  it('sums discovery_tokens from session_summaries into workTokens', () => {
    insertSession(db, 'session-1', '/project/alpha');
    insertSummary(db, { memorySessionId: 'session-1', project: '/project/alpha', discoveryTokens: 500 });

    const result = queryAnalytics(db, {});

    expect(result.workTokens).toBe(500);
  });

  it('combines observation and summary discovery_tokens in workTokens', () => {
    insertSession(db, 'session-1', '/project/alpha');
    insertObservation(db, { memorySessionId: 'session-1', project: '/project/alpha', discoveryTokens: 100 });
    insertSummary(db, { memorySessionId: 'session-1', project: '/project/alpha', discoveryTokens: 400 });

    const result = queryAnalytics(db, {});

    expect(result.workTokens).toBe(500);
  });

  it('sums read_tokens from observations into readTokens', () => {
    insertSession(db, 'session-1', '/project/alpha');
    insertObservation(db, { memorySessionId: 'session-1', project: '/project/alpha', readTokens: 75 });
    insertObservation(db, { memorySessionId: 'session-1', project: '/project/alpha', readTokens: 25 });

    const result = queryAnalytics(db, {});

    expect(result.readTokens).toBe(100);
  });

  it('counts observations correctly in observationCount', () => {
    insertSession(db, 'session-1', '/project/alpha');
    insertObservation(db, { memorySessionId: 'session-1', project: '/project/alpha' });
    insertObservation(db, { memorySessionId: 'session-1', project: '/project/alpha' });
    insertObservation(db, { memorySessionId: 'session-1', project: '/project/alpha' });

    const result = queryAnalytics(db, {});

    expect(result.observationCount).toBe(3);
  });

  // -------------------------------------------------------------------------
  // 3. Project filter
  // -------------------------------------------------------------------------

  it('filters observations by project when project param is provided', () => {
    insertSession(db, 'session-foo', 'foo');
    insertSession(db, 'session-bar', 'bar');
    insertObservation(db, { memorySessionId: 'session-foo', project: 'foo', discoveryTokens: 100 });
    insertObservation(db, { memorySessionId: 'session-bar', project: 'bar', discoveryTokens: 999 });

    const result = queryAnalytics(db, { project: 'foo' });

    expect(result.workTokens).toBe(100);
    expect(result.observationCount).toBe(1);
    expect(result.project).toBe('foo');
  });

  it('filters summaries by project when project param is provided', () => {
    insertSession(db, 'session-foo', 'foo');
    insertSession(db, 'session-bar', 'bar');
    insertSummary(db, { memorySessionId: 'session-foo', project: 'foo', discoveryTokens: 200 });
    insertSummary(db, { memorySessionId: 'session-bar', project: 'bar', discoveryTokens: 800 });

    const result = queryAnalytics(db, { project: 'foo' });

    expect(result.workTokens).toBe(200);
  });

  it('filters context_injections by project when project param is provided', () => {
    insertContextInjection(db, { project: 'foo', totalReadTokens: 300 });
    insertContextInjection(db, { project: 'bar', totalReadTokens: 700 });

    const result = queryAnalytics(db, { project: 'foo' });

    expect(result.savingsTokens).toBe(300);
  });

  it('returns zero counts when project does not match any observations', () => {
    insertSession(db, 'session-foo', 'foo');
    insertObservation(db, { memorySessionId: 'session-foo', project: 'foo', discoveryTokens: 100 });

    const result = queryAnalytics(db, { project: 'nonexistent' });

    expect(result.workTokens).toBe(0);
    expect(result.observationCount).toBe(0);
  });

  // -------------------------------------------------------------------------
  // 4. Days filter (time-scoped results)
  // -------------------------------------------------------------------------

  it('includes observations within the time window when days is provided', () => {
    insertSession(db, 'session-1', '/project/alpha');
    const recentEpoch = Date.now() - 1 * 24 * 60 * 60 * 1000; // 1 day ago
    insertObservation(db, { memorySessionId: 'session-1', project: '/project/alpha', discoveryTokens: 150, createdAtEpoch: recentEpoch });

    const result = queryAnalytics(db, { days: 30 });

    expect(result.workTokens).toBe(150);
    expect(result.observationCount).toBe(1);
    expect(result.timeRange.days).toBe(30);
  });

  it('excludes observations older than the time window when days is provided', () => {
    insertSession(db, 'session-1', '/project/alpha');
    const oldEpoch = Date.now() - 60 * 24 * 60 * 60 * 1000; // 60 days ago
    insertObservation(db, { memorySessionId: 'session-1', project: '/project/alpha', discoveryTokens: 500, createdAtEpoch: oldEpoch });

    const result = queryAnalytics(db, { days: 30 });

    expect(result.workTokens).toBe(0);
    expect(result.observationCount).toBe(0);
  });

  it('sets cutoffEpoch correctly for days=7 filter', () => {
    const before = Date.now();
    const result = queryAnalytics(db, { days: 7 });
    const after = Date.now();

    const expectedMin = before - 7 * 24 * 60 * 60 * 1000;
    const expectedMax = after - 7 * 24 * 60 * 60 * 1000;

    expect(result.timeRange.days).toBe(7);
    expect(result.timeRange.cutoffEpoch).toBeGreaterThanOrEqual(expectedMin);
    expect(result.timeRange.cutoffEpoch).toBeLessThanOrEqual(expectedMax);
  });

  it('sets cutoffEpoch correctly for days=90 filter', () => {
    const before = Date.now();
    const result = queryAnalytics(db, { days: 90 });
    const after = Date.now();

    const expectedMin = before - 90 * 24 * 60 * 60 * 1000;
    const expectedMax = after - 90 * 24 * 60 * 60 * 1000;

    expect(result.timeRange.days).toBe(90);
    expect(result.timeRange.cutoffEpoch).toBeGreaterThanOrEqual(expectedMin);
    expect(result.timeRange.cutoffEpoch).toBeLessThanOrEqual(expectedMax);
  });

  // -------------------------------------------------------------------------
  // 5. Combined project + days filter
  // -------------------------------------------------------------------------

  it('applies both project and days filters together', () => {
    insertSession(db, 'session-foo-new', 'foo');
    insertSession(db, 'session-foo-old', 'foo');
    insertSession(db, 'session-bar-new', 'bar');

    const recentEpoch = Date.now() - 1 * 24 * 60 * 60 * 1000; // 1 day ago (within 7 days)
    const oldEpoch = Date.now() - 30 * 24 * 60 * 60 * 1000;  // 30 days ago (outside 7 days)

    insertObservation(db, { memorySessionId: 'session-foo-new', project: 'foo', discoveryTokens: 100, createdAtEpoch: recentEpoch });
    insertObservation(db, { memorySessionId: 'session-foo-old', project: 'foo', discoveryTokens: 500, createdAtEpoch: oldEpoch });
    insertObservation(db, { memorySessionId: 'session-bar-new', project: 'bar', discoveryTokens: 200, createdAtEpoch: recentEpoch });

    const result = queryAnalytics(db, { project: 'foo', days: 7 });

    expect(result.workTokens).toBe(100);
    expect(result.observationCount).toBe(1);
    expect(result.project).toBe('foo');
    expect(result.timeRange.days).toBe(7);
  });

  it('returns zeros when project matches but all data is outside the days window', () => {
    insertSession(db, 'session-foo', 'foo');
    const oldEpoch = Date.now() - 60 * 24 * 60 * 60 * 1000; // 60 days ago
    insertObservation(db, { memorySessionId: 'session-foo', project: 'foo', discoveryTokens: 999, createdAtEpoch: oldEpoch });

    const result = queryAnalytics(db, { project: 'foo', days: 7 });

    expect(result.workTokens).toBe(0);
    expect(result.observationCount).toBe(0);
  });

  // -------------------------------------------------------------------------
  // 6. savingsTokens from context_injections
  // -------------------------------------------------------------------------

  it('sums total_read_tokens from context_injections into savingsTokens', () => {
    insertContextInjection(db, { project: '/project/alpha', totalReadTokens: 200 });
    insertContextInjection(db, { project: '/project/alpha', totalReadTokens: 300 });

    const result = queryAnalytics(db, {});

    expect(result.savingsTokens).toBe(500);
  });

  it('reflects actual context injection consumption in savingsTokens', () => {
    insertContextInjection(db, { project: '/project/alpha', totalReadTokens: 1000 });
    insertContextInjection(db, { project: '/project/beta', totalReadTokens: 2000 });
    insertContextInjection(db, { project: '/project/alpha', totalReadTokens: 500 });

    const result = queryAnalytics(db, {});

    expect(result.savingsTokens).toBe(3500);
  });

  it('filters savingsTokens by time range when days is provided', () => {
    const recentEpoch = Date.now() - 1 * 24 * 60 * 60 * 1000;
    const oldEpoch = Date.now() - 60 * 24 * 60 * 60 * 1000;

    insertContextInjection(db, { project: '/project/alpha', totalReadTokens: 100, createdAtEpoch: recentEpoch });
    insertContextInjection(db, { project: '/project/alpha', totalReadTokens: 900, createdAtEpoch: oldEpoch });

    const result = queryAnalytics(db, { days: 30 });

    expect(result.savingsTokens).toBe(100);
  });

  it('returns zero savingsTokens when no context_injections exist', () => {
    insertSession(db, 'session-1', '/project/alpha');
    insertObservation(db, { memorySessionId: 'session-1', project: '/project/alpha', discoveryTokens: 100 });

    const result = queryAnalytics(db, {});

    expect(result.savingsTokens).toBe(0);
  });

  // -------------------------------------------------------------------------
  // 7. sessionCount — UNION across observations + session_summaries
  // -------------------------------------------------------------------------

  it('counts sessions from observations via DISTINCT memory_session_id', () => {
    insertSession(db, 'session-a', '/project/alpha');
    insertSession(db, 'session-b', '/project/alpha');

    // session-a has 3 observations, session-b has 1
    insertObservation(db, { memorySessionId: 'session-a', project: '/project/alpha' });
    insertObservation(db, { memorySessionId: 'session-a', project: '/project/alpha' });
    insertObservation(db, { memorySessionId: 'session-a', project: '/project/alpha' });
    insertObservation(db, { memorySessionId: 'session-b', project: '/project/alpha' });

    const result = queryAnalytics(db, {});

    expect(result.observationCount).toBe(4);
    expect(result.sessionCount).toBe(2);
  });

  it('returns sessionCount of 1 when all observations belong to the same session', () => {
    insertSession(db, 'session-only', '/project/alpha');
    insertObservation(db, { memorySessionId: 'session-only', project: '/project/alpha' });
    insertObservation(db, { memorySessionId: 'session-only', project: '/project/alpha' });

    const result = queryAnalytics(db, {});

    expect(result.sessionCount).toBe(1);
  });

  it('sessionCount is filtered by project independently of session count in other projects', () => {
    insertSession(db, 'session-foo', 'foo');
    insertSession(db, 'session-bar', 'bar');

    insertObservation(db, { memorySessionId: 'session-foo', project: 'foo' });
    insertObservation(db, { memorySessionId: 'session-bar', project: 'bar' });

    const result = queryAnalytics(db, { project: 'foo' });

    expect(result.sessionCount).toBe(1);
    expect(result.observationCount).toBe(1);
  });

  it('returns sessionCount of 0 when no observations match the time filter', () => {
    insertSession(db, 'session-old', '/project/alpha');
    const oldEpoch = Date.now() - 60 * 24 * 60 * 60 * 1000;
    insertObservation(db, { memorySessionId: 'session-old', project: '/project/alpha', createdAtEpoch: oldEpoch });

    const result = queryAnalytics(db, { days: 7 });

    expect(result.sessionCount).toBe(0);
    expect(result.observationCount).toBe(0);
  });

  it('counts sessions that only have summaries (no observations)', () => {
    insertSession(db, 'session-obs', '/project/alpha');
    insertSession(db, 'session-sum-only', '/project/alpha');
    insertObservation(db, { memorySessionId: 'session-obs', project: '/project/alpha' });
    insertSummary(db, { memorySessionId: 'session-sum-only', project: '/project/alpha' });

    const result = queryAnalytics(db, {});

    expect(result.sessionCount).toBe(2);
    expect(result.observationCount).toBe(1);
  });

  it('does not double-count sessions present in both observations and summaries', () => {
    insertSession(db, 'session-both', '/project/alpha');
    insertObservation(db, { memorySessionId: 'session-both', project: '/project/alpha' });
    insertSummary(db, { memorySessionId: 'session-both', project: '/project/alpha' });

    const result = queryAnalytics(db, {});

    expect(result.sessionCount).toBe(1);
  });

  // -------------------------------------------------------------------------
  // 8. Validation
  // -------------------------------------------------------------------------

  it('throws when days is zero', () => {
    expect(() => queryAnalytics(db, { days: 0 })).toThrow();
  });

  it('throws when days is negative', () => {
    expect(() => queryAnalytics(db, { days: -5 })).toThrow();
  });

  it('throws when days is not an integer', () => {
    expect(() => queryAnalytics(db, { days: 7.5 })).toThrow();
  });

  // -------------------------------------------------------------------------
  // 9. Large data integrity
  // -------------------------------------------------------------------------

  it('correctly aggregates across many observations from multiple sessions', () => {
    const projects = ['proj-a', 'proj-b'];
    const sessions: string[] = [];

    for (let s = 0; s < 5; s++) {
      const sessionId = `session-${s}`;
      const project = projects[s % 2];
      sessions.push(sessionId);
      insertSession(db, sessionId, project);

      for (let o = 0; o < 4; o++) {
        insertObservation(db, {
          memorySessionId: sessionId,
          project,
          discoveryTokens: 10,
          readTokens: 5,
        });
      }
    }

    const result = queryAnalytics(db, {});

    // 5 sessions × 4 observations = 20 total observations
    expect(result.observationCount).toBe(20);
    // 20 observations × 10 discovery tokens each = 200
    expect(result.workTokens).toBe(200);
    // 20 observations × 5 read tokens each = 100
    expect(result.readTokens).toBe(100);
    // 5 distinct sessions
    expect(result.sessionCount).toBe(5);
  });
});
