# Implementation Roadmap — claude-mem v10.x

**Date:** 2026-03-01
**Inputs:** [Architecture Review v9.8](./architecture-review-v9.8.md), [Mastra OM Comparison](./mastra-comparison-v9.8.md)
**Philosophy:** Interleave quick-win features with foundational refactoring. Deliver user-visible value early while reducing debt that makes future work harder.

---

## Guiding Principles

1. **Features unlock motivation for refactoring** — shipping priority tagging and working memory creates immediate value, making the subsequent refactoring feel purposeful rather than academic.
2. **Refactoring enables features** — SessionStore decomposition and typed queries make new schema additions (priority, referenced_at, supersedes_id) cleaner to implement.
3. **Test before refactor** — add direct unit tests for god classes *before* decomposing them. Tests are the safety net that makes refactoring safe.
4. **One god class at a time** — never decompose SessionStore and SearchManager simultaneously. Each is a multi-session effort.

---

## Phase Overview

| Phase | Theme | Effort | Key Deliverables |
|-------|-------|--------|------------------|
| **1** | Quick Wins | 1-2 sessions | Priority tagging, dual route consolidation, security fix |
| **2** | Working Memory | 2-3 sessions | Per-project scratchpad, prompt cache alignment, viewer panel |
| **3** | Foundation — SessionStore | 3-4 sessions | Decompose 2,443-line god class, typed query wrapper |
| **4** | Search Modernization | 3-4 sessions | Retire SearchManager, migrate to SearchOrchestrator |
| **5** | Agent Consolidation | 2-3 sessions | Extract BaseAgent, reduce 600 lines of duplication |
| **6** | Temporal Intelligence | 1-2 sessions | Referenced dates, state change tracking (supersedes) |
| **7** | Polish | 2-3 sessions | Dead code, console.log, React components, data reshaping |

**Estimated total:** 14-21 sessions across multiple weeks/months. Phases are independent after Phase 1 — order can be adjusted based on priorities.

---

## Phase 1: Quick Wins

**Goal:** Deliver two high-impact improvements with minimal risk.

### 1.1 Priority Tagging for Observations
**Source:** Mastra comparison §4.1 | **Effort:** Low | **Impact:** High

Add a `priority` field to observations, enabling smarter context injection and viewer filtering.

**Steps:**
1. DB migration: add `priority TEXT DEFAULT 'informational'` to observations table
2. Update SDK compression prompt to emit `<priority>critical|important|informational</priority>`
3. Update XML parser (`src/sdk/parser.ts`) to extract priority field
4. Update `storeObservations()` to persist priority
5. Update context injection to sort by priority within time windows (critical first)
6. Update viewer observation cards to show priority badge
7. Update viewer filter panel with priority filter
8. Add FTS5 column for priority (optional, for search weighting)

**Acceptance criteria:**
- Observations have priority levels visible in viewer
- Context injection prefers critical > important > informational when budget is constrained
- Backward compatible — existing observations default to 'informational'

### 1.2 Consolidate Dual Route Registration
**Source:** Architecture review §P0.3 | **Effort:** Low | **Impact:** Medium (closes security gap)

Legacy `/sessions/:sessionDbId/*` endpoints skip privacy checks and tag stripping that the `/api/sessions/*` endpoints perform.

**Steps:**
1. Identify all callers of legacy endpoints (should be only `session-init` handler)
2. Make legacy handlers delegate to `ByClaudeId` handlers (inheriting security checks)
3. Add integration tests verifying privacy checks apply to both endpoint paths
4. Deprecation log on legacy endpoint usage

**Acceptance criteria:**
- All session endpoints apply consistent privacy and tag-stripping checks
- No behavioral change for existing callers
- Tests prove security parity

---

## Phase 2: Working Memory

**Goal:** Add a persistent per-project scratchpad that also enables cross-session prompt caching.

**Source:** Mastra comparison §4.4 + Appendix A | **Effort:** Medium | **Impact:** High (UX + cost)

### 2.1 Database Layer

**Steps:**
1. DB migration: create `working_memory` table
   ```sql
   CREATE TABLE working_memory (
     id INTEGER PRIMARY KEY,
     project TEXT NOT NULL,
     key TEXT NOT NULL,
     value TEXT NOT NULL,
     updated_at_epoch INTEGER NOT NULL,
     updated_by TEXT DEFAULT 'agent',  -- 'agent' | 'user' | 'auto'
     UNIQUE(project, key)
   );
   ```
