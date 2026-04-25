# Flowchart: hybrid-search-orchestration

## Sources Consulted
- `src/services/worker/search/SearchOrchestrator.ts:1-290`
- `src/services/worker/search/strategies/ChromaSearchStrategy.ts:1-120`
- `src/services/worker/search/strategies/SQLiteSearchStrategy.ts:1-120`
- `src/services/worker/search/strategies/HybridSearchStrategy.ts:1-240`
- `src/services/worker/search/ResultFormatter.ts:1-200`
- `src/services/worker/search/TimelineBuilder.ts:1-220`
- `src/services/worker/SearchManager.ts:1-600`
- `src/services/worker/http/routes/SearchRoutes.ts:1-150`

## Happy Path Description

`/api/search` → `SearchRoutes` → `SearchManager.search()` (thin facade) → `SearchOrchestrator` chooses among three strategies:

**Path 1 (Filter-only):** No query text → `SQLiteSearchStrategy` does metadata-only filter via SessionSearch (date range, project, concept/type/file).

**Path 2 (Semantic):** Query text + ChromaSync available → `ChromaSearchStrategy.queryChroma` → filter by recency (90-day default or custom) → categorize by doc type → hydrate from SQLite. If Chroma fails mid-query, orchestrator falls back to filter-only SQLite (drops the query term).

**Path 3 (Hybrid):** `findByConcept|Type|File` specialty methods → `HybridSearchStrategy` two-phase: (1) SQLite metadata filter → all matching IDs; (2) Chroma semantic ranking → re-rank; (3) intersect + hydrate → return metadata-matched IDs in Chroma rank order.

`ResultFormatter` renders markdown tables grouped by date/file. `TimelineBuilder` handles chronological grouping with anchor-based depth filtering.

## Mermaid Flowchart

```mermaid
flowchart TD
    A["GET /api/search<br/>SearchRoutes.ts:22"] --> B["SearchManager.search<br/>SearchManager.ts:161"]
    B --> C["SearchOrchestrator.search<br/>SearchOrchestrator.ts:71"]
    C --> D{Decision<br/>SearchOrchestrator.ts:81}

    D -->|no query| E["SQLiteStrategy.search<br/>SQLiteSearchStrategy.ts:38"]
    D -->|query + Chroma| F["ChromaStrategy.search<br/>ChromaSearchStrategy.ts:42"]
    D -->|no Chroma| G["Return empty<br/>SearchOrchestrator.ts:115"]

    E --> E1["SessionSearch.searchObservations/Sessions/Prompts"]
    E1 --> E4["StrategySearchResult<br/>SearchOrchestrator.ts:98"]

    F --> F1["ChromaSync.queryChroma<br/>ChromaSearchStrategy.ts:104"]
    F1 --> F3["filterByRecency 90d<br/>SearchOrchestrator.ts:119"]
    F3 --> F4["categorizeByDocType<br/>SearchOrchestrator.ts:120"]
    F4 --> F5["hydrate from SQLite"]
    F5 --> F6["StrategySearchResult usedChroma=true"]
    F --> F7[/Error?/]
    F7 -->|yes| F8["SQLiteStrategy fallback<br/>SearchOrchestrator.ts:102"]
    F8 --> E4_Fallback["fellBack=true<br/>SearchOrchestrator.ts:107"]

    E4 --> H["SearchManager formats<br/>SearchManager.ts:320-444"]
    E4_Fallback --> H
    F6 --> H
    G --> H

    H --> Hfmt{format?}
    Hfmt -->|json| H1["Raw JSON"]
    Hfmt -->|markdown| H2["ResultFormatter.formatSearchResults<br/>ResultFormatter.ts:25"]
    H2 --> H3["combineResults<br/>ResultFormatter.ts:115"]
    H3 --> H4["groupByDate<br/>ResultFormatter.ts:49"]
    H4 --> H5["groupByFile<br/>ResultFormatter.ts:61"]
    H5 --> H9["Markdown tables"]

    J["findByConcept/Type/File<br/>SearchOrchestrator.ts:126-180"] --> K["HybridStrategy<br/>HybridSearchStrategy.ts:26"]
    K --> K1["Phase 1: SessionSearch metadata filter<br/>HybridSearchStrategy.ts:74/112/152"]
    K1 --> K2["Phase 2: ChromaSync.queryChroma<br/>HybridSearchStrategy.ts:180/208"]
    K2 --> K3["Phase 3: intersectWithRanking<br/>HybridSearchStrategy.ts:228"]
    K3 --> K4["hydrate SQLite<br/>HybridSearchStrategy.ts:188"]
    K4 --> K5["StrategySearchResult usedChroma=true"]

    L["TimelineBuilder.buildTimeline<br/>TimelineBuilder.ts:46"] --> L1["Unify obs/sessions/prompts"]
    L1 --> L2["filterByDepth<br/>TimelineBuilder.ts:73"]
    L2 --> L3["formatTimeline<br/>TimelineBuilder.ts:124"]
```

## Side Effects

- Chroma unavailability → fallback to filter-only SQLite (drops query text).
- Default 90-day recency filter unless `dateRange` is explicit.
- HybridStrategy errors → metadata-only results with `fellBack=true`.
- SearchManager normalizes comma-separated URL params → arrays.

## External Feature Dependencies

**Calls into:** ChromaSync, SessionSearch (SQLite FTS5), SessionStore (hydration), ModeManager (type icons), timeline-formatting helpers.

**Called by:** Search routes, mem-search skill, CorpusBuilder (via SearchOrchestrator).

## Important Clarification: SearchManager vs SearchOrchestrator

- **SearchOrchestrator** is the canonical strategy coordinator introduced in Jan 2026 monolith refactor.
- **SearchManager** is a **thin facade** delegating to SearchOrchestrator, plus HTTP/display wrapping.
- **NOT duplicates.** But SearchManager retains legacy private methods (`queryChroma`, `searchChromaForTimeline` marked `@deprecated`) — candidates for cleanup.

## Confidence + Gaps

**High:** Three paths + fallback chains; SearchManager is thin facade; TimelineBuilder is standalone formatter.

**Gaps:** Pagination enforcement across strategies; CorpusBuilder's exact call into SearchOrchestrator; deprecated SearchManager methods still present.
