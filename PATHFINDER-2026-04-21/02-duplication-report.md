# Pathfinder Phase 2: Duplication Report

**Date**: 2026-04-21
**Method**: Two parallel subagents (within-feature + cross-feature) with source verification.

---

## Part A: Within-Feature Duplications

### A1. privacy-tag-filtering — redundant wrapper functions
- **Pattern**: `stripMemoryTagsFromPrompt` and `stripMemoryTagsFromJson` wrap `stripTagsInternal` with identical logic.
- **Locations**: `src/utils/tag-stripping.ts:79-91`
- **Consolidation shape**: Single `stripMemoryTags(content, context?)` with optional caller-context parameter.

### A2. context-injection-engine — independent formatter traversals
- **Pattern**: AgentFormatter, HumanFormatter, CorpusRenderer each independently iterate observations with identical icon/title/token/time lookup.
- **Locations**: `src/services/context/formatters/AgentFormatter.ts:36-200`, `src/services/context/formatters/HumanFormatter.ts:35-238`, `src/services/worker/knowledge/CorpusRenderer.ts:39-85`
- **Consolidation shape**: Shared `ObservationRenderer` base with pluggable header/row/footer methods.

### A3. hybrid-search-orchestration — strategy result post-processing
- **Pattern**: Grouping-by-date and grouping-by-file logic duplicated across strategies/formatter/timeline builder.
- **Locations**: `src/services/worker/search/SearchOrchestrator.ts:71-115`, `src/services/worker/search/ResultFormatter.ts:25-110`, `src/services/worker/search/TimelineBuilder.ts:124-240`
- **Consolidation shape**: Strategies return raw `SearchResults`; formatting centralized in `ResultFormatter`.

### A4. session-lifecycle-management — dual reapers
- **Pattern**: `staleSessionReaperInterval` (2m) and `startOrphanReaper` (30s) serve overlapping lifecycle goals.
- **Locations**: `src/services/worker-service.ts:547`, `src/services/worker/ProcessRegistry.ts:508`, `src/services/worker/SessionManager.ts:516`
- **Consolidation shape**: Single `UnifiedReaper` with pluggable check intervals per concern.

### A5. sqlite-persistence — migration boilerplate
- **Pattern**: 27 migrations repeat `CREATE TABLE IF NOT EXISTS`, ALTER logic, PRAGMA settings, and FK-preserving table recreation.
- **Locations**: `src/services/sqlite/migrations/runner.ts:52-123, 265-296, 383-433, ...`
- **Consolidation shape**: Extract `createTableWithDefaults`, `alterTableRename`, `recreateTableWithForeignKeys` helpers.

### A6. response-parsing-storage — parallel XML parsers
- **Pattern**: `parseObservations` and `parseSummary` use identical regex-based extraction helpers on different tag sets.
- **Locations**: `src/sdk/parser.ts:33-120` (obs), `src/sdk/parser.ts:122-240` (summary)
- **Consolidation shape**: `parseXmlContent(text, tagDefinitions)` driven by a registry.

### A7. session-lifecycle-management — ProcessRegistry layering
- **Pattern**: Worker-level `ProcessRegistry` is a facade over supervisor-level registry; surface duplication in registerProcess/unregisterProcess/getAll/getByPid.
- **Locations**: `src/services/worker/ProcessRegistry.ts:57-79`, `src/supervisor/process-registry.ts:175-409`
- **Consolidation shape**: Deprecate worker facade; expose supervisor registry directly.

### A8. knowledge-corpus-builder — observation metadata duplication
- **Pattern**: CorpusRenderer.renderObservation and AgentFormatter.renderAgentTableRow both format icon + title + tokens + time with nearly identical logic.
- **Locations**: `src/services/worker/knowledge/CorpusRenderer.ts:39-85`, `src/services/context/formatters/AgentFormatter.ts:127-137`
- **Consolidation shape**: Extract `formatObservationMetadata(obs, config)` returning structured metadata.

---

## Part B: Cross-Feature Duplications

### B1. Observation capture paths — LEGITIMATE
- **Locations**: `src/cli/handlers/observation.ts:31-86`, `src/services/transcripts/processor.ts:240-244`, `src/services/worker/http/routes/SessionRoutes.ts:565`
- **Verdict**: Both capture mechanisms are valid (sync IDE hook vs file-based JSONL) and converge at `/api/sessions/observations`. Divergence above the endpoint is intrinsic to their data sources.

### B2. Observation rendering — ACCIDENTAL
- **Locations**: `src/services/worker/search/ResultFormatter.ts:25-100`, `src/services/context/formatters/AgentFormatter.ts:36-80`, `src/services/worker/knowledge/CorpusRenderer.ts:14-80`
- **Verdict**: Audiences differ (CLI search results vs LLM context injection vs agent priming) but no shared interface — ~200 lines of overlapping logic. **Top candidate for unification.**

### B3. Observation storage write paths — MIXED
- **Locations**: `src/services/sqlite/observations/store.ts:53` (ResponseProcessor), `src/services/worker/http/routes/MemoryRoutes.ts` (manual save), `src/services/worker/http/routes/SessionRoutes.ts:637` (queueObservation → pending queue), `src/services/transcripts/processor.ts:252` (via observationHandler)
- **Verdict**: ResponseProcessor + PendingMessageStore path is intentional (queue + atomic write). MemoryRoutes manual insert is a deliberate feature. Transcript-watcher's re-delegation through observationHandler is **ACCIDENTAL** — could invoke `queueObservation` directly.

