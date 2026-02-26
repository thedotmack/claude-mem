# Implementation Plan: BM25 Hybrid Search

## Overview

Add FTS5 BM25 keyword search alongside existing Chroma vector search, with always-on hybrid blending. When a query has text, both Chroma semantic results and BM25 keyword results are fetched in parallel, normalized to 0-1 scores, and blended (0.6 vector + 0.4 keyword). When Chroma is unavailable, BM25 provides keyword-only fallback instead of zero results. The MCP search API contract remains unchanged.

## Requirements

- BM25 keyword search via SQLite FTS5 `bm25()` function with weighted columns
- Hybrid blending: parallel vector + keyword search, min-max normalized, weighted merge
- Graceful degradation: Chroma down = BM25 fallback; both down = filter-only
- No breaking changes to MCP search API (search/timeline/get_observations)
- Migration 24 to drop+recreate FTS5 tables with `unicode61` tokenizer
- Score metadata on results (`score` field already exists on result types)

## Delivery Strategy

current-branch (work directly on main)

## Architecture Changes (from Architect ADR)

- **New**: `src/services/worker/search/strategies/BM25SearchStrategy.ts` -- FTS5 query execution strategy
- **New**: `src/services/worker/search/strategies/HybridBlendingStrategy.ts` -- parallel execution + score blending
- **New**: `src/services/worker/search/strategies/scoring.ts` -- min-max normalization utilities
- **Modified**: `src/services/sqlite/SessionStore.ts` -- migration 24 (drop/recreate FTS5 with unicode61)
- **Modified**: `src/services/sqlite/migrations/runner.ts` -- migration 24 (parallel migration runner)
- **Modified**: `src/services/sqlite/SessionSearch.ts` -- update `ensureFTSTables()` docstring, remove "backward compat" messaging
- **Modified**: `src/services/worker/search/SearchOrchestrator.ts` -- add BM25 strategy, update decision tree
- **Modified**: `src/services/worker/search/types.ts` -- add `ScoredResult`, `ScoreMetadata`, update `SearchStrategyHint`
- **Modified**: `src/services/worker/search/index.ts` -- export new strategies
- **Modified**: `src/services/worker/SearchManager.ts` -- pass db reference for FTS5
- **Modified**: `src/services/worker/DatabaseManager.ts` -- expose db reference

## Implementation Steps

### Phase 1: Score Normalization Utilities (TDD Foundation)

#### Step 1.1: Create `scoring.ts` with min-max normalization

**Files:**
- Create: `src/services/worker/search/strategies/scoring.ts`
- Create: `tests/worker/search/strategies/scoring.test.ts`

**Action:** Implement pure utility functions for score normalization. These have zero dependencies and are the ideal TDD starting point.

```typescript
// Functions to implement:
export function normalizeMinMax(scores: number[], invert: boolean): number[]
export function blendScores(
  vectorScores: Map<number, number>,  // id -> normalized 0-1 score
  keywordScores: Map<number, number>, // id -> normalized 0-1 score
  vectorWeight: number,               // default 0.6
  keywordWeight: number               // default 0.4
): Map<number, number>                // id -> blended score
```

**Key behaviors to test:**
- `normalizeMinMax` with empty array returns empty array
- `normalizeMinMax` with single element returns `[1.0]`
- `normalizeMinMax` with identical scores returns all `1.0`
- `normalizeMinMax` with varied scores maps min to 0, max to 1
- `normalizeMinMax` with `invert=true` flips the scale (for BM25 where more negative = better)
- `blendScores` with overlapping IDs applies weighted average
- `blendScores` with non-overlapping IDs: vector-only items get `vectorWeight * vectorScore`, keyword-only items get `keywordWeight * keywordScore`
- `blendScores` with empty maps returns empty map
- Weights validation: must sum to 1.0 (or close)

**Complexity:** Low
**Risk:** Low
**Dependencies:** None

---

#### Step 1.2: Add types for scored results and search metadata

**Files:**
- Modify: `src/services/worker/search/types.ts`

**Action:** Add types needed by BM25 and hybrid strategies. The existing `StrategySearchResult` and result types already have `score` field support (confirmed in `src/services/sqlite/types.ts` -- `ObservationSearchResult.score?: number`).

**Types to add:**

