# Architecture Review — claude-mem v9.8.5

**Date:** 2026-03-01
**Scope:** Full architectural analysis, critique, and improvement suggestions
**Methodology:** 3 parallel architect agents examining service layer, data flow, and code quality metrics

---

## Executive Summary

claude-mem is a well-engineered **low-latency observer** that must never block Claude Code. The core constraint drives sound architectural decisions — fire-and-forget observations, persistent queue with claim-and-delete semantics, and clear async/sync boundaries. However, organic growth has produced god classes, duplicated logic, and uneven test coverage that threaten long-term maintainability.

| Metric | Value | Assessment |
|--------|-------|------------|
| Total source lines | 37,745 | Medium-sized codebase |
| Total test lines | 32,721 | Good investment |
| Test-to-source ratio | 0.86 | Healthy |
| Source files | 214 | Well-decomposed (mostly) |
| Files >800 lines | 5 | CRITICAL |
| `any` types | 2 | Excellent |
| `as` type casts | 619 | HIGH concern |
| Non-null assertions | 2 | Excellent |
| Empty catch blocks | 0 | Excellent |
| Potentially unused exports | 345 | Significant dead code |

---

## Architecture Analysis

### What Works Well

- **Near-zero `any` usage** (2 in 37,745 lines) — exceptional type discipline
- **Zero empty catch blocks** — all errors logged or handled
- **PendingMessageStore crash safety** — persist-before-notify, atomic claim-and-delete
- **Generator mutex** via `generatorPromise` prevents duplicate SDK agents
- **Worker version auto-restart** on mismatch
- **Fire-and-forget observation pattern** keeps PostToolUse <100ms
- **Clean domain organization** in newer code (search strategies, context sections, sqlite sub-modules)
- **Async/sync boundary clarity** — each layer has a clear synchronous or asynchronous contract
- **Privacy tag processing** — edge stripping at hook layer, privacy validation at worker layer

### Data Flow Architecture

```
Claude Code ──► Hooks (5 phases)
                  │
        ┌─────────┼──────────┐
        │         │          │
    context    observation  summarize
    (await)    (fire&forget) (await)
        │         │          │
        ▼         ▼          ▼
   ┌──────────────────────────────────┐
   │     Express Worker (:37777)      │
   │                                  │
   │  8 Route Modules                 │
   │       │                          │
   │  SessionManager                  │
   │       │                          │
   │  PendingMessageStore (SQLite)    │
   │       │                          │
   │  SessionQueueProcessor           │
   │       │                          │
   │  ┌────┴────┬────────┐           │
   │  SDK    Gemini   OpenAI          │
   │  Agent  Agent    Agent           │
   │  └────┬────┴────────┘           │
   │       │                          │
   │  ResponseProcessor               │
   │       │                          │
   │  SessionStore ──► ChromaSync     │
   │       │                          │
   │  SSEBroadcaster ──► Viewer UI    │
   └──────────────────────────────────┘
```

### Observation Pipeline (7 Reshaping Points)

1. **Claude Code stdin** — raw JSON with snake_case fields
2. **claudeCodeAdapter.normalizeInput()** — camelCase NormalizedHookInput
3. **observationHandler** — back to snake_case for HTTP body
4. **SessionRoutes handler** — stripMemoryTagsFromJson on tool_input/tool_response
5. **SessionManager.queueObservation** — wraps in PendingMessage envelope
6. **SDKAgent.createMessageGenerator** — buildObservationPrompt (text for SDK)
7. **processAgentResponse/parseObservations** — XML regex extraction into ParsedObservation

---

## Critique

### Tier 1: Structural Debt (God Classes)

| File | Lines | Problem |
|------|-------|---------|
| `SessionStore.ts` | **2,443** | 58 methods — accumulates ALL DB operations. 88 type casts. |
| `SearchManager.ts` | **1,856** | 5 functions >100 lines, 111 type casts. Predates and duplicates `SearchOrchestrator`. |
| `worker-service.ts` | **819** | Composition root + business logic. 33 imports, 169-line `main()`. |
| `ChromaSync.ts` | **1,025** | Vector sync + backfill + embedding in one file. |