2. CRUD functions in `src/services/sqlite/working-memory/`
3. Expose via `SessionStore` facade (or new `WorkingMemoryStore`)

### 2.2 API Endpoints

**Steps:**
1. New `WorkingMemoryRoutes` class extending `BaseRouteHandler`
2. Endpoints:
   - `GET /api/working-memory/:project` — get all entries for project
   - `PUT /api/working-memory/:project` — upsert entries (batch)
   - `DELETE /api/working-memory/:project/:key` — delete single entry
3. Wire into `worker-service.ts`

### 2.3 Context Injection (Prompt Cache Alignment)

**Steps:**
1. Modify context injection to output in two tiers:
   ```
   ## Project Context (Working Memory)
   [stable per-project facts — tech stack, decisions, conventions]

   ## Recent Session Context
   [dynamic observations from search — changes per session]
   ```
2. Working memory block injected FIRST (stable prefix for cache hits)
3. Dynamic observations injected AFTER (cache miss only on this portion)
4. Respect token budget: working memory gets guaranteed allocation, observations fill remainder

### 2.4 Auto-Population from Observations

**Steps:**
1. When SDK generates observations with certain patterns (tech stack mentions, architecture decisions, recurring conventions), suggest working memory entries
2. Summary generation can extract stable facts into working memory candidates
3. Viewer shows "Promote to Working Memory" action on observations

### 2.5 Viewer Panel

**Steps:**
1. New "Working Memory" tab/panel in project view
2. Editable key-value cards with inline editing
3. History of changes (updated_at, updated_by)
4. Import/export as JSON

**Acceptance criteria:**
- Working memory persists across sessions for the same project
- Context injection places working memory as stable prefix
- Viewer allows manual CRUD of working memory entries
- Cross-session prompt cache hits verified via Anthropic usage metrics (if observable)

---

## Phase 3: Foundation — SessionStore Decomposition

**Goal:** Break the 2,443-line god class into focused domain modules.

**Source:** Architecture review §P0.1, §P1.5 | **Effort:** High | **Impact:** High (maintainability)

### 3.1 Add Tests Before Decomposing

**Steps:**
1. Write direct unit tests for `SessionStore`'s most critical methods
2. Focus on: `storeObservations()`, `getSummaryForSession()`, `closeActiveSessionById()`, `getSessionById()`
3. Target: 80%+ coverage of SessionStore's public API before any refactoring

### 3.2 Typed SQLite Query Wrapper

**Steps:**
1. Create `src/services/sqlite/typed-query.ts`:
   ```typescript
   function queryOne<T>(db: Database, sql: string, params: unknown[]): T | null
   function queryAll<T>(db: Database, sql: string, params: unknown[]): T[]
   function execute(db: Database, sql: string, params: unknown[]): RunResult
   ```
2. Add Zod runtime validation option for critical queries
3. Migrate `SessionStore` queries first (eliminates 88 `as` casts)
4. Then migrate `SearchManager` queries (eliminates 111 casts)

### 3.3 Decompose SessionStore

The sub-module pattern already exists. Move methods to their domain homes:

| Target Module | Methods to Move | Current Location |
|---------------|----------------|------------------|
| `src/services/sqlite/sessions/` | Session CRUD, status management, stale detection | SessionStore lines 100-400 |
| `src/services/sqlite/observations/` | Observation storage, retrieval, search | SessionStore lines 400-800 |
| `src/services/sqlite/summaries/` | Summary CRUD, queue management | SessionStore lines 800-1100 |
| `src/services/sqlite/prompts/` | User prompt storage, retrieval | SessionStore lines 1100-1300 |
| `src/services/sqlite/analytics/` | Stats, token analytics, injection tracking | SessionStore lines 1300-1600 |
| `src/services/sqlite/queue/` | Pending message operations | SessionStore lines 1600-1800 |

**Steps:**
1. Move methods one domain at a time (sessions first, then observations, etc.)
2. SessionStore becomes a thin facade importing from sub-modules
3. Update all callers (routes, services) to use facade or direct imports
4. Run full test suite after each domain migration
5. Final: SessionStore < 200 lines (pure delegation)