```typescript
// Score source metadata for transparency
export interface ScoreMetadata {
  vectorScore?: number;   // 0-1 normalized Chroma distance
  keywordScore?: number;  // 0-1 normalized BM25 score
  blendedScore?: number;  // final blended score
}

// Internal scored result used during blending
export interface ScoredResult {
  id: number;
  type: 'observation' | 'session' | 'prompt';
  score: number;
  metadata?: ScoreMetadata;
}

// Update SearchStrategyHint to include 'bm25' | 'hybrid-blend'
export type SearchStrategyHint = 'chroma' | 'sqlite' | 'hybrid' | 'bm25' | 'hybrid-blend' | 'auto';
```

**Why:** The `StrategySearchResult.strategy` field needs to distinguish the new strategies from existing ones. The `ScoredResult` provides a common type for the blending pipeline.

**Complexity:** Low
**Risk:** Low -- additive type changes only, no existing code affected
**Dependencies:** None

---

### Phase 2: BM25 Foundation (Migration + Strategy)

#### Step 2.1: Migration 24 -- Recreate FTS5 tables with `unicode61` tokenizer

**Files:**
- Modify: `src/services/sqlite/SessionStore.ts` -- add `recreateFTSTablesWithUnicode61()` method, call from `initializeSchema()` chain
- Modify: `src/services/sqlite/migrations/runner.ts` -- add same migration
- Create: `tests/services/sqlite/migration-24-fts5.test.ts`

**Action:** Drop existing FTS5 tables (observations_fts, session_summaries_fts) and recreate with `unicode61` tokenizer. Also recreate triggers. This migration is safe because the existing FTS5 tables are not queried by any production code path (confirmed: `searchObservations` logs a warning and returns `[]` for text queries).

**Migration SQL pattern:**

```sql
-- Drop existing tables and triggers
DROP TRIGGER IF EXISTS observations_ai;
DROP TRIGGER IF EXISTS observations_ad;
DROP TRIGGER IF EXISTS observations_au;
DROP TABLE IF EXISTS observations_fts;

-- Recreate with unicode61 tokenizer
CREATE VIRTUAL TABLE observations_fts USING fts5(
  title,
  narrative,
  facts,
  concepts,
  subtitle,
  text,
  content='observations',
  content_rowid='id',
  tokenize='unicode61'
);

-- Repopulate from existing data
INSERT INTO observations_fts(rowid, title, narrative, facts, concepts, subtitle, text)
SELECT id, COALESCE(title,''), COALESCE(narrative,''), COALESCE(facts,''), COALESCE(concepts,''), COALESCE(subtitle,''), COALESCE(text,'')
FROM observations;

-- Recreate triggers (same pattern as before, updated column order)
CREATE TRIGGER observations_ai AFTER INSERT ON observations BEGIN
  INSERT INTO observations_fts(rowid, title, narrative, facts, concepts, subtitle, text)
  VALUES (new.id, new.title, new.narrative, new.facts, new.concepts, new.subtitle, new.text);
END;

CREATE TRIGGER observations_ad AFTER DELETE ON observations BEGIN
  INSERT INTO observations_fts(observations_fts, rowid, title, narrative, facts, concepts, subtitle, text)
  VALUES('delete', old.id, old.title, old.narrative, old.facts, old.concepts, old.subtitle, old.text);
END;

CREATE TRIGGER observations_au AFTER UPDATE ON observations BEGIN
  INSERT INTO observations_fts(observations_fts, rowid, title, narrative, facts, concepts, subtitle, text)
  VALUES('delete', old.id, old.title, old.narrative, old.facts, old.concepts, old.subtitle, old.text);
  INSERT INTO observations_fts(rowid, title, narrative, facts, concepts, subtitle, text)
  VALUES (new.id, new.title, new.narrative, new.facts, new.concepts, new.subtitle, new.text);
END;
```

**CRITICAL:** Column order in `observations_fts` must match the `bm25()` weight order:
1. title (weight 10.0)
2. narrative (weight 5.0)
3. facts (weight 3.0)
4. concepts (weight 2.0)
5. subtitle (weight 1.0)
6. text (weight 1.0)

**Also recreate `session_summaries_fts`** with same `unicode61` tokenizer and updated triggers.

**Tests:**
- Fresh database gets FTS5 tables with unicode61 tokenizer
- Migration is idempotent (running twice is safe)
- Existing data is preserved and repopulated into FTS5
- Triggers fire correctly on INSERT/UPDATE/DELETE
- `bm25()` function works on the new table structure
- Version 24 recorded in schema_versions

