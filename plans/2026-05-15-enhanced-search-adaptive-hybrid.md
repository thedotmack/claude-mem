# Enhanced Search — Adaptive Hybrid Retrieval Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an `enhanced_search` MCP tool backed by a worker endpoint that fuses FTS5 keyword search with Chroma semantic search via Reciprocal Rank Fusion + reranking, routing keyword-direct queries to fast FTS5-only.

**Architecture:** A new `EnhancedSearchStrategy` runs FTS5 first (cheap, local), then a coverage-based routing heuristic decides whether to also engage Chroma. When engaged: RRF-merge the two ranked ID lists, hydrate, rerank by recency + entity-match + usage. Exposed as `GET /api/search/enhanced` and proxied by the thin `enhanced_search` MCP tool. Pure logic (tokenize, RRF, rerank, routing) lives in standalone unit-tested modules under `src/services/worker/search/enhanced/`.

**Tech Stack:** TypeScript, Express, Bun (`bun test`), esbuild bundling (`scripts/build-hooks.js`), SQLite FTS5, Chroma via `ChromaSync`.

**Provenance:** Ports the proven prototype at `~/claude-mem-bench/scripts/lib_baseline.py` (`rrf_merge`, `rerank`, `tokenize_for_fts5`). Benchmark conclusions in Backlog task #83. The Python prototype's per-question-type routing is replaced at runtime by a query-token-coverage proxy (no question types available live).

**Scope:** This plan covers Phases 0–4 (feature locally usable via MCP tool). Phases 5–6 (LongMemEval re-validation, upstream PR) are deferred to separate sessions and listed for completeness.

**Repo:** `~/.claude/plugins/marketplaces/thedotmack` (clone of `thedotmack/claude-mem`, branch `main`). The worker runs in-place from this path — do NOT use a git worktree, the build must update the live `plugin/`.

---

## File Structure

**New files:**
- `src/services/worker/search/enhanced/tokenize.ts` — significant-token extraction + Jaccard. Shared by rerank + routing.
- `src/services/worker/search/enhanced/rrf.ts` — pure `rrfMerge()`.
- `src/services/worker/search/enhanced/rerank.ts` — pure `rerank()`.
- `src/services/worker/search/enhanced/routing.ts` — `shouldUseHybrid()` coverage heuristic + tunable defaults.
- `src/services/worker/search/strategies/EnhancedSearchStrategy.ts` — orchestrates the 4 stages.
- `tests/worker/search/enhanced/tokenize.test.ts`
- `tests/worker/search/enhanced/rrf.test.ts`
- `tests/worker/search/enhanced/rerank.test.ts`
- `tests/worker/search/enhanced/routing.test.ts`
- `tests/worker/search/strategies/enhanced-search-strategy.test.ts`

**Modified files:**
- `src/services/worker/search/types.ts` — add `'enhanced'` to `SearchStrategyHint`.
- `src/services/worker/search/strategies/SearchStrategy.ts` — accept `'enhanced'` in `emptyResult()`.
- `src/services/worker/search/SearchOrchestrator.ts` — instantiate strategy + `enhancedSearch()` method.
- `src/services/worker/http/routes/SearchRoutes.ts` — register `GET /api/search/enhanced` + handler.
- `src/servers/mcp-server.ts` — add `enhanced_search` tool + `TOOL_ENDPOINT_MAP` entry.

