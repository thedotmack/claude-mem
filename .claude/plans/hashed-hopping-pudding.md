# Wire SearchOrchestrator into Live Search + RRF Scoring Upgrade

## Context

BM25 hybrid search (ChromaSearchStrategy + BM25SearchStrategy + HybridBlendingStrategy) is fully implemented and tested (137+ tests pass), but **not live**. `SearchManager.search()` uses its own inline Chroma-direct code path (PATH 2) that bypasses the orchestrator entirely. The orchestrator is instantiated in SearchManager (`this.orchestrator`) but `search()` is never called.

Additionally, HybridBlendingStrategy uses positional scoring `(N-i)/N` with weighted blend (0.6/0.4) which is N-dependent and requires manual weight tuning. RRF (Reciprocal Rank Fusion) is the industry standard (Elasticsearch, Pinecone, Weaviate) — parameter-free, stable, and strictly better for rank fusion.

This plan wires the orchestrator into the live search path and upgrades scoring to RRF + Top-Rank Bonus.

## Changes

### Step 1: Add RRF scoring functions to `scoring.ts`

**File**: `src/services/worker/search/strategies/scoring.ts`

Add two new functions:

- **`rrfScore(rankers, k=60)`** — Given an array of `Map<id, rank>` (1-indexed), returns `Map<id, rrfScore>` where `score(d) = Σ 1/(k + rank_i(d))`. IDs appearing in multiple rankers accumulate scores.
- **`topRankBonus(rankers, topK=5, bonus=0.003)`** — Returns `Map<id, bonus>` for IDs that appear in the top-K of ALL rankers. Rewards cross-ranker agreement.

Existing `blendScores()` and `normalizeMinMax()` are kept (not removed) for backward compatibility with any other callers.

**Tests**: `tests/worker/search/strategies/scoring.test.ts` — add test cases for:
- Single ranker → RRF scores = 1/(k+rank) for each item
- Two rankers, shared + disjoint IDs → accumulation
- k parameter effect on score distribution
- Top-rank bonus: items in top-5 of both rankers get bonus, others don't
- Edge cases: empty rankers, single-item rankers

### Step 2: Upgrade HybridBlendingStrategy to RRF

**File**: `src/services/worker/search/strategies/HybridBlendingStrategy.ts`

Replace `mergeAndBlend()` internals:
- **Before**: Positional scoring `(N-i)/N` → `blendScores(vectorScores, keywordScores, 0.6, 0.4)`
- **After**: Build 1-indexed rank maps → `rrfScore([vectorRanks, keywordRanks])` → `topRankBonus([vectorRanks, keywordRanks])` → sum bonuses into RRF scores

Remove unused imports (`blendScores`), remove `VECTOR_WEIGHT`/`KEYWORD_WEIGHT` constants.

Update the file's JSDoc header to reflect RRF instead of positional scoring.

**Tests**: `tests/worker/search/strategies/hybrid-blending-strategy.test.ts` — update:
- Score assertions to use RRF formula instead of positional blend
- Add test: items appearing in both Chroma and BM25 results score higher than single-source items
- Add test: top-rank bonus applied when item in top-5 of both

### Step 3: Fix ChromaSearchStrategy dateRange handling

**File**: `src/services/worker/search/strategies/ChromaSearchStrategy.ts`

**Gap found**: `filterByRecency()` uses hardcoded 90-day window and ignores user-specified `dateRange`. When wired through the orchestrator, date-filtered searches would lose user date ranges.

Fix `filterByRecency()` (or rename to `filterByDateRange()`) to:
1. If `options.dateRange` is provided: use `dateRange.start`/`dateRange.end` as bounds
2. If no dateRange: use existing 90-day default recency window

**Tests**: Add test cases in ChromaSearchStrategy tests for user-specified dateRange.

### Step 4: Wire `SearchManager.search()` to orchestrator

**File**: `src/services/worker/SearchManager.ts`

Replace lines 239-329 (PATH 1 + PATH 2 execution) with:

```typescript
// Delegate to orchestrator for strategy selection + execution
const result = await this.orchestrator.search(args as Record<string, unknown>);
observations = result.results.observations;
sessions = result.results.sessions;
prompts = result.results.prompts;
```

**Keep unchanged**: All formatting code (lines 331-451) — combine, sort, group by date, group by file, render tables. The orchestrator returns the same `observations`/`sessions`/`prompts` arrays that the inline code did.

**Remove**: The inline PATH 1 / PATH 2 logic (lines 239-329) — this is fully replaced by the orchestrator's decision tree (SQLite for filter-only, HybridBlend for query+Chroma, BM25 for query-only).

**Note**: `queryChroma()` method stays — it's still used by 11 other methods (`timeline()`, `decisions()`, `findByConcept()`, etc.). Only `search()` moves to the orchestrator.

**Tests**: `tests/worker/search/search-orchestrator.test.ts` — existing tests already cover orchestrator behavior. Add a lightweight integration test verifying SearchManager.search() delegates to orchestrator:
- Mock orchestrator.search() → verify it's called with the right args
- Verify formatting still works on orchestrator results

### Step 5: Clean up dead code

After wiring:
- Remove the `// chromaSucceeded tracking removed` comment (line 256)
- Remove `SEARCH_CONSTANTS` import from SearchManager if no longer used there
- Remove unused local type imports if any

## Key Files

| File | Change |
|------|--------|
| `src/services/worker/search/strategies/scoring.ts` | Add `rrfScore()`, `topRankBonus()` |
| `src/services/worker/search/strategies/HybridBlendingStrategy.ts` | Replace positional+blend with RRF+bonus |
| `src/services/worker/search/strategies/ChromaSearchStrategy.ts` | Fix dateRange handling in filterByRecency |
| `src/services/worker/SearchManager.ts` | Wire search() to orchestrator |
| `tests/worker/search/strategies/scoring.test.ts` | Tests for rrfScore, topRankBonus |
| `tests/worker/search/strategies/hybrid-blending-strategy.test.ts` | Update score assertions to RRF |
| `tests/worker/search/search-orchestrator.test.ts` | Integration test for wiring |

## Verification

1. `npx tsc --noEmit` — zero errors
2. `npm run lint` — zero errors
3. `npm test` — all ~2092 tests pass
4. `npm run build` — build succeeds
5. Manual MCP test via `search(query="authentication")` — verify hybrid results returned