**Complexity:** Medium
**Risk:** Medium -- touches database schema, but existing FTS5 tables are unused
**Dependencies:** None

---

#### Step 2.2: Update `SessionSearch.ensureFTSTables()` documentation

**Files:**
- Modify: `src/services/sqlite/SessionSearch.ts`

**Action:** Update the `ensureFTSTables()` docstring to reflect that FTS5 is now actively used for BM25 search (remove "backward compatibility only", "TODO: Remove FTS5 infrastructure", "no longer used for search" comments). The method itself needs no logic changes -- it only creates tables if they don't exist, and migration 24 handles the unicode61 recreation.

**Complexity:** Low
**Risk:** Low -- documentation only
**Dependencies:** Step 2.1

---

#### Step 2.3: Create `BM25SearchStrategy`

**Files:**
- Create: `src/services/worker/search/strategies/BM25SearchStrategy.ts`
- Create: `tests/worker/search/strategies/bm25-search-strategy.test.ts`

**Action:** Implement the BM25 keyword search strategy using FTS5 `bm25()` function.

**Constructor dependencies:**
- `sessionSearch: SessionSearch` -- needed for filter-only operations and the `db` reference (SessionSearch.db is the same database)
- `sessionStore: SessionStore` -- needed for hydrating results by ID

**NOTE on db access:** `SessionSearch` already has `private db: Database`. For BM25 queries, we need to either:
- (a) Make `SessionSearch.db` accessible (add a getter), or
- (b) Accept a `Database` reference directly in BM25SearchStrategy constructor

Option (a) is cleaner because it avoids opening a separate connection. Add a public `getDb(): Database` getter on `SessionSearch`.

**BM25 query execution:**

```typescript
async search(options: StrategySearchOptions): Promise<StrategySearchResult> {
  // 1. Sanitize query for FTS5 MATCH syntax
  // 2. Execute BM25 query with column weights
  // 3. Apply project/date/type filters via JOIN
  // 4. Return results with BM25 scores populated
}
```

**FTS5 MATCH query sanitization:**
- Escape special FTS5 characters: `"`, `*`, `(`, `)`, `+`, `-`, `NEAR`
- Split query into tokens, wrap each in quotes for exact matching
- Join with implicit AND (FTS5 default)

**SQL pattern (observations):**

```sql
SELECT o.*, bm25(observations_fts, 10.0, 5.0, 3.0, 2.0, 1.0, 1.0) AS bm25_score
FROM observations_fts
JOIN observations o ON o.id = observations_fts.rowid
WHERE observations_fts MATCH ?
  AND (? IS NULL OR o.project = ?)
  AND (? IS NULL OR o.created_at_epoch >= ?)
  AND (? IS NULL OR o.created_at_epoch <= ?)
ORDER BY bm25_score ASC
LIMIT ?
```

BM25 scores are negative (more negative = better), so `ORDER BY bm25_score ASC`.

**Tests:**
- `canHandle` returns true when query text is present
- `canHandle` returns false when no query text
- Search with matching query returns observations with bm25_score
- Search with non-matching query returns empty results
- Project filter is applied correctly
- Date range filter is applied correctly
- Results are ordered by BM25 relevance (most negative first)
- FTS5 special characters are escaped properly
- Empty query returns empty result
- Database errors are caught and return empty result with error logging

**Complexity:** Medium
**Risk:** Medium -- new strategy, but follows established pattern
**Dependencies:** Step 1.1 (scoring.ts for normalization), Step 2.1 (migration for unicode61 tables)

---

### Phase 3: Hybrid Blending

#### Step 3.1: Create `HybridBlendingStrategy`

**Files:**
- Create: `src/services/worker/search/strategies/HybridBlendingStrategy.ts`
- Create: `tests/worker/search/strategies/hybrid-blending-strategy.test.ts`

**Action:** Implement the hybrid blending strategy that runs Chroma and BM25 in parallel, normalizes scores, and blends results.

**Constructor dependencies:**
- `chromaSync: ChromaSync` -- for vector search
- `sessionStore: SessionStore` -- for hydrating results
- `bm25Strategy: BM25SearchStrategy` -- for keyword search
- `chromaStrategy: ChromaSearchStrategy` -- reuse existing Chroma logic

**Execution flow:**