### B4. XML parser duplication — ACCIDENTAL
- **Locations**: `src/sdk/parser.ts:33-300` (canonical), `src/bin/import-xml-observations.ts:162` (parallel parseSummary in CLI import tool)
- **Verdict**: Import tool should reuse canonical parser. Type-validation bypass is a code smell and future schema drift risk.

### B5. Privacy tag stripping asymmetry — ACCIDENTAL + SECURITY GAP
- **Locations**: `src/utils/tag-stripping.ts:51` (full 6-tag strip for prompts + tool I/O), `src/utils/transcript-parser.ts:84` (system-reminder only at read time), `src/cli/handlers/summarize.ts:66` (system-reminder only for assistant-message summaries)
- **Verdict**: The summary path does NOT strip `<private>`, `<claude-mem-context>`, etc. from assistant messages before queuing. **Private content can leak into stored summaries.** Highest-priority fix.

### B6. Session initialization flow — LEGITIMATE
- **Locations**: `src/services/worker/http/routes/SessionRoutes.ts:814` (HTTP endpoint), `src/cli/handlers/session-init.ts:38-192` (CLI wrapper), `src/services/transcripts/processor.ts:185` (direct handler invocation)
- **Verdict**: HTTP is canonical; CLI wraps; transcript-watcher's direct-handler path avoids loopback — acceptable optimization.

### B7. Search entry points — LEGITIMATE
- **Locations**: `src/services/worker/search/SearchOrchestrator.ts:71` (canonical), `src/services/worker/SearchManager.ts:161` (thin HTTP facade), `src/services/worker/knowledge/CorpusBuilder.ts:64` (direct call)
- **Verdict**: SearchManager is explicitly a thin facade. CorpusBuilder's direct call intentionally skips HTTP display wrapping. Note: SearchManager retains legacy `@deprecated` private methods (`queryChroma`, `searchChromaForTimeline`) that should be removed as cleanup.

### B8. Process Registry duplication — ACCIDENTAL
- **Locations**: `src/services/worker/ProcessRegistry.ts:1-528`, `src/supervisor/process-registry.ts:1-409`
- **Verdict**: Worker is a facade delegating to supervisor, but API surface overlap (registerProcess/unregisterProcess/getAll/getByPid) duplicates. Worker wrapper adds minimal value beyond supervisor's own API.

### B9. Dual reapers / timers — ACCIDENTAL
- **Locations**: `src/services/worker-service.ts:547` (staleSessionReaperInterval 2min), `src/services/worker-service.ts:537` (startOrphanReaper 30s), `src/services/worker/SessionManager.ts:516-568` (reapStaleSessions body), `src/supervisor/process-registry.ts:292` (reapSession)
- **Verdict**: Historical separation. `startUnifiedReaper` was planned but not implemented. Currently two independent timers with overlapping concerns.

### B10. Database opening / migration — LEGITIMATE
- **Locations**: `src/services/sqlite/Database.ts:155` + migrations + Python repair path
- **Verdict**: Single connection (WAL enforces single writer); repair path is a legitimate safety net. Properly layered.

### B11. HTTP response shaping / validation — ACCIDENTAL
- **Locations**: All 8 route files under `src/services/worker/http/routes/`
- **Verdict**: Each route validates query/body independently. No shared validator middleware. Schema changes require N edits.

### B12. Context injection vs corpus builder — LEGITIMATE
- **Locations**: `src/services/context/ContextBuilder.ts` vs `src/services/worker/knowledge/CorpusBuilder.ts:64`
- **Verdict**: Both correctly delegate to SearchOrchestrator. Output formatting requirements differ enough to justify two call sites.

---

## Priority-Ordered Consolidation Opportunities

| # | Concern | Severity | Effort | Value |
|---|---|---|---|---|
| **P1** | **Privacy tag stripping asymmetry (summary path gap)** | SECURITY | Low | Closes private-tag leak into summaries |
| **P2** | **Unified observation renderer** (ResultFormatter / AgentFormatter / CorpusRenderer) | Code quality | Medium | ~600 lines consolidated; consistent rendering |
| **P3** | **Unified reaper** (staleSessionReaperInterval + startOrphanReaper → single unified reaper) | Complexity | Medium | Simpler lifecycle; matches stated intent (T32 refactor) |
| **P4** | **ProcessRegistry consolidation** (drop worker-level facade) | Surface area | Low | Single source of truth for process tracking |
| **P5** | **XML parser deduplication** (canonical parser in import tool) | Drift risk | Trivial | One-line import change; prevents schema divergence |
| **P6** | **HTTP validator middleware** (centralize per-route validation boilerplate) | Maintenance | High | Low ROI today; watchlist |
| **P7** | **Drop SearchManager `@deprecated` legacy methods** | Cleanup | Trivial | Dead code removal |
| **P8** | **Transcript-watcher direct `queueObservation`** (skip observationHandler hop) | Minor | Low | Small simplification |

---

## What is NOT duplication (legitimate specialization)

- Dual capture paths (lifecycle-hooks + transcript-watcher) — intrinsic to source diversity.
- HTTP endpoint vs CLI handler for session init — loopback vs direct invocation.
- SearchOrchestrator + SearchManager + CorpusBuilder search calls — thin facade + direct-path optimization.
- ContextBuilder vs CorpusBuilder — genuinely different output requirements.
- Database connection + migrations + Python repair — single connection, layered safety.
