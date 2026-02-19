# Implementation Plan: Token Analytics Dashboard

## Overview

Add a permanent analytics bar to the viewer UI showing token usage statistics (Read Cost, Work Investment, Savings, Observations/Sessions). The bar is scoped by the current project filter and includes a time range selector (7d, 30d, 90d, All). This requires two database migrations, a new API endpoint, injection tracking instrumentation, and a new React component with its own data hook.

## Requirements

- Add `read_tokens` column to `observations` table (computed at creation, backfilled for historical data)
- Create `context_injections` table to track actual observation consumption
- New `/api/analytics` endpoint with `?project=` and `?days=` filters
- Instrument context injection in SessionStart hook, UserPromptSubmit hook, and MCP search tools
- Permanent analytics bar in viewer with 4 stat cards and time range selector
- Respects current project filter from `useFilters()` hook

## Delivery Strategy

current-branch (`feature/viewer-redesign`) — this is viewer-related work fitting the existing branch.

## Architecture Changes

| Change | File(s) | Type |
|--------|---------|------|
| Migration 21: `read_tokens` column + backfill | `src/services/sqlite/migrations/runner.ts` | modify |
| Migration 22: `context_injections` table | `src/services/sqlite/migrations/runner.ts` | modify |
| `ObservationRecord` type update | `src/types/database.ts` | modify |
| `read_tokens` computation at observation storage | `src/services/sqlite/SessionStore.ts` | modify |
| `estimateReadTokens()` shared utility | `src/shared/timeline-formatting.ts` | modify |
| Context injection tracking service | `src/services/sqlite/InjectionTracker.ts` | **create** |
| Injection tracking in context handler | `src/cli/handlers/context.ts` | modify |
| Injection tracking in MCP search results | `src/servers/mcp-server.ts` | modify |
| Analytics API endpoint | `src/services/worker/http/routes/DataRoutes.ts` | modify |
| Analytics types (shared) | `src/ui/viewer/types.ts` | modify |
| `useAnalytics` hook | `src/ui/viewer/hooks/useAnalytics.ts` | **create** |
| `AnalyticsBar` component | `src/ui/viewer/components/AnalyticsBar.tsx` | **create** |
| API constants | `src/ui/viewer/constants/api.ts` | modify |
| App integration | `src/ui/viewer/App.tsx` | modify |
| Header integration (pass project) | `src/ui/viewer/components/Header.tsx` | modify (optional) |
| CSS styles | `src/ui/viewer-template.html` | modify |

## Implementation Steps

### Phase 1: Database Schema — `read_tokens` Column (Migration 21)

**Goal**: Add `read_tokens` column to observations, compute for new rows, backfill historical.

#### 1.1 Add `estimateReadTokens()` utility
**File**: `/home/doublefx/projects/claude-mem/src/shared/timeline-formatting.ts`
- Action: Add `estimateReadTokens(obs: { narrative?: string | null; title?: string | null; facts?: string | null; concepts?: string | null; text?: string | null }): number` function
- Logic: Sum `estimateTokens()` across narrative + title + facts + concepts + text (for legacy rows)
- Why: Centralized computation shared by migration backfill, storage, and API
- Dependencies: None
- Risk: Low

#### 1.2 Add migration `ensureReadTokensColumn()` (version 21)
**File**: `/home/doublefx/projects/claude-mem/src/services/sqlite/migrations/runner.ts`
- Action: Add private method `ensureReadTokensColumn()` and call it from `runAllMigrations()`
- Steps:
  1. Check if migration 21 applied, return if so
  2. Check if `read_tokens` column exists on `observations` via PRAGMA
  3. `ALTER TABLE observations ADD COLUMN read_tokens INTEGER DEFAULT 0`
  4. Backfill: `UPDATE observations SET read_tokens = CEIL((COALESCE(LENGTH(narrative),0) + COALESCE(LENGTH(title),0) + COALESCE(LENGTH(facts),0) + COALESCE(LENGTH(concepts),0) + COALESCE(LENGTH(text),0)) / 4.0)` (pure SQL, no need for JS function)
  5. Record migration version 21