**Acceptance criteria:**
- SessionStore < 200 lines
- All existing tests pass
- No behavioral changes
- Each sub-module has its own test file

---

## Phase 4: Search Modernization

**Goal:** Retire the 1,856-line SearchManager monolith.

**Source:** Architecture review §P0.2, §P1.6 | **Effort:** High | **Impact:** High

### 4.1 Map SearchManager's Remaining Responsibilities

SearchOrchestrator + strategies handle the core search flow. SearchManager still owns:
- Timeline construction (`timeline`, `getTimelineByQuery`, `getContextTimeline`)
- Context retrieval (`getRecentContext`, `getContextTimeline`)
- Specialized queries (`findByFile`, `findByConcept`, `findByType`)
- Results formatting and pagination

### 4.2 Create Focused Services

| New Service | Methods | Lines (est.) |
|-------------|---------|-------------|
| `TimelineService` | `timeline`, `getTimelineByQuery`, `getContextTimeline` | ~300 |
| `ContextSearchService` | `getRecentContext`, `getContextPreview` | ~200 |
| `SpecializedSearchService` | `findByFile`, `findByConcept`, `findByType` | ~250 |

**Steps:**
1. Create each service with SearchOrchestrator as a dependency
2. Migrate methods one service at a time
3. Update SearchRoutes to use new services instead of SearchManager
4. Add tests for each new service
5. Delete SearchManager.ts

### 4.3 Route Context Injection Through DatabaseManager

**Steps:**
1. Modify `ContextBuilder` to accept a `SessionStore` instance instead of opening its own DB
2. Update `SearchRoutes.handleContextInject` to pass the worker's store
3. Remove `initializeDatabase()` / `db.close()` from ContextBuilder
4. Verify no stale-read issues in integration tests

**Acceptance criteria:**
- SearchManager.ts deleted
- All search functionality works through SearchOrchestrator + focused services
- ContextBuilder uses worker's DB connection
- All tests pass, no behavioral changes

---

## Phase 5: Agent Consolidation

**Goal:** Extract shared logic from the three agent implementations.

**Source:** Architecture review §P1.4 | **Effort:** Medium | **Impact:** Medium

### 5.1 Extract BaseAgent

**Steps:**
1. Identify shared logic across `SDKAgent`, `GeminiAgent`, `OpenAICompatAgent`:
   - Queue processing (iterator creation, message claiming)
   - Response handling (parseObservations, parseSummary, storeObservations)
   - Error handling and retry logic
   - Session lifecycle (start, stop, abort)
2. Create `BaseAgent` abstract class or composition helpers
3. Each agent keeps only provider-specific logic (API calls, message formatting)
4. Target: each agent file < 200 lines (down from 500-573)

**Acceptance criteria:**
- ~600 lines of duplicated code eliminated
- Each agent file < 250 lines
- All provider-specific behavior preserved
- Tests cover base class and each provider

---

## Phase 6: Temporal Intelligence

**Goal:** Add temporal anchoring and state change tracking from Mastra insights.

**Source:** Mastra comparison §4.2, §4.3 | **Effort:** Low-Medium | **Impact:** Medium

### 6.1 Temporal Anchoring (Referenced Dates)

**Steps:**
1. DB migration: add `referenced_at_epoch INTEGER` to observations
2. Update SDK prompt: "If the observation references a future or past date, extract it"
3. Update XML parser to extract `<referenced_date>`
4. Update timeline queries to optionally sort/filter by referenced date
5. Viewer: show "References: March 15th" badge on observations

### 6.2 State Change Tracking (Supersedes)

**Steps:**
1. DB migration: add `supersedes_id INTEGER REFERENCES observations(id)` to observations
2. Update SDK prompt: "If this observation contradicts or updates a previous decision, note what it replaces"
3. Update XML parser to extract `<supersedes>` with observation title/narrative hint
4. Matching logic: find existing observation by title/narrative similarity and link
5. Context injection: skip superseded observations
6. Viewer: show supersede chain ("This replaced: [old observation]")

**Acceptance criteria:**
- Observations can reference future/past dates
- State changes create explicit supersedes links
- Context injection automatically prefers latest decisions
- Viewer shows temporal and supersedes relationships

---

## Phase 7: Polish

**Goal:** Address remaining quality concerns.

