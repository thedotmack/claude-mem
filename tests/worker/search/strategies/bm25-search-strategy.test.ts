/**
 * BM25SearchStrategy tests
 *
 * Uses a real in-memory SQLite database via SessionSearch(':memory:') so that
 * FTS5 BM25 queries execute against actual data rather than mocks. This gives
 * higher confidence that the SQL syntax, column weights, and ordering work
 * correctly end-to-end.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { BM25SearchStrategy } from '../../../../src/services/worker/search/strategies/BM25SearchStrategy.js';
import { SessionSearch } from '../../../../src/services/sqlite/SessionSearch.js';
import { SessionStore } from '../../../../src/services/sqlite/SessionStore.js';
import type { StrategySearchOptions } from '../../../../src/services/worker/search/types.js';
import { Database } from '../../../../src/services/sqlite/sqlite-compat.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Insert a test observation into the database and return the rowid.
 */
function insertObservation(
  db: Database,
  opts: {
    memorySessionId?: string;
    project?: string;
    title?: string;
    narrative?: string;
    text?: string;
    facts?: string;
    concepts?: string;
    subtitle?: string;
    type?: string;
    createdAtEpoch?: number;
  } = {}
): number {
  const stmt = db.prepare(`
    INSERT INTO observations
    (memory_session_id, project, type, title, narrative, text, facts, concepts, subtitle, created_at, created_at_epoch)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(
    opts.memorySessionId ?? 'test-mem-session',
    opts.project ?? 'test-project',
    opts.type ?? 'discovery',
    opts.title ?? null,
    opts.narrative ?? null,
    opts.text ?? null,
    opts.facts ?? null,
    opts.concepts ?? null,
    opts.subtitle ?? null,
    new Date().toISOString(),
    opts.createdAtEpoch ?? Date.now()
  );
  return Number(result.lastInsertRowid);
}

/**
 * Insert a test session summary into the database and return the rowid.
 * Creates a matching sdk_sessions row first to satisfy the FK constraint.
 */
function insertSessionSummary(
  db: Database,
  opts: {
    memorySessionId?: string;
    project?: string;
    request?: string;
    learned?: string;
    investigated?: string;
    completed?: string;
    notes?: string;
    createdAtEpoch?: number;
  } = {}
): number {
  const sessionId = opts.memorySessionId ?? `test-mem-session-${String(Date.now())}-${Math.random().toString(36).slice(2)}`;

  // Ensure the sdk_sessions row exists for the FK constraint
  const existingSession = db.prepare('SELECT id FROM sdk_sessions WHERE memory_session_id = ?').get(sessionId);
  if (!existingSession) {
    db.prepare(`
      INSERT INTO sdk_sessions
        (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
      VALUES (?, ?, ?, ?, ?, 'active')
    `).run(
      `content-${sessionId}`,
      sessionId,
      opts.project ?? 'test-project',
      new Date().toISOString(),
      Date.now()
    );
  }

  const stmt = db.prepare(`
    INSERT INTO session_summaries
    (memory_session_id, project, request, investigated, learned, completed, next_steps, notes, created_at, created_at_epoch)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(
    sessionId,
    opts.project ?? 'test-project',
    opts.request ?? null,
    opts.investigated ?? null,
    opts.learned ?? null,
    opts.completed ?? null,
    null,
    opts.notes ?? null,
    new Date().toISOString(),
    opts.createdAtEpoch ?? Date.now()
  );
  return Number(result.lastInsertRowid);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('BM25SearchStrategy', () => {
  let sessionSearch: SessionSearch;
  let sessionStore: SessionStore;
  let strategy: BM25SearchStrategy;
  let db: Database;

  beforeEach(() => {
    // SessionStore(':memory:') creates a fully-initialized in-memory DB with all
    // migrations including migration 24 (FTS5 with unicode61 tokenizer).
    sessionStore = new SessionStore(':memory:');
    db = sessionStore.db;

    // Insert a seed sdk_sessions row so that FK constraints are satisfied when
    // inserting test observations and session_summaries.
    db.prepare(`
      INSERT INTO sdk_sessions
        (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
      VALUES (?, ?, ?, ?, ?, 'active')
    `).run('test-content-session', 'test-mem-session', 'test-project', new Date().toISOString(), Date.now());

    // Pass the existing database object directly to SessionSearch so both share
    // the same in-memory database with all tables and FTS5 already set up.
    sessionSearch = new SessionSearch(db);

    strategy = new BM25SearchStrategy(sessionSearch, sessionStore);
  });

  afterEach(() => {
    db.close();
  });

  // -------------------------------------------------------------------------
  // canHandle
  // -------------------------------------------------------------------------

  describe('canHandle', () => {
    it('returns true when query text is present', () => {
      const options: StrategySearchOptions = { query: 'search term' };
      expect(strategy.canHandle(options)).toBe(true);
    });

    it('returns false when query is undefined', () => {
      const options: StrategySearchOptions = { project: 'some-project' };
      expect(strategy.canHandle(options)).toBe(false);
    });

    it('returns false when query is empty string', () => {
      const options: StrategySearchOptions = { query: '' };
      expect(strategy.canHandle(options)).toBe(false);
    });

    it('returns true when query is a multi-word phrase', () => {
      const options: StrategySearchOptions = { query: 'fix authentication bug' };
      expect(strategy.canHandle(options)).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // strategy.name
  // -------------------------------------------------------------------------

  describe('name', () => {
    it('has name "bm25"', () => {
      expect(strategy.name).toBe('bm25');
    });
  });

  // -------------------------------------------------------------------------
  // Empty query returns empty result
  // -------------------------------------------------------------------------

  describe('search with no query', () => {
    it('returns empty result when query is undefined', async () => {
      const options: StrategySearchOptions = {};
      const result = await strategy.search(options);

      expect(result.strategy).toBe('bm25');
      expect(result.usedChroma).toBe(false);
      expect(result.fellBack).toBe(false);
      expect(result.results.observations).toHaveLength(0);
      expect(result.results.sessions).toHaveLength(0);
      expect(result.results.prompts).toHaveLength(0);
    });

    it('returns empty result when query is empty string', async () => {
      const options: StrategySearchOptions = { query: '' };
      const result = await strategy.search(options);

      expect(result.results.observations).toHaveLength(0);
      expect(result.strategy).toBe('bm25');
    });
  });

  // -------------------------------------------------------------------------
  // Basic keyword search
  // -------------------------------------------------------------------------

  describe('search with matching query', () => {
    it('returns observations that match the query text', async () => {
      insertObservation(db, {
        title: 'Authentication refactor',
        narrative: 'Refactored the authentication system to use JWT tokens',
      });
      insertObservation(db, {
        title: 'Database migration',
        narrative: 'Applied schema migration for new user table',
      });

      const result = await strategy.search({ query: 'authentication' });

      expect(result.results.observations.length).toBeGreaterThanOrEqual(1);
      const titles = result.results.observations.map(o => o.title);
      expect(titles.some(t => t?.toLowerCase().includes('authentication'))).toBe(true);
    });

    it('returns empty observations when no rows match the query', async () => {
      insertObservation(db, {
        title: 'Database migration',
        narrative: 'Applied schema migration for new user table',
      });

      const result = await strategy.search({ query: 'xyznomatchunique99' });

      expect(result.results.observations).toHaveLength(0);
    });

    it('sets strategy to "bm25" on successful search', async () => {
      insertObservation(db, { title: 'Test observation', narrative: 'some content here' });

      const result = await strategy.search({ query: 'content' });

      expect(result.strategy).toBe('bm25');
      expect(result.usedChroma).toBe(false);
      expect(result.fellBack).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Project filter
  // -------------------------------------------------------------------------

  describe('project filter', () => {
    it('only returns observations from the specified project', async () => {
      insertObservation(db, {
        project: 'project-alpha',
        title: 'Alpha feature',
        narrative: 'Implemented a new authentication feature in project alpha',
      });
      insertObservation(db, {
        project: 'project-beta',
        title: 'Beta feature',
        narrative: 'Implemented a new authentication feature in project beta',
      });

      const result = await strategy.search({
        query: 'authentication',
        project: 'project-alpha',
      });

      expect(result.results.observations.length).toBeGreaterThanOrEqual(1);
      for (const obs of result.results.observations) {
        expect(obs.project).toBe('project-alpha');
      }
    });

    it('returns nothing when project filter matches no rows', async () => {
      insertObservation(db, {
        project: 'project-alpha',
        title: 'Alpha feature',
        narrative: 'Implemented a new authentication feature',
      });

      const result = await strategy.search({
        query: 'authentication',
        project: 'nonexistent-project',
      });

      expect(result.results.observations).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Date range filter
  // -------------------------------------------------------------------------

  describe('date range filter', () => {
    it('only returns observations within the date range', async () => {
      const oldEpoch = new Date('2024-01-01').getTime();
      const recentEpoch = new Date('2025-06-01').getTime();

      insertObservation(db, {
        title: 'Old observation',
        narrative: 'keyword uniquekeyword123 old content',
        createdAtEpoch: oldEpoch,
      });
      insertObservation(db, {
        title: 'Recent observation',
        narrative: 'keyword uniquekeyword123 recent content',
        createdAtEpoch: recentEpoch,
      });

      const result = await strategy.search({
        query: 'uniquekeyword123',
        dateRange: {
          start: new Date('2025-01-01').getTime(),
          end: new Date('2025-12-31').getTime(),
        },
      });

      expect(result.results.observations.length).toBeGreaterThanOrEqual(1);
      for (const obs of result.results.observations) {
        expect(obs.created_at_epoch).toBeGreaterThanOrEqual(new Date('2025-01-01').getTime());
      }
    });
  });

  // -------------------------------------------------------------------------
  // BM25 relevance ordering
  // -------------------------------------------------------------------------

  describe('BM25 relevance ordering', () => {
    it('returns the most relevant observation first', async () => {
      // Insert a highly relevant row (mention in both title and narrative)
      insertObservation(db, {
        title: 'Cache invalidation cache cache',
        narrative: 'This is about cache invalidation and cache strategies and cache busting cache',
      });
      // Insert a weakly relevant row (single mention)
      insertObservation(db, {
        title: 'Something unrelated',
        narrative: 'Minor mention of cache once',
      });

      const result = await strategy.search({ query: 'cache', limit: 10 });

      expect(result.results.observations.length).toBeGreaterThanOrEqual(2);
      // First result should be the heavily-weighted one
      const first = result.results.observations[0];
      expect(
        first.title?.includes('Cache') || first.narrative?.includes('cache cache')
      ).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // FTS5 special character escaping
  // -------------------------------------------------------------------------

  describe('FTS5 query sanitization', () => {
    it('does not throw when query contains FTS5 special characters', async () => {
      insertObservation(db, {
        title: 'Test with parens',
        narrative: 'Some content about test123 in this observation',
      });

      // These characters would cause FTS5 syntax errors if not sanitized
      await expect(
        strategy.search({ query: 'test(123)' })
      ).resolves.not.toThrow();
    });

    it('does not throw when query contains double quotes', async () => {
      await expect(
        strategy.search({ query: 'say "hello world"' })
      ).resolves.not.toThrow();
    });

    it('does not throw when query contains asterisks', async () => {
      await expect(
        strategy.search({ query: 'test*wildcard' })
      ).resolves.not.toThrow();
    });

    it('does not throw when query contains plus and minus operators', async () => {
      await expect(
        strategy.search({ query: 'feature +enhancement -bug' })
      ).resolves.not.toThrow();
    });

    it('still finds matching rows after sanitizing special chars', async () => {
      insertObservation(db, {
        title: 'Test observation',
        // Both "test" and "feature" are in the document so the sanitized query
        // "test" "feature" (implicit AND) matches this row.
        narrative: 'Content about test feature here',
      });

      const result = await strategy.search({ query: 'test(feature)' });
      // After sanitization: "test" "feature" — both tokens present, should match.
      expect(result.results.observations.length).toBeGreaterThanOrEqual(1);
    });
  });

  // -------------------------------------------------------------------------
  // searchType filter
  // -------------------------------------------------------------------------

  describe('searchType filter', () => {
    it('only returns observations when searchType is "observations"', async () => {
      insertObservation(db, {
        title: 'Relevant observation',
        narrative: 'uniqueterm for observations-only test',
      });
      insertSessionSummary(db, {
        request: 'uniqueterm for observations-only test',
        learned: 'something about uniqueterm',
      });

      const result = await strategy.search({
        query: 'uniqueterm',
        searchType: 'observations',
      });

      expect(result.results.observations.length).toBeGreaterThanOrEqual(1);
      expect(result.results.sessions).toHaveLength(0);
      expect(result.results.prompts).toHaveLength(0);
    });

    it('only returns sessions when searchType is "sessions"', async () => {
      insertObservation(db, {
        title: 'Relevant observation',
        narrative: 'sessionsearchterm for sessions-only test',
      });
      insertSessionSummary(db, {
        request: 'sessionsearchterm result',
        learned: 'something about sessionsearchterm',
      });

      const result = await strategy.search({
        query: 'sessionsearchterm',
        searchType: 'sessions',
      });

      expect(result.results.sessions.length).toBeGreaterThanOrEqual(1);
      expect(result.results.observations).toHaveLength(0);
      expect(result.results.prompts).toHaveLength(0);
    });

    it('returns both observations and sessions when searchType is "all"', async () => {
      insertObservation(db, {
        title: 'allsearchterm observation',
        narrative: 'Content with allsearchterm',
      });
      insertSessionSummary(db, {
        request: 'allsearchterm session summary',
        learned: 'Learned about allsearchterm',
      });

      const result = await strategy.search({
        query: 'allsearchterm',
        searchType: 'all',
      });

      expect(result.results.observations.length).toBeGreaterThanOrEqual(1);
      expect(result.results.sessions.length).toBeGreaterThanOrEqual(1);
    });
  });

  // -------------------------------------------------------------------------
  // Session summaries search
  // -------------------------------------------------------------------------

  describe('session summaries search', () => {
    it('finds session summaries matching the query', async () => {
      insertSessionSummary(db, {
        request: 'Implement BM25 keyword search',
        learned: 'FTS5 provides BM25 scoring for keyword relevance',
        investigated: 'BM25 algorithm in SQLite FTS5',
      });

      const result = await strategy.search({ query: 'BM25' });

      expect(result.results.sessions.length).toBeGreaterThanOrEqual(1);
    });

    it('returns empty sessions when no session summary matches', async () => {
      insertSessionSummary(db, {
        request: 'Database migration work',
        learned: 'Schema changes applied',
      });

      const result = await strategy.search({
        query: 'xyznomatchtermsessions99',
        searchType: 'sessions',
      });

      expect(result.results.sessions).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Database error handling
  // -------------------------------------------------------------------------

  describe('error handling', () => {
    it('returns empty result (not thrown) when a database error occurs', async () => {
      // Close the database to force an error on next query
      sessionSearch.close();

      const result = await strategy.search({ query: 'anything' });

      expect(result.strategy).toBe('bm25');
      expect(result.results.observations).toHaveLength(0);
      expect(result.results.sessions).toHaveLength(0);
      expect(result.results.prompts).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Limit parameter
  // -------------------------------------------------------------------------

  describe('limit parameter', () => {
    it('respects the limit for observations', async () => {
      for (let i = 0; i < 5; i++) {
        insertObservation(db, {
          title: `Observation ${String(i)}`,
          narrative: `limittest content for observation number ${String(i)}`,
        });
      }

      const result = await strategy.search({ query: 'limittest', limit: 2 });

      expect(result.results.observations.length).toBeLessThanOrEqual(2);
    });
  });
});