`SessionStore` and `SearchManager` are the two most impactful. The irony is that the decomposition patterns already exist (`src/services/sqlite/sessions/`, `src/services/worker/search/`) — these god classes simply predate them.

### Tier 2: Data Pipeline Concerns

- **7 data reshaping points** in the observation pipeline. The camelCase→snake_case→camelCase round-trip in hooks is unnecessary overhead.
- **Dual route registration** — legacy `/sessions/:sessionDbId/*` and new `/api/sessions/*` with subtly different security checks (privacy, tag stripping). The legacy endpoints skip these guards.
- **Context injection opens its own DB connection** (`ContextBuilder.ts`) instead of using the worker's `DatabaseManager` — bypasses connection lifecycle, risks stale reads.
- **XML regex parser** tightly coupled to observation schema — adding a new field requires migration + parser + prompt update (3 coupled changes).

### Tier 3: Testing & Type Safety

- **619 `as` type casts** across 108 files — most from untyped SQLite query results. A typed query wrapper would eliminate ~40%.
- **Agent code duplication** — `SDKAgent` (506), `GeminiAgent` (573), `OpenAICompatAgent` (549) all have ~200-line `startSession` methods with shared logic.
- **Test distribution is uneven** — 0.86 test-to-source ratio overall, but the largest/most critical files have no direct unit tests.
- **99 `console.log`** calls alongside a structured logger.

### Tier 4: UI Complexity

- `ContextSettingsModal` (426-line function), `App` (306 lines), `LogsDrawer` (194 lines) exceed the <50 line function guideline by 4-8x.
- 1 circular import: `LogLine.tsx` ↔ `LogsModal.tsx`.
- 345 potentially unused exports (dead code signal).

### Service Layer Analysis

**Dependency Graph Issues:**
- `WorkerService` has circular dependency with consumers (needs narrow interface extraction)
- `ModeManager` is a global singleton with hidden coupling in 15+ call sites
- `SessionRoutes` over-injected (7 constructor parameters)
- `DataRoutes` has layer violations (reaching into DB directly)
- `DatabaseManager` naming collision with `sqlite/Database.ts`

**Error Handling:**
- Well-handled at route level via `BaseRouteHandler.wrapHandler()`
- One silent swallow: observation handler HTTP errors resolve successfully (by design — fire-and-forget)
- Background init failure in `worker-service.ts` causes `/api/context/inject` to hang until 5-minute timeout

---

## Suggestions (Prioritized)

### P0 — High Impact, Clear Path

**1. Decompose `SessionStore.ts`**
The sub-module pattern already exists at `src/services/sqlite/{sessions,observations,summaries}/`. Move the remaining 58 methods into domain-specific repositories. `SessionStore` becomes a thin facade delegating to focused modules.

**2. Retire `SearchManager.ts`**
`SearchOrchestrator` + strategies already implement the correct architecture. Migrate `SearchManager`'s timeline, context, and file-search methods into focused services (`TimelineService`, `ContextSearchService`, `FileSearchService`) that use the orchestrator internally. Eliminates the 1,856-line monolith and its 111 type casts.

**3. Consolidate dual route registration**
The hooks exclusively use `/api/sessions/*`. Make the legacy `/sessions/:sessionDbId/*` endpoints thin wrappers that delegate to the `ByClaudeId` handlers (inheriting privacy checks and tag stripping). Closes the security inconsistency.

### P1 — Important, Moderate Effort

**4. Extract agent base class**
`SDKAgent`, `GeminiAgent`, `OpenAICompatAgent` share significant logic in `startSession()`. Extract a `BaseAgent` or use composition to share queue processing, response handling, and retry logic. Reduces ~600 lines of duplication.

**5. Typed SQLite query wrapper**
A thin generic `query<T>(sql, params): T[]` wrapper with runtime validation would eliminate ~250 of the 619 `as` casts. Focus on `SessionStore` (88 casts) and `SearchManager` (111 casts) first.