- Pattern: Follows `ensureDiscoveryTokensColumn()` exactly
- Dependencies: None
- Risk: Low — additive, existing data unaffected

#### 1.3 Update `ObservationRecord` type
**File**: `/home/doublefx/projects/claude-mem/src/types/database.ts`
- Action: Add `read_tokens: number;` to `ObservationRecord` interface
- Dependencies: 1.2
- Risk: Low

#### 1.4 Compute `read_tokens` at storage time
**File**: `/home/doublefx/projects/claude-mem/src/services/sqlite/SessionStore.ts`
- Action: In `storeObservations()`, compute `read_tokens` for each observation using `estimateReadTokens()` from timeline-formatting
- Modify the INSERT statement to include `read_tokens` column
- Dependencies: 1.1, 1.2
- Risk: Low

**Tests for Phase 1:**
- `tests/services/sqlite/migrations/read-tokens-migration.test.ts` — verify column exists after migration, backfill populates non-zero values
- `tests/shared/timeline-formatting.test.ts` — unit test `estimateReadTokens()`
- `tests/services/sqlite/SessionStore.test.ts` — verify `read_tokens` populated on new observations

---

### Phase 2: Database Schema — `context_injections` Table (Migration 22)

**Goal**: Create table to track every time observations are served to a session.

#### 2.1 Add migration `createContextInjectionsTable()` (version 22)
**File**: `/home/doublefx/projects/claude-mem/src/services/sqlite/migrations/runner.ts`
- Action: Add private method, call from `runAllMigrations()`
- Table schema:
  ```sql
  CREATE TABLE context_injections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT,
    project TEXT NOT NULL,
    observation_ids TEXT NOT NULL,       -- JSON array of integer IDs
    total_read_tokens INTEGER NOT NULL,
    injection_source TEXT NOT NULL CHECK(injection_source IN ('session_start', 'prompt_submit', 'mcp_search')),
    created_at TEXT NOT NULL,
    created_at_epoch INTEGER NOT NULL
  );
  CREATE INDEX idx_context_injections_project ON context_injections(project);
  CREATE INDEX idx_context_injections_created ON context_injections(created_at_epoch DESC);
  CREATE INDEX idx_context_injections_source ON context_injections(injection_source);
  ```
- Pattern: Follows `createPendingMessagesTable()` (migration 16)
- Dependencies: None
- Risk: Low — new table, no existing data affected

#### 2.2 Create `InjectionTracker` service
**File**: `/home/doublefx/projects/claude-mem/src/services/sqlite/InjectionTracker.ts` (NEW)
- Action: Create class with method:
  ```typescript
  class InjectionTracker {
    constructor(private db: Database) {}
    
    trackInjection(params: {
      sessionId?: string;
      project: string;
      observationIds: number[];
      totalReadTokens: number;
      injectionSource: 'session_start' | 'prompt_submit' | 'mcp_search';
    }): void
  }
  ```
- Uses parameterized INSERT
- Dependencies: 2.1
- Risk: Low

**Tests for Phase 2:**
- `tests/services/sqlite/migrations/context-injections-migration.test.ts` — verify table created
- `tests/services/sqlite/InjectionTracker.test.ts` — unit test trackInjection insert + query

---

### Phase 3: Injection Tracking Instrumentation

**Goal**: Log context_injections every time observations are served.

There are 3 injection points:
1. **SessionStart** — context handler calls `/api/context/inject`
2. **MCP search** — `get_observations` tool serves full observation details
3. **MCP search** — `search` tool returns observation index (lighter, but still a read)

#### 3.1 Add injection tracking to `/api/context/inject`
**File**: `/home/doublefx/projects/claude-mem/src/services/worker/http/routes/SearchRoutes.ts`
- Action: In `handleContextInject`, after `generateContext()` returns, extract observation IDs and read_tokens from the context builder output, then call `InjectionTracker.trackInjection()` with source `'session_start'`
- Challenge: `generateContext()` currently returns a string. We need it to also return metadata about which observations were included.
- **Alternative approach (simpler)**: Add a method to ContextBuilder that returns observation metadata separately, or modify `generateContext()` to accept a callback/return metadata.
- **Simplest approach**: Query the observations used in context injection at the API layer. The `ObservationCompiler.queryObservations()` is already called internally — we can expose the IDs.
- Dependencies: 2.2, understanding of ContextBuilder
- Risk: Medium — requires modifying context generation pipeline

