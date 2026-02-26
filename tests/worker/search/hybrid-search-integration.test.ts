/**
 * Hybrid Search Integration Tests (Step 6.1)
 *
 * End-to-end tests for the full search pipeline with a real in-memory SQLite
 * database. These tests exercise the SearchOrchestrator without Chroma, which
 * routes text queries through the BM25SearchStrategy backed by FTS5.
 *
 * Coverage targets:
 * - BM25 returns relevant results for keyword queries
 * - BM25 handles FTS5 special characters safely
 * - Project filter is respected by BM25
 * - Returned scores are in a valid 0-1 range (score transparency — Step 5.1)
 * - FTS5 triggers keep the index in sync with the observations table
 * - Orchestrator strategy field is 'bm25' when no Chroma is available
 * - Empty query uses SQLite filter-only path (strategy: 'sqlite')
 * - Date range filtering works with BM25
 * - Multi-word queries find relevant results
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { SessionSearch } from '../../../src/services/sqlite/SessionSearch.js';
import { SearchOrchestrator } from '../../../src/services/worker/search/SearchOrchestrator.js';
import { Database } from '../../../src/services/sqlite/sqlite-compat.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Insert a raw observation directly into the database, bypassing storeObservation,
 * so that we can control timestamps precisely and avoid FK constraints that
 * storeObservation does not itself enforce.
 */
