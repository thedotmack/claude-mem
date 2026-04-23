# 04 — Read Path

**Purpose**: Collapse the read path — rendering, search, and knowledge-corpus query — to a single shape per concern. One `renderObservations(obs, strategy: RenderStrategy)` function replaces `AgentFormatter`, `HumanFormatter`, `ResultFormatter`, and `CorpusRenderer`, driven by a config object (not a class hierarchy). One search path routes every caller through `SearchOrchestrator`; `SearchManager.findByConcept` / `findByFile` / `findByType` and seven hand-rolled copies of the recency filter are deleted. Chroma failure throws `503` instead of silently re-querying SQLite, and `HybridSearchStrategy`'s silent fallbacks to metadata-only are deleted in the same PR. The `@deprecated getExistingChromaIds` fence is removed, the duplicate `estimateTokens` implementations are collapsed to one utility, and the knowledge-corpus layer is simplified by deleting `session_id` persistence, the `prime` / `reprime` operations, and the auto-reprime regex in `KnowledgeAgent`; `/query` becomes a fresh SDK call with `systemPrompt` that relies on SDK prompt caching. Chroma sync behavior (delete-then-add, `chroma_synced` column, boot-once backfill) is defined by `01-data-integrity.md` §Phase 7 and consumed unchanged here.

---

## Principles invoked

This plan is measured against `00-principles.md`:

1. **Principle 2 — Fail-fast over grace-degrade.** `SearchOrchestrator` throws `503` on Chroma error. `ChromaSearchStrategy` returns `usedChroma: false` only when Chroma is explicitly uninitialized; every real error propagates. `HybridSearchStrategy`'s three try/catch fallbacks that returned metadata-only results are deleted. No silent coerce, no silent degrade.
2. **Principle 6 — One helper, N callers.** One `renderObservations(obs, strategy)` replaces four formatter classes; one `SearchOrchestrator` path replaces `SearchManager.findBy*`; one `RECENCY_WINDOW_MS` import replaces seven copies; one `estimateTokens` utility replaces two per-formatter duplicates.
3. **Principle 7 — Delete code in the same PR it becomes unused.** The four formatter classes, the `SearchManager.findBy*` methods, the seven recency copies, the `fellBack: true` flag path, the `@deprecated getExistingChromaIds` fence, and the knowledge-corpus `prime` / `reprime` / `session_id` persistence all delete in the PR that lands this plan — no `@deprecated` window, no "remove next release."

---

## Phase 1 — `renderObservations(obs, strategy: RenderStrategy)`

**Purpose**: Replace `AgentFormatter`, `HumanFormatter`, `ResultFormatter`, and `CorpusRenderer` with a single function parameterized by a `RenderStrategy` config object. The four existing formatters share a common walk over `ObservationRow[]` with four knobs that differ: which header to emit, whether to group rows, how dense each row is, and whether ANSI colors are used. Those knobs become fields on `RenderStrategy`.

`RenderStrategy` is a **config type**, not a class hierarchy — per principle 6, a config object is the correct shape when the only per-variant state is data:

```ts
type RenderStrategy = {
  header: 'agent' | 'human' | 'terse' | 'corpus';
  grouping: 'none' | 'byDate' | 'byType';
  rowDensity: 'compact' | 'verbose';
  colors: boolean;
  columns: Array<keyof ObservationRow>;
};
```

NO abstract class. NO factory. NO `RenderStrategyBase` with subclasses. Just a config type passed by value. This follows the mapping-doc verdict on old Plan 05: "Four RenderStrategy classes — DELETE — Strategies collapse to ONE config object with four literals — violates 'no speculative abstraction' principle" (`_mapping.md` old Plan 05 row).

**Files**:
- `src/services/context/renderObservations.ts` (new) — single function, takes `(obs: ObservationRow[], strategy: RenderStrategy)`, returns `string`.
- Four call-site configs exported as named constants: `agentConfig`, `humanConfig`, `terseConfig`, `corpusConfig`.

