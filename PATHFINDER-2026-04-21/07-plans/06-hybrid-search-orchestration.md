# Plan 06 — hybrid-search-orchestration (clean)

> **Design authority**: `05-clean-flowcharts.md` section 3.6. This plan implements that diagram. When plan and audit disagree, the `06-implementation-plan.md` verified-findings (Phase 0, V11) take precedence.

## Dependencies

- **Upstream**: `07-plans/05-context-injection-engine.md` — introduces `renderObservations(obs, strategy)` and the `SearchResultStrategy` strategy config (derived from `ResultFormatter.ts`). This plan consumes that strategy; it does NOT create it. Hard blocker: Phase 6 below cannot land until Plan 05 Phase 4 lands.
- **Downstream**: `07-plans/10-knowledge-corpus-builder.md` — `CorpusBuilder.build` calls `SearchOrchestrator.search(params)`. Signature stability of `SearchOrchestrator.search` is the contract Plan 10 depends on. Do not rename. Do not change the shape of `StrategySearchResult`.

## Sources consulted

1. `PATHFINDER-2026-04-21/05-clean-flowcharts.md` — section 3.6 (lines 262–292); Part 1 bullshit items #30 #31 #32 #33 (lines 48–51).
2. `PATHFINDER-2026-04-21/06-implementation-plan.md` — Phase 0 V11 (line 38); Phase 4 (lines 208–242); anti-pattern guards C and D (lines 63–64).
3. `PATHFINDER-2026-04-21/01-flowcharts/hybrid-search-orchestration.md` — before-state; full 97 lines.
4. `src/services/worker/SearchManager.ts:1-2069` — full method inventory via grep; spot-read `:1-200`, `:1209-1310`.
5. `src/services/worker/search/SearchOrchestrator.ts:1-290` — confirmed `search(args: any): Promise<StrategySearchResult>` signature; `executeWithFallback` at `:81-121`; silent fallback branch at `:100-110`.
6. `src/services/worker/search/strategies/ChromaSearchStrategy.ts:1-247` — `filterByRecency` at `:196-217`; hard-coded 90-day cutoff via `SEARCH_CONSTANTS.RECENCY_WINDOW_MS` at `:200`.
7. `src/services/worker/search/strategies/SQLiteSearchStrategy.ts:1-132`, `HybridSearchStrategy.ts:1-240`, `SearchStrategy.ts:1-61` — strategy interface and existence confirmed.
8. `src/services/worker/search/types.ts:15-16` — `RECENCY_WINDOW_DAYS: 90` and `RECENCY_WINDOW_MS: 90 * 24 * 60 * 60 * 1000`.
9. `src/services/worker/http/routes/SearchRoutes.ts:1-303` — 14 search/context handlers, all delegating `await this.searchManager.<method>(req.query)`.
10. `PATHFINDER-2026-04-21/07-plans/05-context-injection-engine.md` — `SearchResultStrategy` signature & path (`src/services/worker/search/strategies/SearchResultStrategy.ts` per that plan's Phase 4).

## Concrete findings

### SearchManager method inventory (2069 lines)

Classifications per Decision D ("if body is `return this.other.method(args)`, delete it"):

| `:line` | Method | Classification | Notes |
|---|---|---|---|
| `:59` | `queryChroma` | **real-work (but @deprecated)** | Pre-Orchestrator; called only by `searchChromaForTimeline` and `findByConcept`/`findByFile` hybrid paths inside `SearchManager`. **DELETE** (item #30). |
| `:70` | `searchChromaForTimeline` | **real-work (but @deprecated)** | Bakes 90-day cutoff via `ninetyDaysAgo` param. Callers: only `timeline()` `:490`. **DELETE** (item #30). |
| `:103` | `normalizeParams` | **display-wrap helper** | SearchOrchestrator `:239` has an equivalent. This one adds `filePath→files`, `concept→concepts`, `isFolder` coercion. If we keep SearchManager display-wrap, keep this. Otherwise fold into SearchOrchestrator.normalizeParams and delete. |
| `:161` | `search` | **real-work (display-wrap)** | Lines 161–445: re-implements the whole decision tree + recency filter + categorization + markdown tables. Contains one of four 90-day filter copies (`:230-259`). This is the V11 "real work" method. **REFACTOR**: decision tree/execution deleted (already in Orchestrator); keep only the markdown combining → migrate to `renderObservations(combined, SearchResultStrategy)`. |
| `:450` | `timeline` | **real-work (display-wrap)** | Uses `searchChromaForTimeline` `:490` + 90-day cutoff `:488`. Delegates to `TimelineBuilder` for rendering. **REFACTOR**: strip 90-day cutoff; call `SearchOrchestrator` timeline helpers (`getTimeline`, `formatTimeline` at Orchestrator `:185-209`). |
| `:731` | `decisions` | **display-wrap** | Semantic shortcut; queries Chroma for "decision" observations, renders tables. Route could call `SearchOrchestrator.search({query:'decision', ...})` directly; keep the markdown wrap. |
| `:810` | `changes` | **display-wrap** | Same shape as `decisions`. |
| `:894` | `howItWorks` | **display-wrap** | Same shape. |
| `:951` | `searchObservations` | **pass-through** (with backward-compat shim) | `{type:'observations'}` preset + call through. **DELETE**; route calls `SearchOrchestrator.search({...req.query, type:'observations'})`. |
| `:1037` | `searchSessions` | **pass-through** | Same; `type:'sessions'`. **DELETE**. |
| `:1123` | `searchUserPrompts` | **pass-through** | Same; `type:'prompts'`. **DELETE**. |
| `:1209` | `findByConcept` | **real-work (display-wrap)** | Duplicates the two-phase hybrid logic that exists in `HybridSearchStrategy.findByConcept` at `HybridSearchStrategy.ts:74`. Pure duplication. **DELETE** execution; route calls `SearchOrchestrator.findByConcept(concept, args)` at `SearchOrchestrator.ts:126`. Keep markdown header/table rendering via `renderObservations(obs, SearchResultStrategy)`. |
| `:1277` | `findByFile` | **real-work (display-wrap)** | Same pattern — duplicates `HybridSearchStrategy.findByFile`. **DELETE** execution; route → `SearchOrchestrator.findByFile`. Keep render. |
| `:1399` | `findByType` | **real-work (display-wrap)** | Same pattern — duplicates `HybridSearchStrategy.findByType`. **DELETE** execution; route → `SearchOrchestrator.findByType`. Keep render. |
| `:1468` | `getRecentContext` | **real-work** | ContextBuilder territory, NOT search. Leave to Plan 05. |
| `:1596` | `getContextTimeline` | **real-work** | Same — ContextBuilder / Plan 05. Leave. |
| `:1810` | `getTimelineByQuery` | **real-work** | Contains a fourth copy of the 90-day filter at `:1840-1847`. Depends on `SearchOrchestrator.getTimeline` + `formatTimeline`. **REFACTOR**: strip 90-day; delegate. |

**Tally**: 3 pure pass-throughs to delete (`:951`, `:1037`, `:1123`); 2 `@deprecated` to delete (`:59`, `:70`); 6 real-work methods that keep only their rendering (`:161`, `:450`, `:1209`, `:1277`, `:1399`, `:1810`); 3 semantic shortcuts kept as display-wraps (`:731`, `:810`, `:894`); 2 ContextBuilder-owned methods left for Plan 05 (`:1468`, `:1596`). Every remaining "real-work" body becomes `orchestrator.X(args)` + `renderObservations(combined, SearchResultStrategy, ctx)` — no decision tree, no Chroma calls, no recency filter.

### Duplication vs facade distinction

The three hybrid methods (`findByConcept` `:1209`, `findByFile` `:1277`, `findByType` `:1399`) are not thin facades — they implement the same two-phase (SQLite metadata filter → Chroma semantic rank → intersect) algorithm that already lives in `HybridSearchStrategy.ts:26-240`. This is **parallel reimplementation**, not delegation. Phase 6 kills the in-file copy and routes through `SearchOrchestrator.findByConcept/File/Type` (`SearchOrchestrator.ts:126-180`), which already wraps `HybridSearchStrategy`.

### filterByRecency location

- **Canonical**: `src/services/worker/search/strategies/ChromaSearchStrategy.ts:196-217` — `private filterByRecency(chromaResults)`. Uses `SEARCH_CONSTANTS.RECENCY_WINDOW_MS` at `:200`. Called from `:119` inside `executeChromaSearch`.
- **Constant**: `src/services/worker/search/types.ts:15` — `RECENCY_WINDOW_DAYS: 90`; `:16` — `RECENCY_WINDOW_MS: 90 * 24 * 60 * 60 * 1000`.
- **Legacy copies in `SearchManager.ts`**: `:230`, `:247-259`, `:488`, `:978-985`, `:1064-1071`, `:1150-1157`, `:1840-1847`. All delete with the methods above or their refactors.

### Current Chroma-fail behavior (item #32 silent fallback)

`SearchOrchestrator.executeWithFallback` at `SearchOrchestrator.ts:93-110`:

```ts
const result = await this.chromaStrategy.search(options);
if (result.usedChroma) return result;
// Chroma failed - fall back to SQLite for filter-only
const fallbackResult = await this.sqliteStrategy.search({
  ...options,
  query: undefined // Remove query for SQLite fallback   <-- DROPS query text silently
});
return { ...fallbackResult, fellBack: true };
```

And inside `ChromaSearchStrategy.search` at `:76-86`, a thrown error becomes `{ usedChroma: false, fellBack: false }` (swallowed). The Orchestrator's `usedChroma=false` branch then runs SQLite with the query text stripped. **This is the silent fallback from audit item #32**. The current behavior drops the query text and returns filter-only SQLite results — no 503, no error signal to the caller. Caller (SearchManager) flips a `chromaFailed` flag into the rendered markdown, but JSON callers (viewer UI, mem-search skill, CorpusBuilder) have no way to detect it.

### Route surface

`src/services/worker/http/routes/SearchRoutes.ts` declares 18 endpoints. Of those that invoke `this.searchManager.*`:

- Pass-through candidates (3): `/api/search/observations` `:98`, `/api/search/sessions` `:107`, `/api/search/prompts` `:116`.
- Route-to-Orchestrator-directly candidates (3): `/api/search/by-concept` `:125`, `/api/search/by-file` `:134`, `/api/search/by-type` `:143`.
- Display-wrap kept: `/api/search` `:53`, `/api/timeline` `:62`, `/api/decisions` `:71`, `/api/changes` `:80`, `/api/how-it-works` `:89`, `/api/timeline/by-query` `:303`, plus `/api/context/*` (Plan 05 territory).

## Copy-ready snippet locations

- Hybrid decision tree + 503 branch target: `SearchOrchestrator.ts:81-121`. Replace lines 100–110 with the 503 throw.
- 503 shape: follow anti-pattern guard C from `06-implementation-plan.md:63` — throw a typed `ChromaUnavailableError` (new class `src/services/worker/search/errors.ts`) with `code='chroma_unavailable'`; `SearchRoutes.wrapHandler` catches and maps to `res.status(503).json({error:'chroma_unavailable'})`.
- Render path: `renderObservations(combined, SearchResultStrategy, ctx)` from Plan 05 Phase 4 → new file `src/services/worker/search/strategies/SearchResultStrategy.ts`.
- Pass-through deletion ranges: `SearchManager.ts:951-1036` (`searchObservations`), `:1037-1122` (`searchSessions`), `:1123-1208` (`searchUserPrompts`).
- `filterByRecency` + callers to delete: `ChromaSearchStrategy.ts:196-217` + call site `:119`; `SEARCH_CONSTANTS.RECENCY_WINDOW_DAYS`/`_MS` at `types.ts:15-16`; plus the seven copies in `SearchManager.ts` listed above.

## Confidence + gaps

**High confidence**:
- SearchManager method classifications (grep-verified inventory; body-read for the three hybrid methods confirms exact duplication of `HybridSearchStrategy.*`).
- Current silent-fallback behavior (read in `SearchOrchestrator.ts:93-110`).
- 90-day default exists at exactly one shared constant (`types.ts:15-16`) plus seven in-file duplicate copies inside `SearchManager.ts`.

**Gaps**:
- Semantic-inject POST `/api/context/semantic` at `SearchRoutes.ts:270` calls `searchManager.search` with its own mini-formatter **post-render** (flagged by Plan 05 Phase 6). This plan does not touch that handler; Plan 05 owns it.
- `ResultFormatter.formatSearchResults` callers — need one grep pass during Phase 6 to confirm no other caller beyond `SearchManager.search` at `:321`, `formatSearchResults` routes, and `SearchOrchestrator.ts:214` (which also exposes it). Left as a Phase 6 checklist item.
- Exact JSON error body shape for 503 — two reasonable choices (`{error:'chroma_unavailable'}` vs `{error:{code:'chroma_unavailable', retryable:true}}`). Defer to Phase 4 decision; current plan uses the simpler shape.

---

## Phase 1 — Classify every `SearchManager` method

**(a) What**: Lock the method inventory above into the repo as a code comment in `SearchManager.ts` header (keeps future auditors honest). No behavior change.

**(b) Docs**: `05-clean-flowcharts.md` Part 1 item #31; `06-implementation-plan.md:38` (V11); live file `src/services/worker/SearchManager.ts:1-2069`.

**(c) Verification**:
- `grep -n "^\s*async \+[a-zA-Z]" src/services/worker/SearchManager.ts | wc -l` → 15 public async methods (matches inventory).
- `grep -n "@deprecated" src/services/worker/SearchManager.ts` → exactly one hit at `:57` (`queryChroma`). Confirm `searchChromaForTimeline` at `:70` is untagged but classified deprecated per `01-flowcharts/hybrid-search-orchestration.md:91`.

**(d) Anti-pattern guards**: Guard D — every method marked "pass-through" in the inventory must have a body that trivially forwards to `this.orchestrator.*` after reading. If a method claims pass-through but also does date filtering or recency windows, reclassify as real-work before later phases delete it.

---

## Phase 2 — Delete `@deprecated` methods

**(a) What**: Copy from `SearchManager.ts:59-97` — **delete** both `queryChroma` and `searchChromaForTimeline`. Update `timeline()` at `:490` to call `SearchOrchestrator.getTimeline` / `formatTimeline` (`SearchOrchestrator.ts:185-209`) instead.

**(b) Docs**: `05-clean-flowcharts.md` Part 1 item #30 (line 48); `05-clean-flowcharts.md` §3.6 "Deleted" bullet 2 (line 286); `SearchManager.ts:57` @deprecated tag.

**(c) Verification**:
- `grep -rn "queryChroma\|searchChromaForTimeline" src/` → only hits are `chromaSync.queryChroma` (ChromaSync public method — do not touch) and `ChromaSearchStrategy.ts` calls to `chromaSync.queryChroma`.
- `grep -n "@deprecated" src/services/worker/SearchManager.ts` → zero hits.
- `npm run build` passes; `/api/timeline?query=x` still returns timeline.

**(d) Anti-pattern guards**: Guard D — no replacement shim; delete outright. Do not leave a `/** @deprecated */` stub calling the Orchestrator — that is the thin-facade anti-pattern returning.

---

## Phase 3 — Route `SearchRoutes` directly to `SearchOrchestrator` for pass-throughs

**(a) What**: In `src/services/worker/http/routes/SearchRoutes.ts`:
1. Inject `SearchOrchestrator` alongside `SearchManager` (or replace `SearchManager` prop entirely once Phase 6 lands). Copy constructor wiring shape from `SearchRoutes.ts:14-18`.
2. Rewire three handlers:
   - `:98` `handleSearchObservations` → `await this.orchestrator.search({...req.query, type:'observations'})`
   - `:107` `handleSearchSessions` → `await this.orchestrator.search({...req.query, type:'sessions'})`
   - `:116` `handleSearchPrompts` → `await this.orchestrator.search({...req.query, type:'prompts'})`
3. Delete `searchObservations`, `searchSessions`, `searchUserPrompts` from `SearchManager.ts:951-1208`.

**(b) Docs**: `05-clean-flowcharts.md` §3.6 diagram (line 267 `B --> C`); `06-implementation-plan.md:208-225` Phase 4 step 1; live file `src/services/worker/http/routes/SearchRoutes.ts:98-118` and `SearchManager.ts:951-1208`.

**(c) Verification**:
- `grep -n "this.searchManager.search\(Observations\|Sessions\|UserPrompts\)" src/` → zero hits.
- `curl localhost:37777/api/search/observations?query=x` returns the same JSON shape as before (snapshot test).
- Chroma-down test: stop the Chroma subprocess; call `/api/search/observations?query=x` → **503 with `{error:'chroma_unavailable'}`** (contract established in Phase 4). Not an empty `observations:[]` array.

**(d) Anti-pattern guards**:
- Guard D — the deleted methods were ~85 lines each of wrapping; make sure the replacement route lines do NOT re-import a "for type consistency" shim from SearchManager.
- Guard C — if the old pass-through silently caught Chroma failures and returned `observations:[]`, the new direct route must propagate the 503 from Phase 4.

---

## Phase 4 — Replace silent Chroma-fail with 503 in `SearchOrchestrator`

**(a) What**: Copy from `SearchOrchestrator.ts:90-110`. Delete the fallback branch:
```ts
// DELETE these lines 100-110
const fallbackResult = await this.sqliteStrategy.search({...options, query: undefined});
return {...fallbackResult, fellBack: true};
```
Replace with:
```ts
throw new ChromaUnavailableError();
```
Add `src/services/worker/search/errors.ts` exporting `class ChromaUnavailableError extends Error { code = 'chroma_unavailable' }`.

Also update `ChromaSearchStrategy.ts:76-86` — the catch block currently swallows errors and returns `usedChroma:false`. Change to rethrow as `ChromaUnavailableError` so `executeWithFallback` sees it.

In `SearchRoutes.ts` `wrapHandler` (or `BaseRouteHandler`), catch `ChromaUnavailableError` → `res.status(503).json({error:'chroma_unavailable'})`.

Update `SearchOrchestrator.findByConcept`/`findByType`/`findByFile` (`:126-180`) — today they fall back to SQLite-only on no-hybrid. That fallback is **allowed** because concept/type/file filters are legitimate without Chroma. Only text-query paths get 503. Document this distinction inline.

**(b) Docs**: `05-clean-flowcharts.md` Part 1 item #32 (line 50); `05-clean-flowcharts.md` §3.6 line 271 (`Return 503 error=chroma_unavailable (NO silent fallback)`); `06-implementation-plan.md:63` anti-pattern C; `06-implementation-plan.md:644` verification line (grep for `res.status(503)` + `chroma_unavailable`).

**(c) Verification**:
- Unit test: stub `ChromaSync.queryChroma` to throw → `SearchOrchestrator.search({query:'x'})` throws `ChromaUnavailableError`.
- Unit test: construct `SearchOrchestrator` with `chromaSync = null` → `search({query:'x'})` throws `ChromaUnavailableError` (today returns an empty result at `:115-120`; that branch also goes).
- Integration test: `curl localhost:37777/api/search?query=x` with Chroma disabled → `503` with body `{"error":"chroma_unavailable"}`.
- Integration test: `curl localhost:37777/api/search/by-concept?concept=x` with Chroma disabled → 200 with SQLite-only results. Concept/type/file filters remain functional without Chroma; only text-query paths hard-fail.
- `curl localhost:37777/api/search` (no query) with Chroma disabled → 200 with SQLite filter-only results (this path is legitimate per §3.6 line 272).
- `grep -rn "query: undefined" src/services/worker/search/` → zero hits (the silent-drop pattern).
- `grep -rn "fellBack" src/` → zero hits. The `fellBack` field on `StrategySearchResult` is obsolete once fallback is deleted; remove from `types.ts` as part of this phase.

**(d) Anti-pattern guards**:
- Guard C — primary target. Silent fallback deleted; explicit error class + HTTP status.
- Guard D — do not wrap the new throw behind a shim in `SearchManager`. The orchestrator throws; routes handle.

---

## Phase 5 — Delete `filterByRecency` and the 90-day default

**(a) What**:
1. Copy from `ChromaSearchStrategy.ts:196-217` — **delete** `filterByRecency` method.
2. Delete its call site at `ChromaSearchStrategy.ts:119` (`const recentItems = this.filterByRecency(chromaResults);`). Replace with direct `chromaResults.ids` + `metadatas` join (preserve the metadata-by-id map logic from the old method's lines `:202-208` — that dedup IS real work; only the 90-day filter goes).
3. Delete `SEARCH_CONSTANTS.RECENCY_WINDOW_DAYS` and `RECENCY_WINDOW_MS` from `src/services/worker/search/types.ts:15-16`.
4. Delete the seven in-file copies in `SearchManager.ts` (lines 230-259, 488, 978-985, 1064-1071, 1150-1157, 1840-1847). Replaced by caller-supplied `dateRange` only — if caller wants recency, caller passes `dateRange: {start, end}`.

**(b) Docs**: `05-clean-flowcharts.md` Part 1 item #33 (line 51); `05-clean-flowcharts.md` §3.6 "Deleted" bullet 4 (line 288); live `src/services/worker/search/strategies/ChromaSearchStrategy.ts:196-217`; `src/services/worker/search/types.ts:15-16`.

**(c) Verification**:
- `grep -rn "RECENCY_WINDOW\|filterByRecency\|ninetyDaysAgo\|90.day\|90 days" src/` → zero hits.
- Integration test: seed an observation dated 100 days ago; query by its text → it appears in results (would have been filtered out pre-deletion).
- Integration test: pass `dateRange.start` = 60 days ago; observation from 100 days ago is excluded. Explicit filter still works.

**(d) Anti-pattern guards**:
- Guard C — silent implicit filter replaced by explicit caller param.
- Guard D — no "convenience wrapper" that re-applies 90 days when `dateRange` is missing. Missing = all.

---

## Phase 6 — Keep display-wrap in `SearchManager`; switch to `renderObservations(results, SearchResultStrategy)`

**BLOCKED until**: Plan 05 Phase 4 lands and ships `src/services/worker/search/strategies/SearchResultStrategy.ts`.

**(a) What**:
1. In `SearchManager.ts:161-445` (`search`): delete everything from the `PATH 1` decision at `:177` through the categorization/hydration blocks at `:321`. The full decision tree is already in `SearchOrchestrator.search`. Replace body with:
```ts
async search(args: any): Promise<any> {
  const results = await this.orchestrator.search(args);
  if (args.format === 'json') return { content:[{type:'text', text: JSON.stringify(results)}] };
  const combined = combineResults(results.results);
  return { content:[{type:'text', text: renderObservations(combined, SearchResultStrategy, ctx)}] };
}
```
2. Apply same transformation to `timeline` `:450`, `findByConcept` `:1209`, `findByFile` `:1277`, `findByType` `:1399`, `getTimelineByQuery` `:1810`. Each becomes: call orchestrator → render via strategy. Keep the outer `{content:[{type:'text', ...}]}` MCP envelope; drop everything in between.
3. Keep `decisions`, `changes`, `howItWorks` `:731-950` as semantic-shortcut wrappers. They compute a preset query string, call `this.orchestrator.search({...args, query:'decision'})` (or equivalent), render via `renderObservations`. Body shrinks from ~70 lines each to ~10.
4. Delete or drop-in replace `normalizeParams` at `:103` — `SearchOrchestrator.normalizeParams` at `:239` is canonical. If the API-only coercions (`filePath→files`, `isFolder`) are missing there, **move them into** `SearchOrchestrator.normalizeParams` and delete the SearchManager copy. Guard: grep every caller to confirm the Orchestrator version covers all cases.

**(b) Docs**: `05-clean-flowcharts.md` §3.6 line 281 (`Fmt -->|markdown| M["renderObservations(results, SearchResultStrategy)"]`); `06-implementation-plan.md:220-225` (Phase 4 step 3 — keep the combine/group/table code as a `ResultRenderer` module); `07-plans/05-context-injection-engine.md:169-182` Phase 4 (SearchResultStrategy); live `src/services/worker/SearchManager.ts:161-445`.

**(c) Verification**:
- `wc -l src/services/worker/SearchManager.ts` → under 400 lines (from 2069).
- Snapshot test: fixture `SearchResults` → `renderObservations(combined, SearchResultStrategy, ctx)` output is byte-equal to the pre-refactor `ResultFormatter.formatSearchResults` output. Plan 05 Phase 4 owns this fixture; reuse it here.
- `grep -n "combineResults\|groupByDate\|groupByFile" src/services/worker/SearchManager.ts` → zero hits (now lives in SearchResultStrategy / renderObservations).
- Manual: viewer UI `http://localhost:37777` search results render identically.

**(d) Anti-pattern guards**:
- Guard D — SearchManager's remaining methods must each be ≤15 lines (orchestrator call + render envelope). If any method balloons back, it's re-implementing decision logic.
- Guard A (strategy count from Plan 05 audit Part 2) — don't invent a fifth strategy just for "semantic context injection". Plan 05 Phase 6 routes that handler through `SearchResultStrategy` with a flag.

---

## Phase 7 — Verification

Run all checks from phases 1–6 in one pass, plus:

1. **Behavior preservation**:
   - All three search paths (filter-only, Chroma-semantic, hybrid concept/type/file) return results for representative queries.
   - `?format=json` and default markdown both work on every search endpoint.
   - `concept=`, `type=`, `obs_type=`, `files=`, `filePath=` filters all honored (grep-verify normalizeParams covers each).
   - Timeline endpoint returns chronological groupings with anchor depth filtering intact.

2. **Chroma-down contract**:
   - Stop Chroma subprocess. `curl /api/search?query=x` → 503 `{"error":"chroma_unavailable"}`. Not empty, not silent.
   - `curl /api/search` (no query) → 200 with SQLite filter results.
   - `curl /api/search/by-concept?concept=foo` → 200 with SQLite metadata results (per `SearchOrchestrator.ts:126-140`).

3. **Line-count targets**:
   - `SearchManager.ts`: 2069 → under 400 lines (≥1600 deleted).
   - `SearchOrchestrator.ts`: ~290 → ~280 (fallback branch removed, error class added).
   - `ChromaSearchStrategy.ts`: 247 → ~215 (filterByRecency deleted).
   - Net project delete target: ~1700 lines.

4. **Grep contract checks**:
   - `grep -rn "query: undefined" src/services/worker/search/` → 0.
   - `grep -rn "RECENCY_WINDOW\|filterByRecency\|ninetyDaysAgo" src/` → 0.
   - `grep -rn "@deprecated" src/services/worker/SearchManager.ts` → 0.
   - `grep -rn "this.searchManager.search\(Observations\|Sessions\|UserPrompts\)" src/` → 0.
   - `grep -rn "res.status(503)" src/services/worker/http/` → at least one hit on the `chroma_unavailable` path.

5. **Downstream smoke** (Plan 10 contract):
   - `CorpusBuilder.build` test — feed synthetic observations, confirm `SearchOrchestrator.search` signature unchanged and `StrategySearchResult` shape stable.

6. **Anti-pattern audit**:
   - Guard C: no `catch { return empty }` patterns in `src/services/worker/search/`.
   - Guard D: every method in `SearchManager.ts` either renders or shortcut-presets. No single-line `return this.orchestrator.x(args)` remains.