**Revised approach for 3.1**: Instead of modifying the context pipeline, add tracking at the `/api/context/inject` endpoint by:
1. Parse the `projects` parameter
2. Query observation IDs + read_tokens that would be included (same query as ContextBuilder uses)
3. Insert into `context_injections` table
4. This is approximate but avoids coupling to the render pipeline

#### 3.2 Add injection tracking to MCP `get_observations`
**File**: `/home/doublefx/projects/claude-mem/src/servers/mcp-server.ts` (or the DataRoutes POST handler)
- Action: In the `get_observations` MCP tool handler (which calls `/api/observations/batch`), after the worker returns results, log the injection
- Better location: Add tracking in `DataRoutes.handleGetObservationsByIds()` since all MCP get_observations calls go through it
- **File**: `/home/doublefx/projects/claude-mem/src/services/worker/http/routes/DataRoutes.ts`
- Action: After fetching observations, call `InjectionTracker.trackInjection()` with source `'mcp_search'`
- Dependencies: 2.2
- Risk: Low

#### 3.3 Add injection tracking to MCP `search` results
**File**: `/home/doublefx/projects/claude-mem/src/services/worker/SearchManager.ts`
- Action: After search returns observation results, log injection with source `'mcp_search'`
- Note: Search results contain observation IDs + enough metadata to estimate read tokens from the index
- Dependencies: 2.2
- Risk: Low

**Simplification note**: For Phase 3 we can start with only 3.1 (session_start) and 3.2 (get_observations batch) as these are the highest-impact tracking points. 3.3 (search index) can be deferred since search results are lightweight summaries, not full observation reads.

**Tests for Phase 3:**
- `tests/services/worker/http/routes/DataRoutes.test.ts` — verify injection tracked on batch fetch
- `tests/services/worker/http/routes/SearchRoutes.test.ts` — verify injection tracked on context inject

---

### Phase 4: Analytics API Endpoint

**Goal**: Expose `/api/analytics` returning aggregated token stats.

#### 4.1 Add `handleGetAnalytics` to DataRoutes
**File**: `/home/doublefx/projects/claude-mem/src/services/worker/http/routes/DataRoutes.ts`
- Action: Add `GET /api/analytics?project=&days=` endpoint
- Query logic (single SQL per stat, all use parameterized queries):
  ```sql
  -- Work Investment (AI cost to produce memories)
  SELECT COALESCE(SUM(discovery_tokens), 0) as work_tokens
  FROM observations
  WHERE created_at_epoch >= ? [AND project = ?]

  SELECT COALESCE(SUM(discovery_tokens), 0) as summary_work_tokens
  FROM session_summaries
  WHERE created_at_epoch >= ? [AND project = ?]

  -- Read Cost (token size of stored observations)
  SELECT COALESCE(SUM(read_tokens), 0) as read_tokens
  FROM observations
  WHERE created_at_epoch >= ? [AND project = ?]

  -- Reuse / Savings (actual consumption from context_injections)
  SELECT COALESCE(SUM(total_read_tokens), 0) as total_served_tokens
  FROM context_injections
  WHERE created_at_epoch >= ? [AND project = ?]

  -- Counts
  SELECT COUNT(*) as observation_count FROM observations
  WHERE created_at_epoch >= ? [AND project = ?]

  SELECT COUNT(DISTINCT memory_session_id) as session_count FROM observations
  WHERE created_at_epoch >= ? [AND project = ?]
  ```
- Response shape:
  ```typescript
  interface AnalyticsResponse {
    workTokens: number;        // discovery_tokens from obs + summaries
    readTokens: number;        // read_tokens from observations
    savingsTokens: number;     // total_read_tokens served via injections
    observationCount: number;
    sessionCount: number;
    timeRange: { days: number | null; cutoffEpoch: number };
    project: string | null;
  }
  ```