**Citation**: `_reference.md` Part 1 §Search / read path — `src/services/context/formatters/` contains four formatters sharing a common walk with four strategy knobs (header, grouping, row density, colors); the four formatters are the direct inputs to this consolidation.

---

## Phase 2 — Delete four formatter classes

**Purpose**: Remove the four class files in `src/services/context/formatters/` in the same PR as Phase 1. Each class is replaced by one of the four exported configs passed to `renderObservations`. Directory is deleted entirely if empty after the sweep.

**Files**:
- `src/services/context/formatters/AgentFormatter.ts` — DELETE; replaced by `agentConfig`.
- `src/services/context/formatters/HumanFormatter.ts` — DELETE; replaced by `humanConfig`.
- `src/services/context/formatters/ResultFormatter.ts` — DELETE; replaced by `terseConfig` (or `resultConfig`, name chosen at write time).
- `src/services/context/formatters/CorpusRenderer.ts` — DELETE; replaced by `corpusConfig`.
- Every importer of those four classes is rewritten to call `renderObservations(obs, <config>)`.

**Citation**: `_reference.md` Part 1 §Search / read path — "four formatters (AgentFormatter, HumanFormatter, ResultFormatter, CorpusRenderer) share a common walk with four strategy knobs." `_mapping.md` old Plan 05 rows confirm all four delete in the same PR.

---

## Phase 3 — Delete `SearchManager.findBy*` duplicated methods

**Purpose**: `SearchManager` carries its own `findByConcept`, `findByFile`, and `findByType` implementations that duplicate the routing already performed by `SearchOrchestrator`. Delete the three methods; every caller routes through `SearchOrchestrator` instead. This removes two copies of the same query-decision logic (SearchManager vs. HybridSearchStrategy) from the codebase.

**Files**:
- `src/services/worker/SearchManager.ts:1209-1310` — delete `findByConcept`.
- `src/services/worker/SearchManager.ts:1277` — delete `findByFile`.
- `src/services/worker/SearchManager.ts:1399` — delete `findByType`.
- Every caller of `SearchManager.findByConcept` / `findByFile` / `findByType` — rewrite to call the corresponding `SearchOrchestrator` entry point.

**Citation**: `_reference.md` Part 1 §Search / read path — `src/services/worker/SearchManager.ts:230, 247-259, 488, 978-985, 1064-1071, 1150-1157, 1209-1310, 1277, 1399, 1840-1847` ("findByConcept/File/Type implementations that duplicate HybridSearchStrategy").

---

## Phase 4 — Consolidate recency filter

**Purpose**: `SearchManager` hand-rolls the `created_at_epoch > now - RECENCY_WINDOW_MS` predicate in seven separate call sites. The constant `RECENCY_WINDOW_MS` already exists at `src/services/worker/types.ts:16`. Import it everywhere; delete the seven hand-rolled copies.

**Files**:
- `src/services/worker/types.ts:16` — canonical `RECENCY_WINDOW_MS` (per principle 6, the one helper).
- `src/services/worker/SearchManager.ts:230, 247-259, 488, 978-985, 1064-1071, 1150-1157, 1840-1847` — delete the seven hand-rolled filter copies; import from `types.ts:16` wherever the filter is still needed. After Phase 3 deletes `findBy*`, some of those sites vanish; whichever remain import the constant.

**Citation**: `_reference.md` Part 1 §Search / read path — "Seven duplicated recency-filter call sites." `_mapping.md` Cross-plan coupling — "`RECENCY_WINDOW_MS` constant | `types.ts:16` (already exists; consolidation in `04-read-path.md` §Phase 3)."

---

## Phase 5 — Fail-fast Chroma

**Purpose**: Replace the silent fallback in `SearchOrchestrator` (per principle 2, fail-fast over grace-degrade). When Chroma is configured and reachable but returns an error, the orchestrator throws a `503 Service Unavailable` rather than stripping the query and re-querying SQLite. `ChromaSearchStrategy` returns `usedChroma: false` only when Chroma is **explicitly uninitialized** (e.g., the user has not set it up yet); every other error propagates to the orchestrator and then to the HTTP layer.