**Boundary note:** `mcp-server.ts` is bundled separately under a size budget and must NOT pull in Bun-only / SQLite modules (see `scripts/build-hooks.js` guardrails, PR #1645). The `enhanced_search` tool is a thin HTTP proxy only — never import worker search code into it.

---

## Task 0: Create feature branch

- [ ] **Step 1: Create and switch to the branch**

```bash
cd ~/.claude/plugins/marketplaces/thedotmack
git checkout -b feat/enhanced-search-adaptive-hybrid
git status
```

Expected: `On branch feat/enhanced-search-adaptive-hybrid`, working tree clean.

---

## Task 1: Tokenize module

**Files:**
- Create: `src/services/worker/search/enhanced/tokenize.ts`
- Test: `tests/worker/search/enhanced/tokenize.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/worker/search/enhanced/tokenize.test.ts`:

```typescript
import { test, expect, describe } from 'bun:test';
import { significantTokens, jaccard } from '../../../../src/services/worker/search/enhanced/tokenize.js';

describe('significantTokens', () => {
  test('drops stopwords and short tokens, lowercases', () => {
    const t = significantTokens('The Worker restarted AND the DB was fine');
    expect(t.has('worker')).toBe(true);
    expect(t.has('restarted')).toBe(true);
    expect(t.has('the')).toBe(false);
    expect(t.has('and')).toBe(false);
    expect(t.has('db')).toBe(false); // length <= 2
  });

  test('empty / punctuation-only string yields empty set', () => {
    expect(significantTokens('   ... !!! ').size).toBe(0);
  });
});

describe('jaccard', () => {
  test('identical sets => 1', () => {
    expect(jaccard(new Set(['a', 'b']), new Set(['a', 'b']))).toBe(1);
  });
  test('disjoint sets => 0', () => {
    expect(jaccard(new Set(['a']), new Set(['b']))).toBe(0);
  });
  test('half overlap', () => {
    // intersection 1, union 3
    expect(jaccard(new Set(['a', 'b']), new Set(['a', 'c']))).toBeCloseTo(1 / 3, 5);
  });
  test('empty operand => 0', () => {
    expect(jaccard(new Set<string>(), new Set(['a']))).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/worker/search/enhanced/tokenize.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `src/services/worker/search/enhanced/tokenize.ts`:

```typescript
// Minimal English stopword list — ported from claude-mem-bench/scripts/lib_baseline.py.
// Kept deliberately small so query terms stay semantically loaded.
const STOPWORDS = new Set<string>([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'of', 'in', 'on', 'at',
  'to', 'for', 'with', 'and', 'or', 'but', 'if', 'then', 'what', 'when',
  'where', 'why', 'how', 'who', 'whom', 'which', 'this', 'that', 'these',
  'those', 'you', 'his', 'her', 'hers', 'its', 'our', 'ours', 'their',
  'theirs', 'as', 'by', 'from', 'into', 'about', 'any', 'some', 'all',
  'would', 'could', 'should', 'can', 'will', 'may', 'might', 'must',
]);

/**
 * Lowercase alphanumeric tokens, dropping stopwords and tokens of length <= 2.
 * Used for both rerank entity-match and routing coverage — keep them consistent.
 */
export function significantTokens(text: string): Set<string> {
  const words = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  return new Set(words.filter(w => w.length > 2 && !STOPWORDS.has(w)));
}

/** Jaccard similarity of two token sets. Returns 0 if either set is empty. */
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const t of a) if (b.has(t)) intersection++;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/worker/search/enhanced/tokenize.test.ts`
Expected: PASS — 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/services/worker/search/enhanced/tokenize.ts tests/worker/search/enhanced/tokenize.test.ts
git commit -m "feat(search): add tokenize helpers for enhanced search"
```

---

## Task 2: RRF merge module

**Files:**
- Create: `src/services/worker/search/enhanced/rrf.ts`
- Test: `tests/worker/search/enhanced/rrf.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/worker/search/enhanced/rrf.test.ts`:

```typescript
import { test, expect, describe } from 'bun:test';
import { rrfMerge } from '../../../../src/services/worker/search/enhanced/rrf.js';

describe('rrfMerge', () => {
  test('id appearing high in both lists ranks first', () => {
    const fts = [10, 20, 30];
    const chroma = [10, 40, 50];
    const merged = rrfMerge([fts, chroma]);
    expect(merged[0]).toBe(10);
  });

  test('union of all ids is preserved', () => {
    const merged = rrfMerge([[1, 2], [3, 4]]);
    expect(merged.sort((a, b) => a - b)).toEqual([1, 2, 3, 4]);
  });

  test('limit truncates the result', () => {
    const merged = rrfMerge([[1, 2, 3, 4, 5]], { limit: 2 });
    expect(merged).toEqual([1, 2]);
  });

  test('empty input yields empty output', () => {
    expect(rrfMerge([])).toEqual([]);
    expect(rrfMerge([[], []])).toEqual([]);
  });

  test('single-list input preserves order', () => {
    expect(rrfMerge([[3, 1, 2]])).toEqual([3, 1, 2]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/worker/search/enhanced/rrf.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `src/services/worker/search/enhanced/rrf.ts`:

```typescript
export interface RrfOptions {
  /** Rank-fusion constant. Higher k flattens the contribution of top ranks. */
  k?: number;
  /** Truncate the merged list to this length. */
  limit?: number;
}

/**
 * Reciprocal Rank Fusion: score(d) = sum_i 1 / (k + rank_i(d)).
 * Each input list is a ranked array of observation ids (best first).
 * Returns merged ids, best first. Ported from lib_baseline.rrf_merge.
 */
export function rrfMerge(rankedLists: number[][], options: RrfOptions = {}): number[] {
  const k = options.k ?? 60;
  const scores = new Map<number, number>();

  for (const list of rankedLists) {
    list.forEach((id, rank) => {
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + rank + 1));
    });
  }

  const merged = [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => id);

  return options.limit != null ? merged.slice(0, options.limit) : merged;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/worker/search/enhanced/rrf.test.ts`
Expected: PASS — 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/services/worker/search/enhanced/rrf.ts tests/worker/search/enhanced/rrf.test.ts
git commit -m "feat(search): add reciprocal rank fusion module"
```

---

## Task 3: Rerank module

**Files:**
- Create: `src/services/worker/search/enhanced/rerank.ts`
- Test: `tests/worker/search/enhanced/rerank.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/worker/search/enhanced/rerank.test.ts`:

```typescript
import { test, expect, describe } from 'bun:test';
import { rerank, RerankableObservation } from '../../../../src/services/worker/search/enhanced/rerank.js';

function obs(over: Partial<RerankableObservation> & { id: number }): RerankableObservation {
  return {
    title: null, subtitle: null, narrative: null, facts: null,
    created_at_epoch: 0, relevance_count: 0,
    ...over,
  };
}

describe('rerank', () => {
  test('empty input yields empty output', () => {
    expect(rerank([], 'anything')).toEqual([]);
  });

  test('positional prior preserved when no signals differ', () => {
    const input = [obs({ id: 1 }), obs({ id: 2 }), obs({ id: 3 })];
    expect(rerank(input, 'query').map(o => o.id)).toEqual([1, 2, 3]);
  });

  test('strong entity-match lifts a lower-ranked candidate', () => {
    // id 2 starts second but its text fully matches the query tokens.
    const input = [
      obs({ id: 1, narrative: 'unrelated content here' }),
      obs({ id: 2, narrative: 'worker restart database migration' }),
    ];
    const out = rerank(input, 'worker restart database migration', { entityWeight: 1.0 });
    expect(out[0].id).toBe(2);
  });

  test('recency lifts a newer candidate when weight is high', () => {
    const input = [
      obs({ id: 1, created_at_epoch: 1000 }),
      obs({ id: 2, created_at_epoch: 9000 }),
    ];
    const out = rerank(input, 'query', { recencyWeight: 1.0 });
    expect(out[0].id).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/worker/search/enhanced/rerank.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `src/services/worker/search/enhanced/rerank.ts`:

```typescript
import { significantTokens, jaccard } from './tokenize.js';

export interface RerankableObservation {
  id: number;
  title: string | null;
  subtitle: string | null;
  narrative: string | null;
  facts: string | null;
  created_at_epoch: number;
  /** Usage history; column added by migration, defaults to 0. */
  relevance_count?: number;
}

export interface RerankOptions {
  /** Weight of normalized recency (0..1 across the candidate set). */
  recencyWeight?: number;
  /** Weight of Jaccard entity-match between query and observation text. */
  entityWeight?: number;
  /** Weight of saturating usage signal derived from relevance_count. */
  usageWeight?: number;
}

/**
 * Rerank RRF-merged candidates. Base score is the positional prior 1/(rank+1)
 * — this preserves the upstream RRF order; bonuses only perturb it. Ported from
 * lib_baseline.rerank, with relevance_count added (the synthetic prototype had
 * no usage history).
 */