- Pattern: Follows `handleGetStats` pattern — direct DB queries via `this.dbManager.getSessionStore().db`
- Dependencies: Phase 1, Phase 2
- Risk: Low

#### 4.2 Register route
**File**: `/home/doublefx/projects/claude-mem/src/services/worker/http/routes/DataRoutes.ts`
- Action: Add `app.get('/api/analytics', this.handleGetAnalytics.bind(this));` in `setupRoutes()`
- Dependencies: 4.1
- Risk: Low

**Tests for Phase 4:**
- `tests/services/worker/http/routes/analytics-endpoint.test.ts` — test with various project/days filters, verify correct aggregation

---

### Phase 5: Frontend — Analytics Hook and Component

**Goal**: Create the `useAnalytics` hook and `AnalyticsBar` React component.

#### 5.1 Add `ANALYTICS` to API constants
**File**: `/home/doublefx/projects/claude-mem/src/ui/viewer/constants/api.ts`
- Action: Add `ANALYTICS: '/api/analytics'` to `API_ENDPOINTS`
- Dependencies: None
- Risk: Low

#### 5.2 Add `AnalyticsData` type
**File**: `/home/doublefx/projects/claude-mem/src/ui/viewer/types.ts`
- Action: Add interface:
  ```typescript
  export interface AnalyticsData {
    workTokens: number;
    readTokens: number;
    savingsTokens: number;
    observationCount: number;
    sessionCount: number;
    timeRange: { days: number | null; cutoffEpoch: number };
    project: string | null;
  }
  ```
- Dependencies: None
- Risk: Low

#### 5.3 Create `useAnalytics` hook
**File**: `/home/doublefx/projects/claude-mem/src/ui/viewer/hooks/useAnalytics.ts` (NEW)
- Action: Create hook following `useStats` pattern:
  ```typescript
  export function useAnalytics(project: string, days: number | null) {
    const [data, setData] = useState<AnalyticsData | null>(null);
    const [isLoading, setIsLoading] = useState(false);
    const [timeRange, setTimeRange] = useState<number | null>(30); // default 30d
    // Fetch from /api/analytics?project=&days= with AbortController
    // Re-fetch on project/timeRange change
    return { data, isLoading, timeRange, setTimeRange };
  }
  ```
- Pattern: Follows `useStats` with AbortController
- Dependencies: 5.1, 5.2
- Risk: Low

#### 5.4 Create `AnalyticsBar` component
**File**: `/home/doublefx/projects/claude-mem/src/ui/viewer/components/AnalyticsBar.tsx` (NEW)
- Action: Render 4 stat cards + time range selector:
  ```
  [Read Cost: 12.3K tokens] [Work Investment: 45.6K tokens] [Savings: 8.2K tokens] [Observations: 142 | 23 sessions]
  [7d] [30d] [90d] [All]
  ```
- Props: `project: string` (from filters)
- Uses `useAnalytics` hook internally
- Cards show formatted numbers (1.2K, 45.6K, etc.)
- Time range buttons are pill-shaped toggles
- Skeleton/loading state while fetching
- Dependencies: 5.3
- Risk: Low

#### 5.5 Add CSS styles for analytics bar
**File**: `/home/doublefx/projects/claude-mem/src/ui/viewer-template.html`
- Action: Add styles for `.analytics-bar`, `.analytics-card`, `.analytics-time-range`, etc.
- Use existing CSS variables (--color-bg-stat, --color-text-primary, etc.)
- Responsive: stack cards on narrow viewports
- Dependencies: None
- Risk: Low

#### 5.6 Integrate `AnalyticsBar` into App
**File**: `/home/doublefx/projects/claude-mem/src/ui/viewer/App.tsx`
- Action: Add `<AnalyticsBar project={filters.project} />` between `<Header>` and `<SearchResultsBadge>`
- Import the component
- Dependencies: 5.4
- Risk: Low

**Tests for Phase 5:**
- `tests/ui/hooks/useAnalytics.test.ts` — mock fetch, verify loading states, refetch on project/timeRange change
- `tests/ui/components/AnalyticsBar.test.tsx` — render with mock data, verify cards, time range toggle