**6. Route context injection through `DatabaseManager`**
`ContextBuilder` should use the worker's DB connection instead of opening its own. Eliminates stale-read risk and connection overhead.

### P2 — Quality of Life

**7. Reduce data reshaping** — bypass adapter layer for observation path, pass raw input to worker endpoint.

**8. Add direct unit tests for critical paths** — `SessionStore`, agent classes, `ChromaSync`.

**9. Migrate `console.log` → logger** — 99 calls to standardize.

**10. Decompose oversized React components** — `ContextSettingsModal` and `App` need sub-component extraction.

### P3 — When Convenient

**11. Dead code audit** — 345 potentially unused exports. Run `knip` or `ts-prune`.

**12. Extract `worker-service.ts` business logic** — 169-line `main()` to smaller orchestration functions.

---

## Detailed Metrics

### Largest Files (>400 lines)

| File | Lines |
|------|-------|
| `src/services/sqlite/SessionStore.ts` | 2,443 |
| `src/services/worker/SearchManager.ts` | 1,856 |
| `src/services/sync/ChromaSync.ts` | 1,025 |
| `src/services/sqlite/migrations/runner.ts` | 824 |
| `src/services/worker-service.ts` | 819 |
| `src/services/worker/http/routes/DataRoutes.ts` | 684 |
| `src/services/worker/http/routes/SessionRoutes.ts` | 676 |
| `src/services/integrations/CursorHooksInstaller.ts` | 675 |
| `src/ui/viewer/components/ContextSettingsModal.tsx` | 641 |
| `src/services/sqlite/SessionSearch.ts` | 587 |
| `src/services/worker/GeminiAgent.ts` | 573 |
| `src/services/worker/OpenAICompatAgent.ts` | 549 |
| `src/services/sqlite/migrations.ts` | 512 |
| `src/services/worker/SDKAgent.ts` | 506 |

### Longest Functions (>100 lines)

| File | Function | Lines |
|------|----------|-------|
| `ContextSettingsModal.tsx` | `ContextSettingsModal` | 426 |
| `App.tsx` | `App` | 306 |
| `SearchManager.ts` | `timeline` | 276 |
| `SDKAgent.ts` | `startSession` | 266 |
| `SearchManager.ts` | `getTimelineByQuery` | 230 |
| `SearchManager.ts` | `getContextTimeline` | 211 |
| `OpenAICompatAgent.ts` | `startSession` | 197 |
| `GeminiAgent.ts` | `startSession` | 197 |
| `LogsModal.tsx` | `LogsDrawer` | 194 |
| `import-xml-observations.ts` | `main` | 180 |
| `worker-service.ts` | `main` | 169 |

### Type Cast Hotspots

| File | Casts | Lines | Density |
|------|-------|-------|---------|
| `SearchManager.ts` | 111 | 1,856 | 5.9% |
| `SessionStore.ts` | 88 | 2,443 | 3.6% |
| `migrations/runner.ts` | 33 | 824 | 4.0% |
| `ResultFormatter.ts` | 14 | 299 | 4.6% |
| `TimelineService.ts` | 13 | 262 | 4.9% |

---

## Data Flow Risk Assessment

| Finding | Severity | Category | Status |
|---------|----------|----------|--------|
| 7 data reshaping points | MEDIUM | Performance/Maintainability | Architectural debt |
| Fire-and-forget 100ms cap | LOW | Data Consistency | By design, mitigated |
| Dual route registration | MEDIUM | Security/Maintenance | Active debt |
| Background init failure hangs context | LOW | Error Propagation | Edge case |
| Context injection opens own DB | MEDIUM | Resource Management | Architectural debt |
| Observation schema coupling to XML parser | MEDIUM | Schema Evolution | Structural risk |
| ActiveSession type proliferation | LOW | Maintainability | Naming confusion |
| PendingMessageStore crash safety | POSITIVE | Data Consistency | Well-designed |
| Generator mutex via generatorPromise | POSITIVE | Concurrency | Well-designed |
| Worker version auto-restart | POSITIVE | Operations | Well-designed |
| Async/sync boundary clarity | POSITIVE | Architecture | Well-designed |