export function rerank<T extends RerankableObservation>(
  candidates: T[],
  query: string,
  options: RerankOptions = {},
): T[] {
  if (candidates.length === 0) return [];

  const recencyWeight = options.recencyWeight ?? 0.10;
  const entityWeight = options.entityWeight ?? 0.15;
  const usageWeight = options.usageWeight ?? 0.05;

  const epochs = candidates.map(c => c.created_at_epoch ?? 0);
  const minEpoch = Math.min(...epochs);
  const maxEpoch = Math.max(...epochs);
  const span = maxEpoch - minEpoch;

  const queryTokens = significantTokens(query);

  const scored = candidates.map((candidate, index) => {
    const base = 1 / (index + 1);
    const recency = span > 0 ? ((candidate.created_at_epoch ?? 0) - minEpoch) / span : 0;

    const text = [candidate.title, candidate.subtitle, candidate.narrative, candidate.facts]
      .filter(Boolean)
      .join(' ');
    const entity = jaccard(queryTokens, significantTokens(text));

    const usage = Math.log1p(candidate.relevance_count ?? 0);
    const usageNorm = usage / (usage + 1); // saturating 0..1

    const total = base + recencyWeight * recency + entityWeight * entity + usageWeight * usageNorm;
    return { candidate, total };
  });

  scored.sort((a, b) => b.total - a.total);
  return scored.map(s => s.candidate);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/worker/search/enhanced/rerank.test.ts`
Expected: PASS — 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/services/worker/search/enhanced/rerank.ts tests/worker/search/enhanced/rerank.test.ts
git commit -m "feat(search): add reranker with recency, entity-match, usage signals"
```

---

## Task 4: Routing heuristic module

**Files:**
- Create: `src/services/worker/search/enhanced/routing.ts`
- Test: `tests/worker/search/enhanced/routing.test.ts`

**Design rationale:** The benchmark (task #83) found hybrid helps indirect-language queries and hurts keyword-direct ones. At runtime there is no question-type label, so the proxy is **query-token coverage of the top FTS5 hit**: if the best FTS5 result already contains ≥ `coverageThreshold` of the query's significant tokens, FTS5 is confident — skip Chroma. Otherwise the FTS5 top hit is "flat"/partial — engage hybrid. `coverageThreshold` is the single tunable, validated in Phase 5.

- [ ] **Step 1: Write the failing test**

Create `tests/worker/search/enhanced/routing.test.ts`:

```typescript
import { test, expect, describe } from 'bun:test';
import { shouldUseHybrid, RoutableObservation } from '../../../../src/services/worker/search/enhanced/routing.js';

function r(text: string): RoutableObservation {
  return { title: text, subtitle: null, narrative: null, facts: null };
}

describe('shouldUseHybrid', () => {
  test('no FTS5 results => hybrid (chroma may still find matches)', () => {
    const d = shouldUseHybrid('worker restart database', []);
    expect(d.useHybrid).toBe(true);
    expect(d.reason).toBe('fts-empty');
  });

  test('top hit covers all query tokens => FTS5-only', () => {
    const d = shouldUseHybrid('worker restart migration', [
      r('worker restart migration completed cleanly'),
    ]);
    expect(d.useHybrid).toBe(false);
    expect(d.reason).toBe('fts-confident');
    expect(d.topCoverage).toBe(1);
  });

  test('top hit covers too few query tokens => hybrid', () => {
    const d = shouldUseHybrid('worker restart migration rollback', [
      r('worker logs unrelated'),
    ]);
    expect(d.useHybrid).toBe(true);
    expect(d.reason).toBe('fts-flat');
  });

  test('query with no significant tokens => FTS5-only (nothing to fuse on)', () => {
    const d = shouldUseHybrid('the a is of', [r('anything')]);
    expect(d.useHybrid).toBe(false);
    expect(d.reason).toBe('no-significant-tokens');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/worker/search/enhanced/routing.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `src/services/worker/search/enhanced/routing.ts`:

```typescript
import { significantTokens } from './tokenize.js';

export interface RoutableObservation {
  title: string | null;
  subtitle: string | null;
  narrative: string | null;
  facts: string | null;
}

export interface RoutingConfig {
  /** Fraction of query tokens the top FTS5 hit must cover to skip hybrid. */
  coverageThreshold: number;
  /** FTS5 result count below which hybrid is forced. */
  minFtsResults: number;
}

/** Tunable defaults — coverageThreshold is validated against LongMemEval in Phase 5. */
export const ROUTING_DEFAULTS: RoutingConfig = {
  coverageThreshold: 0.75,
  minFtsResults: 1,
};

export interface RoutingDecision {
  useHybrid: boolean;
  reason: 'fts-empty' | 'fts-confident' | 'fts-flat' | 'no-significant-tokens';
  topCoverage: number;
}

/**
 * Decide whether to engage Chroma + RRF on top of FTS5, based on how completely
 * the top FTS5 hit covers the query's significant tokens.
 */
export function shouldUseHybrid(
  query: string,
  ftsResults: RoutableObservation[],
  config: RoutingConfig = ROUTING_DEFAULTS,
): RoutingDecision {
  if (ftsResults.length < config.minFtsResults) {
    return { useHybrid: true, reason: 'fts-empty', topCoverage: 0 };
  }

  const queryTokens = significantTokens(query);
  if (queryTokens.size === 0) {
    return { useHybrid: false, reason: 'no-significant-tokens', topCoverage: 1 };
  }

  const top = ftsResults[0];
  const topText = [top.title, top.subtitle, top.narrative, top.facts]
    .filter(Boolean)
    .join(' ');
  const topTokens = significantTokens(topText);

  let covered = 0;
  for (const t of queryTokens) if (topTokens.has(t)) covered++;
  const topCoverage = covered / queryTokens.size;

  if (topCoverage >= config.coverageThreshold) {
    return { useHybrid: false, reason: 'fts-confident', topCoverage };
  }
  return { useHybrid: true, reason: 'fts-flat', topCoverage };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/worker/search/enhanced/routing.test.ts`
Expected: PASS — 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/services/worker/search/enhanced/routing.ts tests/worker/search/enhanced/routing.test.ts
git commit -m "feat(search): add adaptive routing heuristic"
```

---

## Task 5: Add `'enhanced'` to the strategy-hint type

**Files:**
- Modify: `src/services/worker/search/types.ts:53`
- Modify: `src/services/worker/search/strategies/SearchStrategy.ts:19`

- [ ] **Step 1: Extend `SearchStrategyHint`**

In `src/services/worker/search/types.ts`, change line 53 from:

```typescript
export type SearchStrategyHint = 'chroma' | 'sqlite' | 'hybrid' | 'auto';
```

to:

```typescript
export type SearchStrategyHint = 'chroma' | 'sqlite' | 'hybrid' | 'enhanced' | 'auto';
```

- [ ] **Step 2: Accept `'enhanced'` in `emptyResult`**

In `src/services/worker/search/strategies/SearchStrategy.ts`, change the `emptyResult` signature (line 19) from:

```typescript
  protected emptyResult(strategy: 'chroma' | 'sqlite' | 'hybrid'): StrategySearchResult {
```

to:

```typescript
  protected emptyResult(strategy: 'chroma' | 'sqlite' | 'hybrid' | 'enhanced'): StrategySearchResult {
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck:root`
Expected: PASS (no errors).

- [ ] **Step 4: Commit**

```bash
git add src/services/worker/search/types.ts src/services/worker/search/strategies/SearchStrategy.ts
git commit -m "feat(search): add 'enhanced' strategy hint"
```

---

## Task 6: EnhancedSearchStrategy

**Files:**
- Create: `src/services/worker/search/strategies/EnhancedSearchStrategy.ts`
- Test: `tests/worker/search/strategies/enhanced-search-strategy.test.ts`

**Stages:** (1) FTS5 always — `sessionSearch.searchObservations(query, ...)`. (2) Route via `shouldUseHybrid`. (3) If hybrid: `chromaSync.queryChroma`, then `rrfMerge`. (4) Hydrate merged ids via `sessionStore.getObservationsByIds` (does NOT preserve order — reorder manually), then `rerank`.

- [ ] **Step 1: Write the failing test**

Create `tests/worker/search/strategies/enhanced-search-strategy.test.ts`:

```typescript
import { test, expect, describe } from 'bun:test';
import { EnhancedSearchStrategy } from '../../../../src/services/worker/search/strategies/EnhancedSearchStrategy.js';

// Minimal stub observation matching ObservationSearchResult's used fields.
function obs(id: number, over: Record<string, any> = {}) {
  return {
    id, memory_session_id: 's', project: 'p', text: null, type: 'discovery',
    title: `obs ${id}`, subtitle: null, facts: null, narrative: null,
    concepts: null, files_read: null, files_modified: null, prompt_number: null,
    discovery_tokens: 0, created_at: '', created_at_epoch: id, relevance_count: 0,
    ...over,
  };
}

function makeSessionSearch(ftsResults: any[]) {
  return { searchObservations: (_q: any, _o: any) => ftsResults } as any;
}
function makeSessionStore(byId: Record<number, any>) {
  return {
    getObservationsByIds: (ids: number[]) => ids.map(i => byId[i]).filter(Boolean),
  } as any;
}
function makeChroma(ids: number[], fail = false) {
  return {
    queryChroma: async () => {
      if (fail) throw new Error('ECONNREFUSED');
      return { ids, distances: [], metadatas: [] };
    },
  } as any;
}

describe('EnhancedSearchStrategy', () => {
  test('confident FTS5 top hit => FTS5-only, Chroma not queried', async () => {
    let chromaCalled = false;
    const chroma = { queryChroma: async () => { chromaCalled = true; return { ids: [], distances: [], metadatas: [] }; } } as any;
    const fts = [obs(1, { title: 'worker restart migration done' })];
    const strategy = new EnhancedSearchStrategy(chroma, makeSessionStore({ 1: fts[0] }), makeSessionSearch(fts));

    const result = await strategy.search({ query: 'worker restart migration' });

    expect(chromaCalled).toBe(false);
    expect(result.usedChroma).toBe(false);
    expect(result.results.observations.map((o: any) => o.id)).toEqual([1]);
  });

  test('flat FTS5 top hit => hybrid path merges Chroma ids', async () => {
    const fts = [obs(1, { title: 'partial match only' })];
    const byId = { 1: fts[0], 2: obs(2), 3: obs(3) };
    const strategy = new EnhancedSearchStrategy(
      makeChroma([2, 3]), makeSessionStore(byId), makeSessionSearch(fts),
    );

    const result = await strategy.search({ query: 'worker restart migration rollback audit' });

    expect(result.usedChroma).toBe(true);
    const ids = result.results.observations.map((o: any) => o.id).sort();
    expect(ids).toEqual([1, 2, 3]);
  });

  test('Chroma failure on hybrid path => graceful FTS5-only fallback', async () => {
    const fts = [obs(1, { title: 'partial' })];
    const strategy = new EnhancedSearchStrategy(
      makeChroma([], true), makeSessionStore({ 1: fts[0] }), makeSessionSearch(fts),
    );

    const result = await strategy.search({ query: 'worker restart migration rollback audit' });

    expect(result.usedChroma).toBe(false);
    expect(result.results.observations.map((o: any) => o.id)).toEqual([1]);
  });

  test('empty query => empty result', async () => {
    const strategy = new EnhancedSearchStrategy(makeChroma([]), makeSessionStore({}), makeSessionSearch([]));
    const result = await strategy.search({ query: '' });
    expect(result.results.observations).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/worker/search/strategies/enhanced-search-strategy.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `src/services/worker/search/strategies/EnhancedSearchStrategy.ts`:

```typescript
import { BaseSearchStrategy, SearchStrategy } from './SearchStrategy.js';
import {
  StrategySearchOptions,
  StrategySearchResult,
  SEARCH_CONSTANTS,
} from '../types.js';
import { ChromaSync } from '../../../sync/ChromaSync.js';
import { SessionStore } from '../../../sqlite/SessionStore.js';
import { SessionSearch } from '../../../sqlite/SessionSearch.js';
import { rrfMerge } from '../enhanced/rrf.js';
import { rerank } from '../enhanced/rerank.js';
import { shouldUseHybrid } from '../enhanced/routing.js';
import { logger } from '../../../../utils/logger.js';

// Top-N pulled from each backend before fusion — matches the prototype's Top-20.
const CANDIDATE_LIMIT = 20;

export class EnhancedSearchStrategy extends BaseSearchStrategy implements SearchStrategy {
  readonly name = 'enhanced';

  constructor(
    private chromaSync: ChromaSync,
    private sessionStore: SessionStore,
    private sessionSearch: SessionSearch,
  ) {
    super();
  }

  canHandle(options: StrategySearchOptions): boolean {
    return !!options.query;
  }

  async search(options: StrategySearchOptions): Promise<StrategySearchResult> {
    const { query, limit = SEARCH_CONSTANTS.DEFAULT_LIMIT, project, dateRange, obsType } = options;
    if (!query) {
      return this.emptyResult('enhanced');
    }

    // Stage 1 — FTS5 keyword search (cheap, local, always runs).
    const ftsResults = this.sessionSearch.searchObservations(query, {
      limit: CANDIDATE_LIMIT,
      project,
      dateRange,
      type: obsType as any,
      orderBy: 'relevance',
    });

    // Stage 2 — adaptive routing.
    const route = shouldUseHybrid(query, ftsResults);
    logger.debug('SEARCH', 'EnhancedSearchStrategy: routing decision', {
      reason: route.reason,
      useHybrid: route.useHybrid,
      topCoverage: route.topCoverage,
    });

    if (!route.useHybrid) {
      return {
        results: { observations: ftsResults.slice(0, limit), sessions: [], prompts: [] },
        usedChroma: false,
        strategy: 'enhanced',
      };
    }

    // Stage 3 — Chroma semantic search + RRF fusion.
    const whereFilter = project
      ? { $and: [{ doc_type: 'observation' }, { project }] }
      : { doc_type: 'observation' };

    let chromaIds: number[] = [];
    try {
      const chroma = await this.chromaSync.queryChroma(query, CANDIDATE_LIMIT, whereFilter);
      chromaIds = chroma.ids;
    } catch (error) {
      // Chroma down — degrade to FTS5-only rather than failing the request.
      logger.warn('SEARCH', 'EnhancedSearchStrategy: Chroma unavailable, FTS5-only fallback', {
        message: error instanceof Error ? error.message : String(error),
      });
      return {
        results: { observations: ftsResults.slice(0, limit), sessions: [], prompts: [] },
        usedChroma: false,
        strategy: 'enhanced',
      };
    }

    const ftsIds = ftsResults.map(o => o.id);
    const mergedIds = rrfMerge([ftsIds, chromaIds], { limit: CANDIDATE_LIMIT });

    if (mergedIds.length === 0) {
      return {
        results: { observations: [], sessions: [], prompts: [] },
        usedChroma: true,
        strategy: 'enhanced',
      };
    }

    // Stage 4 — hydrate + rerank. getObservationsByIds does not preserve the
    // requested order, so reorder to the RRF order before reranking.
    const hydrated = this.sessionStore.getObservationsByIds(mergedIds, {
      limit: CANDIDATE_LIMIT,
      project,
    });
    hydrated.sort((a, b) => mergedIds.indexOf(a.id) - mergedIds.indexOf(b.id));
    const reranked = rerank(hydrated, query);

    return {
      results: { observations: reranked.slice(0, limit), sessions: [], prompts: [] },
      usedChroma: true,
      strategy: 'enhanced',
    };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/worker/search/strategies/enhanced-search-strategy.test.ts`
Expected: PASS — 4 tests.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck:root`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/services/worker/search/strategies/EnhancedSearchStrategy.ts tests/worker/search/strategies/enhanced-search-strategy.test.ts
git commit -m "feat(search): add EnhancedSearchStrategy orchestrating FTS5+Chroma+RRF"
```

---

## Task 7: Wire strategy into SearchOrchestrator

**Files:**
- Modify: `src/services/worker/search/SearchOrchestrator.ts`

- [ ] **Step 1: Add the import**

After line 8 (`import { HybridSearchStrategy } ...`), add:

```typescript
import { EnhancedSearchStrategy } from './strategies/EnhancedSearchStrategy.js';
```

- [ ] **Step 2: Add the field**

After line 35 (`private hybridStrategy: HybridSearchStrategy | null = null;`), add:

```typescript
  private enhancedStrategy: EnhancedSearchStrategy | null = null;
```

- [ ] **Step 3: Instantiate it in the constructor**

Inside the `if (chromaSync) { ... }` block (currently lines 46-49), add a line after the `hybridStrategy` assignment so the block reads:

```typescript
    if (chromaSync) {
      this.chromaStrategy = new ChromaSearchStrategy(chromaSync, sessionStore);
      this.hybridStrategy = new HybridSearchStrategy(chromaSync, sessionStore, sessionSearch);
      this.enhancedStrategy = new EnhancedSearchStrategy(chromaSync, sessionStore, sessionSearch);
    }
```

- [ ] **Step 4: Add the `enhancedSearch` method**

Immediately after the `search` method (after line 59, before `executeWithFallback`), add:

```typescript
  async enhancedSearch(args: any): Promise<StrategySearchResult> {
    const options = this.normalizeParams(args);

    if (this.enhancedStrategy && options.query) {
      return await this.enhancedStrategy.search(options);
    }

    // No Chroma configured (or filter-only query) — fall back to plain FTS5.
    const observations = this.sessionSearch.searchObservations(options.query, {
      limit: options.limit,
      offset: options.offset,
      project: options.project,
      dateRange: options.dateRange,
      orderBy: options.orderBy,
      type: options.obsType as any,
    });
    return {
      results: { observations, sessions: [], prompts: [] },
      usedChroma: false,
      strategy: 'enhanced',
    };
  }
```

- [ ] **Step 5: Add the SessionSearch import for the type**

`sessionSearch` is already a constructor param (`private sessionSearch: SessionSearch` — line 40), so it is reachable as `this.sessionSearch`. No new import needed. Verify line 40 reads `private sessionSearch: SessionSearch`.

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck:root`
Expected: PASS.

- [ ] **Step 7: Run the orchestrator test suite**

Run: `bun test tests/worker/search/`
Expected: PASS — all existing + new tests green.

- [ ] **Step 8: Commit**

```bash
git add src/services/worker/search/SearchOrchestrator.ts
git commit -m "feat(search): wire EnhancedSearchStrategy into SearchOrchestrator"
```

---

## Task 8: Add `/api/search/enhanced` worker route

**Files:**
- Modify: `src/services/worker/http/routes/SearchRoutes.ts`

Modeled on the existing `handleSearchByType` handler (same file) — it returns the `{ content: [{ type: 'text', text }] }` shape the MCP layer expects.

- [ ] **Step 1: Register the route**

In `setupRoutes`, after line 114 (`app.get('/api/search/by-type', ...)`), add:

```typescript
    app.get('/api/search/enhanced', this.handleEnhancedSearch.bind(this));
```

- [ ] **Step 2: Add the handler**

After the `handleSearchByType` handler (after line 300, before `handleGetRecentContext`), add:

```typescript
  private handleEnhancedSearch = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const orchestrator = this.searchManager.getOrchestrator();
    const formatter = this.searchManager.getFormatter();
    const query = req.query as Record<string, any>;
    const rawQuery = query.query;
    const queryText = Array.isArray(rawQuery) ? rawQuery[0] : (rawQuery ?? '');

    const strategyResult = await orchestrator.enhancedSearch(query);
    const observations = strategyResult.results.observations;

    if (observations.length === 0) {
      res.json({
        content: [{
          type: 'text' as const,
          text: `No results found for "${queryText}"`
        }]
      });
      return;
    }

    const header = `Found ${observations.length} result(s) for "${queryText}" `
      + `(strategy: ${strategyResult.strategy}, chroma: ${strategyResult.usedChroma})`
      + `\n\n${formatter.formatTableHeader()}`;
    const rows = observations.map((obs: ObservationSearchResult, i: number) => formatter.formatObservationIndex(obs, i));
    res.json({
      content: [{
        type: 'text' as const,
        text: header + '\n' + rows.join('\n')
      }]
    });
  });
```

(`ObservationSearchResult` is already imported at line 14 of this file.)

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck:root`
Expected: PASS.

- [ ] **Step 4: Build and restart the worker, then verify the endpoint**

```bash
npm run build-and-sync
sleep 3
PORT=$(node -e "const u=process.getuid();console.log(37700+(u%100))")
curl -s "http://127.0.0.1:${PORT}/api/search/enhanced?query=worker%20restart&limit=5"
```

Expected: JSON `{ "content": [{ "type": "text", "text": "Found N result(s) ... (strategy: enhanced, chroma: ...)" }] }`. If `CLAUDE_MEM_WORKER_PORT` is set in the environment, use that value instead of the computed `PORT`.

- [ ] **Step 5: Commit**

```bash
git add src/services/worker/http/routes/SearchRoutes.ts
git commit -m "feat(search): expose GET /api/search/enhanced endpoint"
```

---

## Task 9: Add `enhanced_search` MCP tool

**Files:**
- Modify: `src/servers/mcp-server.ts`

- [ ] **Step 1: Add the endpoint mapping**

`TOOL_ENDPOINT_MAP` is defined around line 66 (`'search': '/api/search'`). Add an entry:

```typescript
  'enhanced_search': '/api/search/enhanced',
```

- [ ] **Step 2: Add the tool definition**

In the `tools` array, immediately after the `search` tool object (after line 481, before the `timeline` tool), add:

```typescript
  {
    name: 'enhanced_search',
    description: 'Adaptive hybrid memory search: FTS5 keyword + Chroma semantic + RRF fusion + reranking. Keyword-direct queries route to fast FTS5-only; indirect/multi-hop queries engage the full hybrid path. Returns an index with IDs, same format as search. Params: query (required), limit, project, obs_type, dateStart, dateEnd.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query (required)' },
        limit: { type: 'number', description: 'Max results (default 20)' },
        project: { type: 'string', description: 'Filter by project name' },
        obs_type: { type: 'string', description: 'Filter by observation type' },
        dateStart: { type: 'string', description: 'Start date filter (ISO)' },
        dateEnd: { type: 'string', description: 'End date filter (ISO)' }
      },
      required: ['query'],
      additionalProperties: true
    },
    handler: async (args: any) => {
      const endpoint = TOOL_ENDPOINT_MAP['enhanced_search'];
      return await callWorkerAPI(endpoint, args);
    }
  },
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck:root`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/servers/mcp-server.ts
git commit -m "feat(mcp): add enhanced_search tool proxying /api/search/enhanced"
```

---

## Task 10: Build, verify bundle guardrails, end-to-end check

**Files:** none (build + verification only)

- [ ] **Step 1: Full build and worker restart**

```bash
npm run build-and-sync
```

Expected: `✓ worker-service built`, `✓ mcp-server built` — no guardrail errors (Bun-only imports, Zod externalization, size budget). If the mcp-server bundle fails a guardrail, a transitive import leaked worker code into it — check that `enhanced_search`'s handler only uses `callWorkerAPI` and imports nothing new.

- [ ] **Step 2: Run the full search test suite**

Run: `bun test tests/worker/search/`
Expected: PASS — all green.

- [ ] **Step 3: End-to-end check via the worker endpoint**

```bash
PORT=$(node -e "const u=process.getuid();console.log(37700+(u%100))")
echo "FTS5-confident query (expect strategy: enhanced, chroma: false):"
curl -s "http://127.0.0.1:${PORT}/api/search/enhanced?query=enhanced%20search%20adaptive%20hybrid&limit=5" | head -c 400
echo
echo "Indirect query (expect chroma: true if Chroma is up):"
curl -s "http://127.0.0.1:${PORT}/api/search/enhanced?query=how%20did%20we%20decide%20on%20memory%20backend&limit=5" | head -c 400
```

Expected: both return `{ "content": [...] }`; the header line reports the `strategy` and `chroma` values. Confirm the routing differs between a keyword-direct and an indirect phrasing.

- [ ] **Step 4: Verify the MCP tool is registered**

Restart Claude Code (or reload MCP) and confirm `mcp__plugin_claude-mem_mcp-search__enhanced_search` appears in the deferred tool list. Invoke it once with a test query and confirm it returns the formatted index.

- [ ] **Step 5: Mark Backlog #83 progress**

This completes the local-feature scope. Update Backlog task #83 with a note that the endpoint + MCP tool are implemented on branch `feat/enhanced-search-adaptive-hybrid`, and that Phase 5 (LongMemEval re-validation) + Phase 6 (upstream PR) remain.

---

## Phase 5 (deferred — separate session): LongMemEval re-validation

Not executed in this session. Re-run the LongMemEval harness in `~/claude-mem-bench/` against the **real** `/api/search/enhanced` endpoint (not the Python prototype), sweeping `ROUTING_DEFAULTS.coverageThreshold` (e.g. 0.6 / 0.7 / 0.75 / 0.8 / 0.85) to confirm the prototype's gains hold and to pin the threshold. Also exercise `relevance_count` once observations have real usage history. Adjust `routing.ts` defaults based on results.

## Phase 6 (deferred — separate session): Upstream PR

Not executed in this session. After Phase 5 validates the numbers: push `feat/enhanced-search-adaptive-hybrid`, open a PR to `thedotmack/claude-mem` summarizing the benchmark deltas from task #83 and the adaptive-routing design. Requires explicit user confirmation before any push.

---

## Self-Review

**Spec coverage** (production-gap items from Backlog #83):
1. Worker endpoint `/api/search/enhanced` — Task 8. ✓
2. `enhanced_search` MCP tool wrapper — Task 9. ✓
3. Adaptive-routing heuristic — Task 4 (`routing.ts`), applied in Task 6. ✓
4. `relevance_count` in rerank — Task 3 (`rerank.ts` `usageWeight`). ✓
5. Upstream PR — Phase 6 (deferred, by design — needs Phase 5 validation first). ✓
6. RRF merge — Task 2 (`rrf.ts`). ✓

**Type consistency:** `RerankableObservation` (Task 3) is structurally satisfied by `ObservationSearchResult` (`extends ObservationRow`, which has `id`, `title`, `subtitle`, `narrative`, `facts`, `created_at_epoch`; `relevance_count` is optional). `rerank<T extends RerankableObservation>` is generic so it returns `ObservationSearchResult[]` unchanged. `RoutableObservation` (Task 4) is also structurally satisfied. `shouldUseHybrid`, `rrfMerge`, `rerank` signatures match their call sites in `EnhancedSearchStrategy` (Task 6). `enhancedSearch` exists on the orchestrator (Task 7) and is called by the route (Task 8). `'enhanced'` is added to `SearchStrategyHint` (Task 5) before any `strategy: 'enhanced'` literal is used.

**Placeholders:** none — every code step contains complete implementations.