**Files**:
- `src/services/worker/search/SearchOrchestrator.ts:85-110` — delete the branch that strips the query on `usedChroma=false` and re-queries SQLite. On Chroma error, throw `503`.
- `src/services/worker/search/strategies/ChromaSearchStrategy.ts:76-86` — narrow the `try/catch { return usedChroma: false }` to catch only the explicit-uninitialized sentinel; rethrow all other errors.

The `chroma_synced` column, boot-once backfill, and delete-then-add reconciliation are owned by `01-data-integrity.md` §Phase 7 — this plan consumes that Chroma sync behavior without re-specifying it. Fail-fast applies at the **read** path; write-path reconciliation stays where it lives.

**Citation**: `_reference.md` Part 1 §Search / read path — `SearchOrchestrator.ts:85-110` (silent fallback with three paths; stripping branch is the target of deletion) and `ChromaSearchStrategy.ts:76-86` (catch-all that swallows real errors).

---

## Phase 6 — Delete hybrid silent fallbacks

**Purpose**: `HybridSearchStrategy` has three near-identical methods, each wrapping its Chroma call in a `try/catch` that returns a metadata-only result with `fellBack: true` on any error. This is the same silent-degrade pattern at the strategy layer; delete all three. Errors propagate to `SearchOrchestrator` (Phase 5), which propagates to the HTTP layer as `503`.

**Files**:
- `src/services/worker/search/strategies/HybridSearchStrategy.ts:82-95` — delete the first try/catch fallback path (findByConcept variant).
- `src/services/worker/search/strategies/HybridSearchStrategy.ts:120-134` — delete the second (findByType variant).
- `src/services/worker/search/strategies/HybridSearchStrategy.ts:161-173` — delete the third (findByFile variant).
- Every producer of a `fellBack: true` return — delete.

**Citation**: `_reference.md` Part 1 §Search / read path — `HybridSearchStrategy.ts:64-185` ("three near-identical methods … each with its own try/catch fallback to metadata-only. … propagate errors, don't silently degrade to metadata-only"). `_mapping.md` old Plan 06 row — "Silent-fallback to filter-only — DELETE — Violates 'fail-fast'."

---

## Phase 7 — Delete `@deprecated getExistingChromaIds`

**Purpose**: Per principle 7, no `@deprecated` fence survives the PR that makes it unused. The `getExistingChromaIds` function is flagged `@deprecated` in the current code and has no active callers after Phases 5-6 land. Delete the function, the JSDoc fence, and any imports in the same PR.

**Files**:
- Wherever `getExistingChromaIds` is defined (Chroma sync / search module; see `_reference.md` Part 1 §Search / read path) — DELETE the function and the `@deprecated` block above it.
- Every import of `getExistingChromaIds` — DELETE.

**Citation**: `_mapping.md` old Plan 04 row — "`getExistingChromaIds` `@deprecated` fence — DELETE — Violates 'no dead code' principle. Gone in same PR."

---

## Phase 8 — Single `estimateTokens` utility

**Purpose**: Two different token estimates exist — one in `ResultFormatter.ts:264`, one in `CorpusRenderer.ts:90`. After Phase 2 deletes both classes, their `estimateTokens` helpers would orphan. Consolidate to one shared utility at `src/shared/estimate-tokens.ts`, imported by `renderObservations` and any other caller that needs it.

**Files**:
- `src/shared/estimate-tokens.ts` (new) — single `estimateTokens(obs: ObservationRow): number` export.
- `src/services/worker/search/ResultFormatter.ts:264` — DELETE the inline estimate (the whole file is deleted in Phase 2; this line is explicitly called out to confirm no salvage-copy is left).
- `src/services/worker/knowledge/CorpusRenderer.ts:90` — DELETE the inline estimate (same note).