```
1. Run Chroma query and BM25 query in parallel (Promise.all)
2. Extract IDs + raw scores from each
3. Normalize Chroma distances to 0-1 (lower distance = higher score, so invert)
4. Normalize BM25 scores to 0-1 (more negative = better, so invert)
5. Blend: 0.6 * vectorScore + 0.4 * keywordScore
6. Sort by blended score descending
7. Hydrate top-N from SQLite
8. Populate score field on results
```

**Key design decisions:**
- If Chroma fails during parallel execution, fall back to BM25-only results
- If BM25 fails, fall back to Chroma-only results
- If both fail, return empty with `fellBack: true`
- Results that appear in both sets get blended scores; results in only one set get partial scores (weighted by that source's weight)

**Tests:**
- `canHandle` returns true when query is present and Chroma is available
- Parallel execution: both strategies called concurrently (verify with timing or mock inspection)
- Score normalization applied correctly to both result sets
- Blended scores use 0.6/0.4 weights
- Results sorted by blended score descending
- Chroma failure degrades to BM25-only
- BM25 failure degrades to Chroma-only
- Both failures return empty result with fellBack=true
- Deduplication: same observation ID from both sources gets one result with blended score
- Limit applied after blending (not before)
- Strategy field set to 'hybrid-blend'

**Complexity:** High
**Risk:** Medium -- orchestration logic, but each component is tested independently
**Dependencies:** Step 1.1 (scoring.ts), Step 2.3 (BM25SearchStrategy)

---

#### Step 3.2: Update `SearchOrchestrator` decision tree

**Files:**
- Modify: `src/services/worker/search/SearchOrchestrator.ts`
- Modify: `tests/worker/search/search-orchestrator.test.ts`

**Action:** Update the orchestrator to use `HybridBlendingStrategy` for query-text paths and `BM25SearchStrategy` as Chroma-down fallback.

**New decision tree:**

```
executeWithFallback(options):
  PATH 1: No query text -> SQLiteSearchStrategy (unchanged)
  PATH 2: Query text + Chroma available -> HybridBlendingStrategy (NEW)
  PATH 3: Query text + Chroma unavailable -> BM25SearchStrategy (NEW, was: empty results)
```

**Constructor changes:**
- Accept `Database` reference (from SessionSearch) for BM25Strategy
- Create BM25SearchStrategy always (it only needs SQLite, not Chroma)
- Create HybridBlendingStrategy when Chroma is available

**Updated constructor:**

```typescript
constructor(
  private sessionSearch: SessionSearch,
  private sessionStore: SessionStore,
  private chromaSync: ChromaSync | null
) {
  this.sqliteStrategy = new SQLiteSearchStrategy(sessionSearch);
  this.bm25Strategy = new BM25SearchStrategy(sessionSearch, sessionStore);

  if (chromaSync) {
    this.chromaStrategy = new ChromaSearchStrategy(chromaSync, sessionStore);
    this.hybridStrategy = new HybridSearchStrategy(chromaSync, sessionStore, sessionSearch);
    this.hybridBlendingStrategy = new HybridBlendingStrategy(
      chromaSync, sessionStore, this.bm25Strategy, this.chromaStrategy
    );
  }
}
```

**Tests (update existing + add new):**
- Existing PATH 1 tests pass unchanged (filter-only -> SQLite)
- PATH 2: query + Chroma -> uses HybridBlendingStrategy
- PATH 3: query + no Chroma -> uses BM25SearchStrategy (instead of empty)
- Fallback: HybridBlending fails -> BM25 fallback
- Strategy name propagated correctly in result
- Existing findByConcept/findByType/findByFile behavior unchanged

**Complexity:** Medium
**Risk:** Medium -- modifies core orchestration, but old paths preserved
**Dependencies:** Step 3.1 (HybridBlendingStrategy), Step 2.3 (BM25SearchStrategy)

---

### Phase 4: Wiring and Integration

#### Step 4.1: Expose `db` from `SessionSearch`

**Files:**
- Modify: `src/services/sqlite/SessionSearch.ts`

**Action:** Add a public getter for the database connection so BM25SearchStrategy can execute FTS5 queries on the same connection.

```typescript
getDb(): Database {
  return this.db;
}
```

**Complexity:** Low
**Risk:** Low -- read-only access, same connection
**Dependencies:** None (can be done early)

---

#### Step 4.2: Update `DatabaseManager` to expose db reference

**Files:**
- Modify: `src/services/worker/DatabaseManager.ts`

**Action:** No changes needed beyond what already exists. The `getSessionSearch()` method already returns the `SessionSearch` instance, and Step 4.1 adds the `getDb()` getter. The `SearchOrchestrator` receives `sessionSearch` in its constructor and can call `sessionSearch.getDb()` internally if needed.

Actually, a cleaner approach: `BM25SearchStrategy` takes `sessionSearch` in its constructor and calls `sessionSearch.getDb()` internally. No `DatabaseManager` changes needed.

**Complexity:** None (removed -- not needed)
**Risk:** None
**Dependencies:** Step 4.1

---

#### Step 4.3: Update `SearchManager` constructor wiring

**Files:**
- Modify: `src/services/worker/SearchManager.ts`

**Action:** No constructor signature changes needed. `SearchManager` already passes `sessionSearch`, `sessionStore`, and `chromaSync` to `SearchOrchestrator`. The orchestrator handles all internal wiring of strategies.

Verify: the existing `SearchManager` constructor creates `SearchOrchestrator` with the right arguments. Already confirmed: `this.orchestrator = new SearchOrchestrator(sessionSearch, sessionStore, chromaSync)` -- this is unchanged.

**Complexity:** None (verification only)
**Risk:** None
**Dependencies:** Step 3.2

---

#### Step 4.4: Update `search/index.ts` exports

**Files:**
- Modify: `src/services/worker/search/index.ts`

**Action:** Add exports for new strategies and utilities:

```typescript
export { BM25SearchStrategy } from './strategies/BM25SearchStrategy.js';
export { HybridBlendingStrategy } from './strategies/HybridBlendingStrategy.js';
export { normalizeMinMax, blendScores } from './strategies/scoring.js';
```

**Complexity:** Low
**Risk:** Low -- additive exports only
**Dependencies:** Steps 1.1, 2.3, 3.1

---

### Phase 5: Score Transparency

#### Step 5.1: Populate `score` field on search results

**Files:**
- Modify: `src/services/worker/search/strategies/HybridBlendingStrategy.ts`
- Modify: `src/services/worker/search/strategies/BM25SearchStrategy.ts`
- Modify: `src/services/worker/search/strategies/ChromaSearchStrategy.ts`

**Action:** Ensure the `score` field (already defined on `ObservationSearchResult`, `SessionSummarySearchResult`, `UserPromptSearchResult`) is populated with the normalized score when results pass through search strategies.

- `BM25SearchStrategy`: populate `score` with normalized BM25 score (0-1, higher is better)
- `ChromaSearchStrategy`: populate `score` with normalized Chroma distance (0-1, higher is better)
- `HybridBlendingStrategy`: populate `score` with blended score

**Tests:**
- BM25 results have `score` field populated (0-1 range)
- Chroma results have `score` field populated (0-1 range)
- Hybrid results have `score` field with blended value
- Score is stable across identical queries

**Complexity:** Low
**Risk:** Low -- field already exists on types, just needs populating
**Dependencies:** Steps 2.3, 3.1

---

### Phase 6: Integration Tests

#### Step 6.1: End-to-end search integration test

**Files:**
- Create: `tests/worker/search/hybrid-search-integration.test.ts`

**Action:** Integration test that exercises the full search pipeline with a real SQLite database (no Chroma mock). Verifies:

- BM25 search returns results for known keywords
- BM25 handles special characters gracefully
- BM25 respects project/date/type filters
- Score normalization produces valid 0-1 range
- FTS5 triggers keep index in sync after INSERT/UPDATE/DELETE

**This test uses a temporary in-memory or temp-file database:**
1. Create SessionStore + SessionSearch with temp db
2. Insert test observations with known text
3. Run migration 24
4. Execute BM25 searches
5. Verify results

**Complexity:** Medium
**Risk:** Low -- isolated test environment
**Dependencies:** All Phase 1-4 steps

---

## Testing Strategy

### Unit Tests (per-step)
- `tests/worker/search/strategies/scoring.test.ts` -- normalization and blending math
- `tests/worker/search/strategies/bm25-search-strategy.test.ts` -- FTS5 query execution
- `tests/worker/search/strategies/hybrid-blending-strategy.test.ts` -- parallel execution + score merge
- `tests/worker/search/search-orchestrator.test.ts` -- updated decision tree tests
- `tests/services/sqlite/migration-24-fts5.test.ts` -- migration correctness

### Integration Tests
- `tests/worker/search/hybrid-search-integration.test.ts` -- full pipeline with real SQLite

### Regression Tests
- Run full test suite (1956 tests) after each phase to catch regressions
- Verify existing search orchestrator tests pass unchanged
- Verify existing strategy tests pass unchanged

## Risks & Mitigations

- **Risk:** FTS5 `bm25()` function behavior differs across SQLite versions
  - Mitigation: Test with the exact `better-sqlite3` / `bun:sqlite` version used in the project. The `bm25()` function is stable in SQLite 3.9.0+ (2015).

- **Risk:** Migration 24 drops and recreates FTS5 tables, potentially causing data loss during concurrent writes
  - Mitigation: Migration runs in a transaction. FTS5 content tables use `content=` sync (external content tables), so the source data in `observations` is never touched. Only the FTS5 index is rebuilt.

- **Risk:** FTS5 MATCH syntax errors from user queries with special characters
  - Mitigation: Sanitize queries in `BM25SearchStrategy` by escaping/quoting tokens before passing to MATCH. Test with edge cases: empty strings, SQL injection attempts, FTS5 operators, Unicode.

- **Risk:** Score blending produces unexpected rankings for some queries
  - Mitigation: Start with 0.6/0.4 weights (architect recommendation). Log score metadata for debugging. Phase 4 (deferred) will add configurable weights.

- **Risk:** Performance regression from parallel Chroma + BM25 execution
  - Mitigation: BM25 queries are 1-5ms on SQLite (index scan). Chroma queries are 55-210ms. Parallel execution means total latency is max(Chroma, BM25) which is essentially unchanged.

- **Risk:** Dual migration paths (SessionStore + MigrationRunner) get out of sync
  - Mitigation: Add migration 24 to both files. Follow existing pattern where each path checks `schema_versions` before running.

## Success Criteria

- [ ] `scoring.ts` utility functions pass all unit tests with edge cases
- [ ] Migration 24 creates FTS5 tables with unicode61 tokenizer and correct column order
- [ ] `BM25SearchStrategy` returns relevant keyword matches ordered by BM25 score
- [ ] `HybridBlendingStrategy` runs both strategies in parallel and blends scores correctly
- [ ] `SearchOrchestrator` routes query-text searches through hybrid blending
- [ ] When Chroma is unavailable, queries fall back to BM25-only (not empty results)
- [ ] All 1956 existing tests pass without modification
- [ ] New tests cover normalization, BM25, hybrid blending, orchestrator routing, and migration
- [ ] `score` field populated on search results
- [ ] MCP search API contract unchanged (search/timeline/get_observations work identically)

## Implementation Order Summary

```
Phase 1: Foundation (no dependencies)
  1.1 scoring.ts           -- pure math utilities, TDD starting point
  1.2 types.ts updates     -- additive types

Phase 2: BM25 Core (depends on Phase 1)
  2.1 Migration 24         -- FTS5 with unicode61
  2.2 SessionSearch docs   -- docstring cleanup
  2.3 BM25SearchStrategy   -- FTS5 query execution

Phase 3: Hybrid Blending (depends on Phase 2)
  3.1 HybridBlendingStrategy -- parallel execution + blending
  3.2 SearchOrchestrator   -- updated decision tree

Phase 4: Wiring (depends on Phase 3)
  4.1 SessionSearch.getDb() -- expose db reference
  4.4 index.ts exports     -- export new modules

Phase 5: Score Transparency (depends on Phase 4)
  5.1 Populate score fields -- on all strategy results

Phase 6: Integration Tests (depends on all phases)
  6.1 Full pipeline test   -- end-to-end with real SQLite
```

**Note:** Step 4.1 (SessionSearch.getDb()) can be done as early as Phase 1 since it has no dependencies. It is listed in Phase 4 for logical grouping but should be implemented whenever BM25SearchStrategy needs it (Step 2.3).

## Deferred (Phase 4 from Architect -- Tuning)

The architect proposed a Phase 4 for configurable weights via settings. This is explicitly deferred and not included in this plan. The hardcoded defaults (0.6/0.4 blend weights, column weights 10/5/3/2/1/1) can be adjusted in a future iteration once we have real-world usage data.