**Source:** Architecture review §P2, §P3 | **Effort:** Medium | **Impact:** Low-Medium

### 7.1 Dead Code Audit
- Run `knip` or `ts-prune` to identify 345 potentially unused exports
- Remove confirmed dead code
- Estimated reduction: ~500-1,000 lines

### 7.2 Console.log Migration
- Migrate 99 `console.log` calls to structured logger
- Add lint rule to prevent new `console.log` in src/

### 7.3 React Component Decomposition
- `ContextSettingsModal` (426 lines) → extract sub-components
- `App` (306 lines) → extract layout, routing, provider components
- `LogsDrawer` (194 lines) → already partially decomposed, finish it
- Fix circular import: `LogLine.tsx` ↔ `LogsModal.tsx`

### 7.4 Data Reshaping Reduction
- Observation handler: bypass adapter layer, pass raw Claude Code JSON to worker
- Eliminates the camelCase→snake_case→camelCase round-trip (reshaping points 2-3 of 7)

### 7.5 Worker Service Cleanup
- Extract 169-line `main()` into focused initialization functions
- Reduce 33 imports via dependency injection container or builder pattern

---

## Dependency Graph

```
Phase 1 (Quick Wins)
  ├── 1.1 Priority Tagging ──────────────────────┐
  └── 1.2 Dual Route Consolidation               │
                                                  │
Phase 2 (Working Memory) ◄── depends on nothing  │
  ├── 2.1 DB Layer                                │
  ├── 2.2 API Endpoints                           │
  ├── 2.3 Context Injection (cache alignment)     │
  ├── 2.4 Auto-Population ◄── benefits from 1.1 ─┘
  └── 2.5 Viewer Panel

Phase 3 (SessionStore) ◄── depends on nothing
  ├── 3.1 Add Tests First
  ├── 3.2 Typed Query Wrapper
  └── 3.3 Decompose ◄── depends on 3.1 + 3.2

Phase 4 (Search) ◄── benefits from Phase 3
  ├── 4.1 Map Responsibilities
  ├── 4.2 Create Focused Services
  └── 4.3 ContextBuilder DB Fix

Phase 5 (Agents) ◄── independent
  └── 5.1 Extract BaseAgent

Phase 6 (Temporal) ◄── benefits from Phase 1.1 + Phase 3
  ├── 6.1 Referenced Dates
  └── 6.2 Supersedes Tracking

Phase 7 (Polish) ◄── independent, do anytime
  ├── 7.1 Dead Code
  ├── 7.2 Console.log
  ├── 7.3 React Components
  ├── 7.4 Data Reshaping
  └── 7.5 Worker Service
```

**Phases 1 and 2 are independent** — can run in any order or parallel.
**Phase 3 before 4** — SessionStore decomposition makes SearchManager retirement cleaner.
**Phase 5 is independent** — can run anytime.
**Phase 6 benefits from 1 + 3** — priority tagging and clean schema make temporal features easier.
**Phase 7 items are independent** — pick up opportunistically.

---

## Recommended Execution Order

1. **Phase 1** → ship quick wins, build momentum
2. **Phase 2** → working memory is the highest-value new feature (UX + cost)
3. **Phase 3** → foundational refactoring while the codebase is fresh in mind
4. **Phase 6** → temporal features are low effort and leverage Phase 1 + 3
5. **Phase 4** → search modernization (biggest refactoring effort)
6. **Phase 5** → agent consolidation (moderate, independent)
7. **Phase 7** → polish items, ongoing

---

## Success Metrics

| Metric | Current (v9.8) | Target (v10.x) |
|--------|---------------|-----------------|
| SessionStore.ts lines | 2,443 | < 200 (facade) |
| SearchManager.ts lines | 1,856 | 0 (deleted) |
| `as` type casts | 619 | < 300 |
| Files > 800 lines | 5 | 0 |
| Functions > 100 lines | 12 | < 5 |
| `console.log` in src | 99 | 0 |
| Observation priority levels | none | 3 (critical/important/informational) |
| Working memory | none | per-project key-value store |
| Cross-session cache hits | none | stable prefix via working memory |
| Context injection cost (20-turn session) | 60K tokens full price | 9.5K effective tokens (84% within-session + cross-session) |
| Potentially unused exports | 345 | < 50 |