---

### Phase 6: End-to-End Validation and Polish

**Goal**: Verify full data flow, handle edge cases, build and test.

#### 6.1 Handle zero-data state gracefully
**Files**: `AnalyticsBar.tsx`
- Action: When all values are 0, show "No analytics data" or show zeros without errors
- Dependencies: 5.4
- Risk: Low

#### 6.2 Format token numbers nicely
**File**: `/home/doublefx/projects/claude-mem/src/ui/viewer/utils/formatTokens.ts` (NEW)
- Action: Create `formatTokenCount(n: number): string` — returns "0", "1.2K", "45.6K", "1.2M"
- Dependencies: None
- Risk: Low

#### 6.3 Build and smoke test
- Action: Run `npm run build-and-sync` and verify viewer loads with analytics bar
- Verify analytics bar shows data when observations exist
- Verify project filter scoping works
- Verify time range selector changes data
- Dependencies: All previous phases
- Risk: Low

#### 6.4 Add SSE refresh trigger
**File**: `useAnalytics.ts`
- Action: Optionally accept an `sseRefreshSignal` (e.g., latest observation epoch) so the analytics bar refreshes when new observations arrive via SSE
- Dependencies: 5.3
- Risk: Low

## Testing Strategy

### Unit Tests
- `tests/shared/timeline-formatting.test.ts` — `estimateReadTokens()`
- `tests/services/sqlite/InjectionTracker.test.ts` — `trackInjection()`
- `tests/ui/hooks/useAnalytics.test.ts` — hook behavior
- `tests/ui/utils/formatTokens.test.ts` — number formatting

### Integration Tests
- `tests/services/sqlite/migrations/` — migration 21 (read_tokens) and 22 (context_injections)
- `tests/services/worker/http/routes/analytics-endpoint.test.ts` — `/api/analytics` with filters
- `tests/services/sqlite/SessionStore.test.ts` — `read_tokens` populated on store

### E2E Tests (manual or Playwright)
- Viewer loads analytics bar
- Project filter scopes analytics
- Time range selector changes values
- New observation via SSE triggers refresh

## Risks & Mitigations

- **Risk**: Backfill migration on large databases could be slow
  - Mitigation: The UPDATE is a single bulk statement; SQLite handles this efficiently. No row-by-row iteration needed.

- **Risk**: Injection tracking adds latency to context generation
  - Mitigation: The INSERT is a single row into a simple table — sub-millisecond. Fire-and-forget pattern acceptable.

- **Risk**: Context injection tracking in `/api/context/inject` requires knowing which observation IDs were used
  - Mitigation: Use a separate lightweight query at the API layer rather than modifying the render pipeline. Accept slight approximation.

- **Risk**: `context_injections` table could grow large over time
  - Mitigation: The table is append-only with indexed `created_at_epoch`. Future pruning can be added. For now, analytics queries filter by time range.

## Dependency Graph

```
Phase 1 (read_tokens column)  ──┐
                                 ├──► Phase 4 (API endpoint) ──► Phase 5 (Frontend) ──► Phase 6 (Polish)
Phase 2 (injections table)  ────┤
                                 │
Phase 3 (instrumentation)  ◄────┘
```

Phases 1 and 2 are independent and can be implemented in parallel.
Phase 3 depends on Phase 2 (needs the table).
Phase 4 depends on Phases 1 and 2 (needs both columns/tables for queries).
Phase 5 depends on Phase 4 (needs the API).
Phase 6 depends on Phase 5 (polish and integration testing).

## Success Criteria

- [ ] `read_tokens` column exists on observations table with correct backfill values
- [ ] `context_injections` table created and populated on context serve
- [ ] `/api/analytics` returns correct aggregated stats with project and time filters
- [ ] Analytics bar renders in viewer header area with 4 stat cards
- [ ] Time range selector (7d, 30d, 90d, All) updates displayed data
- [ ] Project filter from header scopes analytics data
- [ ] All existing tests still pass
- [ ] New tests cover migration, tracker, endpoint, hook, and component