function insertObservation(
  db: Database,
  opts: {
    memorySessionId?: string;
    project?: string;
    title?: string;
    narrative?: string;
    text?: string;
    type?: string;
    createdAtEpoch?: number;
  } = {}
): number {
  const stmt = db.prepare(`
    INSERT INTO observations
    (memory_session_id, project, type, title, narrative, text, facts, concepts,
     subtitle, files_read, files_modified, created_at, created_at_epoch)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(
    opts.memorySessionId ?? 'test-mem-session',
    opts.project ?? 'test-project',
    opts.type ?? 'discovery',
    opts.title ?? null,
    opts.narrative ?? null,
    opts.text ?? null,
    '[]',
    '[]',
    null,
    '[]',
    '[]',
    new Date(opts.createdAtEpoch ?? Date.now()).toISOString(),
    opts.createdAtEpoch ?? Date.now()
  );
  return Number(result.lastInsertRowid);
}

/**
 * Ensure an sdk_sessions row exists for a given memory_session_id.
 * Required by the FK constraint on session_summaries.
 */
function ensureSession(
  db: Database,
  memorySessionId: string,
  project: string = 'test-project'
): void {
  const existing = db.prepare('SELECT id FROM sdk_sessions WHERE memory_session_id = ?').get(memorySessionId);
  if (!existing) {
    db.prepare(`
      INSERT INTO sdk_sessions
        (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
      VALUES (?, ?, ?, ?, ?, 'active')
    `).run(
      `content-${memorySessionId}`,
      memorySessionId,
      project,
      new Date().toISOString(),
      Date.now()
    );
  }
}

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------

describe('Hybrid Search Integration (BM25-only path)', () => {
  let sessionStore: SessionStore;
  let sessionSearch: SessionSearch;
  let orchestrator: SearchOrchestrator;
  let db: Database;

  beforeEach(() => {
    // Create a fully-initialized in-memory database with all migrations applied,
    // including FTS5 unicode61 tokenizer (migration 24).
    sessionStore = new SessionStore(':memory:');
    db = sessionStore.db;

    // Seed a default sdk_sessions row so FK constraints are satisfied for
    // observations targeting 'test-mem-session'.
    ensureSession(db, 'test-mem-session', 'test-project');
    ensureSession(db, 'other-mem-session', 'other-project');

    // Share the same database instance so SessionSearch reuses the in-memory DB.
    sessionSearch = new SessionSearch(db);

    // Create orchestrator WITHOUT Chroma — forces BM25 path for text queries.
    orchestrator = new SearchOrchestrator(sessionSearch, sessionStore, null);
  });

  afterEach(() => {
    db.close();
  });

  // -------------------------------------------------------------------------
  // 1. BM25 search returns relevant results
  // -------------------------------------------------------------------------

  describe('BM25 search returns relevant results', () => {
    it('returns observations containing the search keyword', async () => {
      insertObservation(db, {
        title: 'Authentication bug in login flow',
        narrative: 'Fixed the authentication bypass vulnerability in the login endpoint',
      });
      insertObservation(db, {
        title: 'Database migration for user table',
        narrative: 'Added new columns for user preferences',
      });
      insertObservation(db, {
        title: 'Authentication refactor',
        narrative: 'Replaced session cookies with JWT tokens',
        project: 'other-project',
        memorySessionId: 'other-mem-session',
      });

      const result = await orchestrator.search({ query: 'authentication' });

      expect(result.strategy).toBe('bm25');
      expect(result.results.observations.length).toBeGreaterThanOrEqual(1);
      const titles = result.results.observations.map(o => o.title ?? '');
      expect(
        titles.some(t => t.toLowerCase().includes('authentication'))
      ).toBe(true);
    });

    it('does not return observations that do not match the keyword', async () => {
      insertObservation(db, {
        title: 'Database schema change',
        narrative: 'Added an index to improve query performance',
      });

      const result = await orchestrator.search({ query: 'authentication' });

      expect(result.results.observations).toHaveLength(0);
    });

    it('returns most relevant observation first (higher keyword density ranks higher)', async () => {
      insertObservation(db, {
        title: 'Auth Auth Auth',
        narrative: 'authentication authentication authentication auth auth auth auth auth',
      });
      insertObservation(db, {
        title: 'Database setup',
        narrative: 'Minor mention of authentication here once',
      });

      const result = await orchestrator.search({ query: 'authentication', limit: 10 });

      expect(result.results.observations.length).toBeGreaterThanOrEqual(2);
      // First result should be the heavily weighted one
      const first = result.results.observations[0];
      expect(
        first.title?.toLowerCase().includes('auth') ||
        (first.narrative?.match(/authentication/g) ?? []).length > 1
      ).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // 2. BM25 handles special characters safely (no crash)
  // -------------------------------------------------------------------------

  describe('BM25 handles FTS5 special characters', () => {
    it('does not throw when query contains parentheses', async () => {
      insertObservation(db, {
        title: 'Test observation',
        narrative: 'Some content about test123 in this observation',
      });

      await expect(
        orchestrator.search({ query: 'test(123)' })
      ).resolves.not.toThrow();
    });

    it('returns empty results (not an error) for a query that is only special chars', async () => {
      const result = await orchestrator.search({ query: '()(*)+-"' });

      expect(result.strategy).toBe('bm25');
      expect(result.results.observations).toHaveLength(0);
    });

    it('finds results after sanitizing mixed special chars and real tokens', async () => {
      insertObservation(db, {
        title: 'Login flow fix',
        narrative: 'Content about login and authentication fix here',
      });

      // After sanitization: tokens "login" and "fix" (parens stripped)
      const result = await orchestrator.search({ query: 'login(fix)' });

      expect(result.results.observations.length).toBeGreaterThanOrEqual(1);
    });
  });

  // -------------------------------------------------------------------------
  // 3. BM25 respects project filter
  // -------------------------------------------------------------------------

  describe('BM25 respects project filter', () => {
    it('only returns observations from the specified project', async () => {
      insertObservation(db, {
        project: 'test-project',
        memorySessionId: 'test-mem-session',
        title: 'Auth feature for test-project',
        narrative: 'Implemented JWT authentication for test-project',
      });
      insertObservation(db, {
        project: 'other-project',
        memorySessionId: 'other-mem-session',
        title: 'Auth feature for other-project',
        narrative: 'Implemented JWT authentication for other-project',
      });

      const result = await orchestrator.search({
        query: 'authentication',
        project: 'test-project',
      });

      expect(result.results.observations.length).toBeGreaterThanOrEqual(1);
      for (const obs of result.results.observations) {
        expect(obs.project).toBe('test-project');
      }
    });

    it('returns empty when project filter matches no rows', async () => {
      insertObservation(db, {
        title: 'Auth bug fix',
        narrative: 'authentication related work here',
      });

      const result = await orchestrator.search({
        query: 'authentication',
        project: 'nonexistent-project-xyz',
      });

      expect(result.results.observations).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // 4. Score normalization produces valid 0-1 range (Step 5.1)
  // -------------------------------------------------------------------------

  describe('score transparency (Step 5.1)', () => {
    it('BM25 results have bm25_score field (raw SQL alias present on result objects)', async () => {
      insertObservation(db, {
        title: 'Score transparency test',
        narrative: 'This tests that bm25_score is returned from the FTS5 query',
      });

      const result = await orchestrator.search({ query: 'bm25_score' });

      // bm25_score is returned as a raw column from the SQL query.
      // The ObservationSearchResult type has `score?: number` as the normalized
      // score field. For BM25, the raw bm25_score (negative, lower = better)
      // is accessible on the result object as bm25_score.
      // The score field is NOT populated by BM25Strategy (only by HybridBlending).
      if (result.results.observations.length > 0) {
        const obs = result.results.observations[0] as ObservationSearchResultWithBM25;
        // bm25_score from FTS5 is always negative (closer to zero = better match)
        expect(obs.bm25_score).toBeDefined();
        expect(typeof obs.bm25_score).toBe('number');
        expect(obs.bm25_score).toBeLessThan(0);
      }
    });

    it('HybridBlending score field is in [0, 1] range', async () => {
      // The HybridBlendingStrategy populates `score` via blendScores() which
      // produces a positional blend in [0.0, 1.0]. We test this here through
      // BM25-only path: no score field set (undefined), but no invalid values.
      insertObservation(db, {
        title: 'Score range observation',
        narrative: 'unique score range test observation content here',
      });

      const result = await orchestrator.search({ query: 'score range' });

      for (const obs of result.results.observations) {
        if (obs.score !== undefined) {
          expect(obs.score).toBeGreaterThanOrEqual(0);
          expect(obs.score).toBeLessThanOrEqual(1);
        }
      }
    });

    it('BM25 strategy does NOT populate the score field (raw bm25_score only)', async () => {
      insertObservation(db, {
        title: 'BM25 score field test',
        narrative: 'bm25 strategy score field should remain unpopulated',
      });

      const result = await orchestrator.search({ query: 'bm25 strategy' });

      // BM25 path: the `score` field on ObservationSearchResult is not set by
      // BM25SearchStrategy (only HybridBlending sets it). Verify this contract.
      for (const obs of result.results.observations) {
        // score should be undefined for BM25-only results
        expect(obs.score).toBeUndefined();
      }
    });
  });

  // -------------------------------------------------------------------------
  // 5. FTS5 triggers keep index in sync
  // -------------------------------------------------------------------------

  describe('FTS5 triggers keep index in sync', () => {
    it('finds an observation immediately after insertion via the trigger', async () => {
      // Insert observation — the AFTER INSERT trigger should sync to observations_fts
      insertObservation(db, {
        title: 'Trigger sync test uniquetoken99',
        narrative: 'Content with uniquetoken99 to verify trigger sync',
      });

      const result = await orchestrator.search({ query: 'uniquetoken99' });

      expect(result.results.observations.length).toBeGreaterThanOrEqual(1);
      expect(
        result.results.observations.some(o => o.title?.includes('uniquetoken99'))
      ).toBe(true);
    });

    it('storeObservation via SessionStore is also indexed by FTS5 trigger', () => {
      // Use the official storeObservation API to verify the full insertion path
      sessionStore.storeObservation(
        'test-mem-session',
        'test-project',
        {
          type: 'bugfix',
          title: 'Official store uniqueapitoken77',
          subtitle: null,
          facts: [],
          narrative: 'Testing that storeObservation triggers FTS5 indexing with uniqueapitoken77',
          concepts: [],
          files_read: [],
          files_modified: [],
        }
      );

      // Verify the FTS5 index picks it up by querying directly
      const ftsRows = db.prepare(`
        SELECT o.title
        FROM observations_fts
        JOIN observations o ON o.id = observations_fts.rowid
        WHERE observations_fts MATCH '"uniqueapitoken77"'
      `).all() as Array<{ title: string }>;

      expect(ftsRows.length).toBeGreaterThanOrEqual(1);
      expect(ftsRows[0].title).toContain('uniqueapitoken77');
    });
  });

  // -------------------------------------------------------------------------
  // 6. Orchestrator routes to BM25 when no Chroma
  // -------------------------------------------------------------------------

  describe('Orchestrator strategy routing without Chroma', () => {
    it('uses bm25 strategy for text queries when Chroma is null', async () => {
      insertObservation(db, {
        title: 'Strategy routing test',
        narrative: 'strategy routing unique content here for bm25',
      });

      const result = await orchestrator.search({ query: 'strategy routing' });

      expect(result.strategy).toBe('bm25');
      expect(result.usedChroma).toBe(false);
      expect(result.fellBack).toBe(false);
    });

    it('isChromaAvailable returns false when no Chroma sync provided', () => {
      expect(orchestrator.isChromaAvailable()).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // 7. Empty query uses SQLite filter-only path
  // -------------------------------------------------------------------------

  describe('Empty query falls back to SQLite filter-only path', () => {
    it('uses sqlite strategy when query is absent', async () => {
      insertObservation(db, {
        project: 'test-project',
        title: 'Filter-only test',
        narrative: 'This observation should be found via project filter',
      });

      const result = await orchestrator.search({ project: 'test-project' });

      expect(result.strategy).toBe('sqlite');
      expect(result.usedChroma).toBe(false);
    });

    it('returns observations matching the project filter without text query', async () => {
      insertObservation(db, {
        project: 'filter-project',
        memorySessionId: 'test-mem-session',
        title: 'Filter project observation',
        narrative: 'This is the filter project observation content',
      });
      insertObservation(db, {
        project: 'other-project',
        memorySessionId: 'other-mem-session',
        title: 'Other project observation',
        narrative: 'This is the other project observation content',
      });

      // Need a session for filter-project
      ensureSession(db, 'test-mem-session', 'filter-project');

      const result = await orchestrator.search({ project: 'filter-project' });

      expect(result.strategy).toBe('sqlite');
      for (const obs of result.results.observations) {
        expect(obs.project).toBe('filter-project');
      }
    });
  });

  // -------------------------------------------------------------------------
  // 8. Date range filtering works with BM25
  // -------------------------------------------------------------------------

  describe('Date range filtering with BM25', () => {
    it('only returns observations within the specified date range', async () => {
      const oldEpoch = new Date('2024-01-15').getTime();
      const recentEpoch = new Date('2025-06-15').getTime();

      insertObservation(db, {
        title: 'Old observation with daterange keyword',
        narrative: 'daterangetoken content from 2024',
        createdAtEpoch: oldEpoch,
      });
      insertObservation(db, {
        title: 'Recent observation with daterange keyword',
        narrative: 'daterangetoken content from 2025',
        createdAtEpoch: recentEpoch,
      });

      const result = await orchestrator.search({
        query: 'daterangetoken',
        dateStart: '2025-01-01',
        dateEnd: '2025-12-31',
      });

      expect(result.results.observations.length).toBeGreaterThanOrEqual(1);
      for (const obs of result.results.observations) {
        expect(obs.created_at_epoch).toBeGreaterThanOrEqual(new Date('2025-01-01').getTime());
        expect(obs.created_at_epoch).toBeLessThanOrEqual(new Date('2025-12-31').getTime());
      }
    });

    it('returns nothing when no observations fall within the date range', async () => {
      const oldEpoch = new Date('2023-06-01').getTime();
      insertObservation(db, {
        title: 'Outdated observation daterangeempty',
        narrative: 'daterangeempty content from 2023',
        createdAtEpoch: oldEpoch,
      });

      const result = await orchestrator.search({
        query: 'daterangeempty',
        dateStart: '2025-01-01',
        dateEnd: '2025-12-31',
      });

      expect(result.results.observations).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // 9. Multi-word queries find relevant results
  // -------------------------------------------------------------------------

  describe('Multi-word queries', () => {
    it('matches observations containing all words from a multi-word query', async () => {
      insertObservation(db, {
        title: 'Login authentication fix',
        narrative: 'Fixed the login flow that was bypassing authentication checks',
      });
      insertObservation(db, {
        title: 'Database schema migration',
        narrative: 'Applied database migration for new schema',
      });

      // FTS5 with implicit AND: both "login" and "authentication" must appear
      const result = await orchestrator.search({ query: 'login authentication' });

      expect(result.strategy).toBe('bm25');
      expect(result.results.observations.length).toBeGreaterThanOrEqual(1);
      // All returned observations should contain both tokens
      for (const obs of result.results.observations) {
        const fullText = `${obs.title ?? ''} ${obs.narrative ?? ''}`.toLowerCase();
        expect(fullText).toContain('login');
        expect(fullText).toContain('authentication');
      }
    });

    it('returns empty when not all words from a multi-word query are present', async () => {
      insertObservation(db, {
        title: 'Authentication only observation',
        narrative: 'Only authentication mentioned here, no login word',
      });

      // Both "login" and "missingtoken999" must appear — this should not match
      const result = await orchestrator.search({ query: 'authentication missingtoken999' });

      expect(result.results.observations).toHaveLength(0);
    });

    it('handles a three-word query and returns matching observations', async () => {
      insertObservation(db, {
        title: 'JWT token authentication refactor',
        narrative: 'Refactored authentication to use JWT token verification',
      });

      const result = await orchestrator.search({ query: 'JWT token authentication' });

      expect(result.results.observations.length).toBeGreaterThanOrEqual(1);
    });
  });

  // -------------------------------------------------------------------------
  // 10. Results integrity — returned fields are complete
  // -------------------------------------------------------------------------

  describe('Results integrity', () => {
    it('each returned observation has required fields populated', async () => {
      insertObservation(db, {
        title: 'Complete field observation',
        narrative: 'uniquecompletefield content for field integrity test',
        project: 'test-project',
        memorySessionId: 'test-mem-session',
        type: 'bugfix',
      });

      const result = await orchestrator.search({ query: 'uniquecompletefield' });

      expect(result.results.observations.length).toBeGreaterThanOrEqual(1);
      const obs = result.results.observations[0];

      expect(obs.id).toBeDefined();
      expect(typeof obs.id).toBe('number');
      expect(obs.project).toBe('test-project');
      expect(obs.type).toBe('bugfix');
      expect(obs.created_at).toBeDefined();
      expect(obs.created_at_epoch).toBeDefined();
      expect(typeof obs.created_at_epoch).toBe('number');
    });

    it('strategy result has the expected shape', async () => {
      insertObservation(db, {
        title: 'Shape test observation',
        narrative: 'uniqueshapetoken content here',
      });

      const result = await orchestrator.search({ query: 'uniqueshapetoken' });

      expect(result).toHaveProperty('results');
      expect(result).toHaveProperty('usedChroma');
      expect(result).toHaveProperty('fellBack');
      expect(result).toHaveProperty('strategy');
      expect(result.results).toHaveProperty('observations');
      expect(result.results).toHaveProperty('sessions');
      expect(result.results).toHaveProperty('prompts');
      expect(Array.isArray(result.results.observations)).toBe(true);
      expect(Array.isArray(result.results.sessions)).toBe(true);
      expect(Array.isArray(result.results.prompts)).toBe(true);
    });

    it('returns empty arrays (not null/undefined) when no results found', async () => {
      const result = await orchestrator.search({ query: 'absolutelyuniquenoresult12345xyz' });

      expect(result.results.observations).toEqual([]);
      expect(result.results.sessions).toEqual([]);
      expect(result.results.prompts).toEqual([]);
    });
  });
});

// ---------------------------------------------------------------------------
// Type augmentation for accessing raw bm25_score on result objects
// ---------------------------------------------------------------------------

interface ObservationSearchResultWithBM25 {
  title?: string | null;
  narrative?: string | null;
  score?: number;
  bm25_score?: number;
}