**Citation**: `_reference.md` Part 1 §Search / read path — "Two different token estimates. Plan `04-read-path` §Utilities: one shared `estimateTokens(obs)` in `src/shared/`."

---

## Phase 9 — Knowledge-corpus simplification

**Purpose**: The knowledge-corpus layer carries three kinds of debt: `session_id` persistence on corpus rows (a feature never actually used by queries), `prime` / `reprime` operations (which warm an agent's context with a corpus, then re-warm on drift), and an auto-reprime regex in `KnowledgeAgent` that re-runs `prime` when the agent's response matches a freshness-failure pattern. All three go. `/query` becomes one fresh SDK call per request, constructed with the corpus's compiled `systemPrompt`; repeated calls benefit from the Anthropic SDK's native prompt-caching behavior rather than an in-process warm-context table.

**Files**:
- Knowledge-corpus persistence layer — delete `session_id` column and every write that populates it, every read that consumes it.
- Knowledge-corpus command surface — delete `prime` and `reprime` endpoints / handlers.
- `KnowledgeAgent` (whichever file defines it in `src/services/worker/knowledge/`) — delete the auto-reprime regex and the branch that calls `reprime`.
- `/query` handler — rewrite to construct an SDK call on the fly: compile the corpus into a `systemPrompt`, issue one `messages.create` call, return the response. The SDK's automatic prompt caching is the caching layer (per `_reference.md` Part 2 on SDK behavior and Part 4 Known gap #2 — "Prompt-caching TTL assumption — Plan 04 depends on SDK cache TTL ≈ 5 min. Run a cost smoke test before Plan 10 lands.").

**Reliance on SDK prompt caching**: The Anthropic SDK's prompt-cache behavior (ephemeral, ~5-minute TTL on `cache_control` blocks) provides the same cost benefit the old `prime` / `reprime` path was trying to hand-roll in-process, without the session persistence, without the regex, and without the auto-reprime loop. Because the benefit is SDK-side, no corpus-side state survives between `/query` calls. This is verified in `_reference.md` Part 2 (Anthropic SDK / prompt-caching row) and called out as a gap in Part 4 row 2.

**Citation**: `_reference.md` Part 1 §Search / read path and Part 2 (SDK / prompt-caching row); `_mapping.md` old Plan 10 row — "All content | KEEP | `04-read-path.md` §Phases 13-18 (delete session_id, delete prime/reprime auto-reprime regex, rewrite /query with systemPrompt)."

---

## Snapshot-test requirement (MANDATORY before Phase 2 deletion)

**Status: MANDATORY. Blocking gate on Phase 2.** The four formatters must NOT be deleted until this snapshot test is in place and passing against the new `renderObservations` path. Without byte-identical verification, formatter regressions are undetectable — this is explicitly flagged as Known gap #5 in `_rewrite-plan.md` and reproduced here.

**The gate**:

1. Before touching the four formatter classes, construct a fixed fixture set — a hand-picked `ObservationRow[]` covering each header type, each grouping mode, each row density, and color on/off.
2. Run the current `AgentFormatter`, `HumanFormatter`, `ResultFormatter`, and `CorpusRenderer` on the fixture set. Capture their output **byte-for-byte** into four `__snapshots__` files.
3. Land Phase 1 (`renderObservations`) as additive — do NOT delete the four formatters yet.
4. Write the snapshot test: `renderObservations(obs, agentConfig)` against the same fixture set must match the captured `AgentFormatter` snapshot **byte-for-byte**; same for `humanConfig` vs. `HumanFormatter`; same for `terseConfig` vs. `ResultFormatter`; same for `corpusConfig` vs. `CorpusRenderer`.
5. Only when all four snapshot comparisons pass byte-identical, execute Phase 2 (delete the four classes).

Without this gate, Phase 2 is a blind deletion: the new renderer could differ from the old in whitespace, ordering, ANSI escape sequences, or token-estimate math, and no test in the corpus would catch it. The byte-identical snapshot is the acceptance boundary between "consolidation" and "silent regression."

**Citation**: `_rewrite-plan.md` §Phase 3 3B Verification — "Snapshot test: `renderObservations` with agent config produces byte-identical output to the old `AgentFormatter` on the same input." `_mapping.md` old Plan 05 row — "Phase 6: Verification | KEEP | `04-read-path.md` §Verification (byte-equality snapshot)."

---

## Verification grep targets

Each command below must return the indicated count or state after this plan lands.

```
grep -n "SearchManager\.findBy" src/                                               → 0   # definitions deleted
grep -rn "RECENCY_WINDOW_MS" src/services/worker/SearchManager.ts                  → 0   # seven hand-rolled copies deleted
grep -n "fellBack: true" src/                                                      → 0   # silent-fallback flag deleted
grep -n "getExistingChromaIds" src/                                                → 0   # @deprecated fence gone
ls src/services/context/formatters/                                                → empty (or directory deleted)
```

**Integration test — fail-fast Chroma**: Shut Chroma down (kill the MCP subprocess, or point the client at an unreachable host). Issue a search request that requires Chroma. Assert the HTTP response is `503` with a non-empty error body — NOT an empty result set, NOT a metadata-only fallback, NOT a `fellBack: true` payload.

**Snapshot test — `renderObservations` byte-identity**: With the `AgentFormatter` snapshot captured against the fixed fixture set (see "Snapshot-test requirement"), assert `renderObservations(fixtureObs, agentConfig)` produces byte-identical output. Same assertion for `humanConfig`, `terseConfig`, `corpusConfig`. Failure of any single comparison blocks Phase 2.

---

## Anti-pattern guards

Reproduced verbatim from `_rewrite-plan.md` §3B:

- **Do NOT create a `RenderStrategy` class hierarchy. Config object only.** No `abstract class RenderStrategy`, no subclass-per-formatter, no factory, no registry. The `type RenderStrategy = { … }` definition in Phase 1 is the whole surface. If a change to this plan later reaches for a class, revisit principle 6 — the knob set is known and finite.
- **Do NOT add a feature flag to "disable fail-fast Chroma" — callers either handle 503 or they don't.** Per principle 2, fail-fast is a contract, not an opt-in. A flag that restores the silent-fallback path would be a fresh violation of the same principle Phase 5 exists to enforce.

Implicit guards (from `00-principles.md` §Six Anti-pattern Guards):

- No new `coerce*`, `recover*`, `heal*`, `repair*` function names in the search or render path.
- No new try/catch that swallows errors and returns a fallback value.
- No new strategy class when a config object would do.

---

## Known gaps / deferrals

**Prompt-caching cost smoke test (MANDATORY preflight for Phase 9).** Before the knowledge-corpus simplification phases ship, a cost smoke test must assert `cache_read_input_tokens > 0` on the **2nd and 3rd** call to `/api/corpus/:name/query` (same corpus, same systemPrompt, within the SDK's cache TTL — approximately 5 minutes). If the cache does not hit, Phase 9's reliance on SDK prompt caching is unfounded, and the cost characteristics will be worse than the deleted `prime` / `reprime` path. This gate is tracked in `98-execution-order.md` §Preflight and verified in `99-verification.md` — per `_reference.md` Part 4 row 2 and `_mapping.md` old Plan 05 row ("Phase 7: Prompt-caching cost note | REWRITE | `99-verification.md` §Cost smoke test gate").

**Dependence on `01-data-integrity.md` §Phase 7.** Chroma write-side reconciliation (delete-then-add under `CHROMA_SYNC_FALLBACK_ON_CONFLICT`) is owned by `01-data-integrity.md`. This plan's Phase 5 fail-fast read behavior is independent of that flag — a read-path `503` is correct even while the write-path fallback remains active, because a read-path Chroma error means the reader cannot serve the request, regardless of whether the write path later reconciles successfully.
