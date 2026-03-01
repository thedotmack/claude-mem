# Implementation Plan: Phase 1 — Quick Wins (v10.x) — v2

## Revision History

- **v1** (2026-03-01): Initial plan
- **v2** (2026-03-01): Amended after adversarial plan critic Round 1. Fixed 3 CRITICAL + 2 HIGH + 3 MEDIUM findings:
  - Added 4 missing INSERT paths (observations/store.ts, import/bulk.ts, SessionStore.importObservation, transactions.ts storeObservationsAndMarkComplete)
  - Total INSERT paths: 8 (was 3-4)
  - Clarified /start-agent endpoint MUST include broadcastSessionStarted (verified: handleSessionInitByClaudeId does NOT broadcast it)
  - Added useFilters derived computation updates (hasActiveFilters, isFilterMode, activeFilterCount)
  - Reordered Step 7 before Step 6 in dependency graph
- **v3** (2026-03-01): Amended after plan critic Round 2. Fixed 1 HIGH + 4 MEDIUM + 1 LOW findings:
  - Added `project` resolution via DB lookup to `/start-agent` handler pseudo-code (HIGH)
  - Listed 3 SessionStore inline type locations that need `priority` added (MEDIUM)
  - Corrected `import/bulk.ts` description — takes inline type, not `ObservationInput` (MEDIUM)
  - Narrowed session-init.ts line reference, added log message update note (MEDIUM)
  - Added rolling update risk note for SSE payload (MEDIUM)
  - Added PaginationHelper retrieval test to integration test (LOW)

## Overview

Phase 1 delivers two focused improvements from the v10.x roadmap: (1) priority tagging for observations (`critical`, `important`, `informational`) enabling context-aware injection and filtering, and (2) consolidation of dual route registration to close the security gap where legacy endpoints skip privacy checks. Both sub-features are independent and can be implemented in sequence within a single session.

## Requirements

### 1.1 Priority Tagging for Observations
- Add `priority` column to observations table (migration 25)
- Parse `<priority>` field from SDK agent XML responses
- Store priority in database (default: `informational`)
- Sort context injection by priority then recency
- Show priority badge in viewer UI
- Add priority filter in CommandPalette
- Add `<priority>` tag to SDK XML schema templates

### 1.2 Consolidate Dual Route Registration
- Make legacy handlers delegate to ByClaudeId handlers OR apply identical security checks
- Update `session-init.ts` to use the new `/api/sessions/init` endpoint for agent start (instead of legacy)
- Add deprecation logging on legacy endpoint usage
- Zero active callers remain for legacy observations/summarize endpoints

## Delivery Strategy

Feature branch + PR. Branch name: `feat/phase1-quick-wins`

## Architecture Changes

### 1.1 Priority Tagging — Files to modify:
1. `src/services/sqlite/migrations/runner.ts` — Add `ensurePriorityColumn()` (migration 25)
2. `src/services/sqlite/SessionStore.ts` — Add `ensurePriorityColumn()` mirror, update **4** INSERT paths: `storeObservations()`, `storeObservationsAndMarkComplete()`, `storeObservation()` (singular), AND `importObservation()`
3. `src/services/sqlite/transactions.ts` — Update INSERT in **both** `storeObservations()` AND `storeObservationsAndMarkComplete()` (14→15 columns each)
4. `src/services/sqlite/observations/store.ts` — Update standalone `storeObservation()` INSERT (15→16 columns)
5. `src/services/sqlite/import/bulk.ts` — Update standalone `importObservation()` INSERT (15→16 columns)
6. `src/services/sqlite/observations/types.ts` — Add `priority` to `ObservationInput`
7. `src/sdk/parser.ts` — Add `priority` to `ParsedObservation`, parse `<priority>` in `parseObservations()`
8. `src/sdk/prompts.ts` — Add `<priority>` tag to both XML schema templates (init + continuation)
9. `src/services/context/types.ts` — Add `priority` to `Observation` interface
10. `src/services/context/ObservationCompiler.ts` — Update BOTH `queryObservations()` AND `queryObservationsMulti()`: add priority to SELECT, sort by priority then recency
11. `src/services/worker/PaginationHelper.ts` — Add `priority` to all 3 explicit SELECT column lists in `getObservations()`
12. `src/services/worker/agents/types.ts` — Add `priority` to `ObservationSSEPayload`
13. `src/services/worker/agents/ResponseProcessor.ts` — Include `priority` in SSE payload construction
14. `src/ui/viewer/types.ts` — Add `priority` to frontend `Observation` and `FilterState`
15. `src/ui/viewer/constants/filters.ts` — Add `OBSERVATION_PRIORITIES` constant
16. `src/ui/viewer/components/ObservationCard.tsx` — Show priority badge
17. `src/ui/viewer/components/CommandPalette.tsx` — Add Priority filter section
18. `src/ui/viewer/hooks/useFilters.ts` — Add priority to filter state, toggle, AND derived computations (`hasActiveFilters`, `isFilterMode`, `activeFilterCount`)

### 1.2 Route Consolidation — Files to modify:
1. `src/services/worker/http/routes/SessionRoutes.ts` — Create new `/api/sessions/:sessionDbId/start-agent` endpoint; add deprecation logging to legacy handlers
2. `src/cli/handlers/session-init.ts` — Replace legacy `/sessions/${sessionDbId}/init` call with new `/api/sessions/${sessionDbId}/start-agent`

### Complete INSERT Path Inventory (8 total)

| # | File | Function | Current Cols | Has read_tokens | Has text |
|---|------|----------|-------------|-----------------|----------|
| 1 | `SessionStore.ts` ~L1535 | `storeObservation()` (singular) | 15 | Yes | No |
| 2 | `SessionStore.ts` ~L1674 | `storeObservations()` (batch) | 15 | Yes | No |
| 3 | `SessionStore.ts` ~L1806 | `storeObservationsAndMarkComplete()` | 15 | Yes | No |
| 4 | `SessionStore.ts` ~L2377 | `importObservation()` | 15 | No | Yes |
| 5 | `transactions.ts` ~L68 | `storeObservations()` | 14 | No | No |
| 6 | `transactions.ts` ~L184 | `storeObservationsAndMarkComplete()` | 14 | No | No |
| 7 | `observations/store.ts` ~L40 | `storeObservation()` (standalone) | 15 | Yes | No |
| 8 | `import/bulk.ts` ~L163 | `importObservation()` (standalone) | 15 | No | Yes |

All 8 must add the `priority` column. After update: SessionStore paths become 16 cols, transactions.ts paths become 15 cols, standalone paths become 16 cols.

## Implementation Steps

### Phase 1A: Priority Tagging — Backend

#### Step 1: Add priority to `ObservationInput` type
**File:** `src/services/sqlite/observations/types.ts`
- **Action:** Add `priority?: 'critical' | 'important' | 'informational'` to `ObservationInput` interface
- **Why:** This is the source-of-truth type that flows through the entire observation pipeline
- **Dependencies:** None
- **Risk:** Low
- **Test (RED):** `tests/sqlite/observations.test.ts` — Write test that creates observation with `priority: 'critical'` and verifies it is stored and retrievable

#### Step 2: Add priority to `ParsedObservation` and parser
**File:** `src/sdk/parser.ts`
- **Action:** Add `priority: 'critical' | 'important' | 'informational'` to `ParsedObservation` interface. In `parseObservations()`, extract priority using `extractField(obsContent, 'priority')` with validation (must be one of the three values, default to `'informational'`)
- **Why:** The SDK agent emits XML; the parser needs to extract the new field
- **Dependencies:** None (independent of Step 1)
- **Risk:** Low
- **Test (RED):** `tests/sdk/parser-priority.test.ts` — New test file:
  - Test parsing `<priority>critical</priority>` extracts correctly
  - Test missing `<priority>` defaults to `informational`
  - Test invalid priority value defaults to `informational`
  - Test all three valid values parse correctly

#### Step 3: Add database migration for priority column
**File:** `src/services/sqlite/migrations/runner.ts`
- **Action:** Add `ensurePriorityColumn()` method following the `ensureReadTokensColumn()` pattern:
  - PRAGMA check for column existence
  - `ALTER TABLE observations ADD COLUMN priority TEXT DEFAULT 'informational'`
  - No backfill needed (existing rows get the default)
  - Record version 25 in `schema_versions`
  - Call from `runAllMigrations()`
- **Why:** Schema evolution using the established idempotent migration pattern
- **Dependencies:** None
- **Risk:** Low — pattern is proven, ALTER TABLE ADD COLUMN is non-destructive
- **Test (RED):** `tests/sqlite/migration-25-priority.test.ts` — New test file modeled after `tests/sqlite/migration-read-tokens.test.ts`:
  - Test column is added when missing
  - Test default value is `'informational'`
  - Test migration is idempotent (safe to run twice)

#### Step 4: Mirror migration in SessionStore + update ALL 4 INSERT paths
**File:** `src/services/sqlite/SessionStore.ts`
- **Action:**
  1. Add `ensurePriorityColumn()` private method (mirror of runner), call from constructor's migration chain
  2. Update `storeObservations()` (plural, ~L1674): add `priority?: string` to inline type, add to INSERT (15→16 columns). Default to `observation.priority ?? 'informational'`
  3. Update `storeObservationsAndMarkComplete()` (~L1806): same change as above
  4. Update `storeObservation()` (SINGULAR, ~L1535): same change — THIRD INSERT path with its own inline type and 15-column INSERT
  5. Update `importObservation()` (~L2377): add `priority` to the 15-column INSERT (15→16 columns). This path uses `text` instead of `read_tokens`. Default to `observation.priority ?? 'informational'`
- **Why:** Dual migration paths must stay in sync. FOUR INSERT paths in SessionStore must all include priority.
- **Dependencies:** Step 3
- **Risk:** Medium — SessionStore is a god class (~2156 lines), must be surgical. Four INSERT statements to update.
- **Type flow note:** `ParsedObservation.priority` (from Step 2) is required (always set by parser with default). SessionStore inline types use `priority?: string` (optional) since other callers may not provide it. This is compatible — required is assignable to optional.
- **Inline type locations** (these are NOT `ObservationInput` — they are hard-coded inline types that must each gain `priority?: string`):
  1. `storeObservation()` parameter type ~L1508
  2. `storeObservations()` Array element type ~L1648
  3. `storeObservationsAndMarkComplete()` Array element type ~L1773
  4. `importObservation()` parameter type ~L2365
- **Test:** Covered by integration tests (Step 19)

#### Step 5: Update transactions.ts — BOTH INSERT functions
**File:** `src/services/sqlite/transactions.ts`
- **Action:** Update BOTH functions:
  1. `storeObservations()` (~L68): add `priority` to INSERT column list (14→15 columns). Access `observation.priority ?? 'informational'`
  2. `storeObservationsAndMarkComplete()` (~L184): same change — this is a second INSERT path with its own 14-column INSERT
- **Why:** Both are extracted (non-god-class) versions used by newer code paths. Note: transactions.ts has 14 columns (missing `read_tokens` vs SessionStore's 15) — this pre-existing divergence is tracked for Phase 3.
- **Dependencies:** Step 1 (ObservationInput type)
- **Risk:** Low
- **Test:** Covered by existing `tests/sqlite/observations.test.ts` updates

#### Step 5b: Update observations/store.ts standalone INSERT
**File:** `src/services/sqlite/observations/store.ts`
- **Action:** Update standalone `storeObservation()` function's INSERT to include `priority` column (15→16 columns). This function takes `ObservationInput` directly, so it will receive the `priority` field from Step 1. Default to `observation.priority ?? 'informational'`
- **Why:** Without this update, observations stored through this path silently drop priority despite the TypeScript type including it — a silent data loss path that passes type-checking
- **Dependencies:** Step 1 (ObservationInput type), Step 3 (migration)
- **Risk:** Low
- **Test:** Covered by existing `tests/sqlite/observations.test.ts` updates

#### Step 5c: Update import/bulk.ts standalone INSERT
**File:** `src/services/sqlite/import/bulk.ts`
- **Action:**
  1. Add `priority?: string` to the inline `obs` parameter type (this function uses a custom inline type with `memory_session_id`, `project`, `text`, `created_at`, `created_at_epoch`, etc. — it does NOT use `ObservationInput`)
  2. Update INSERT to include `priority` column (15→16 columns). This path uses `text` instead of `read_tokens` (same column set as `SessionStore.importObservation()`). Default to `obs.priority ?? 'informational'`
- **Why:** Without this update, imported observations lose their priority field — critical for data migration scenarios
- **Dependencies:** Step 3 (migration)
- **Risk:** Low
- **Test:** Covered by integration tests (Step 19)

#### Step 7: Add priority to context types
**File:** `src/services/context/types.ts`
- **Action:** Add `priority: 'critical' | 'important' | 'informational'` to `Observation` interface
- **Why:** Context injection pipeline needs the type for proper serialization. Must be done BEFORE Step 6 so the TypeScript type matches the SELECT columns.
- **Dependencies:** None
- **Risk:** Low

#### Step 6: Update context injection sort order (BOTH query functions)
**File:** `src/services/context/ObservationCompiler.ts`
- **Action:** Update BOTH `queryObservations()` AND `queryObservationsMulti()` SQL to:
  - Add `priority` to SELECT columns
  - Change ORDER BY to: `CASE priority WHEN 'critical' THEN 0 WHEN 'important' THEN 1 ELSE 2 END ASC, created_at_epoch DESC`
- **Why:** Critical observations should appear first in context injection. `queryObservationsMulti()` is actively called by `ContextBuilder.ts` for worktree support — must get the same sort order.
- **Note:** `querySummaries()` and `querySummariesMulti()` do NOT need priority ordering — summaries don't have priorities.
- **Dependencies:** Step 3 (migration), Step 7 (context types must be updated first)
- **Risk:** Low
- **Test (RED):** `tests/context/observation-compiler.test.ts` — Add test case:
  - Insert 3 observations with different priorities
  - Verify query returns them in priority order (critical first, then important, then informational)
  - Verify within same priority, recency still applies

#### Step 6b: Update PaginationHelper SELECT columns
**File:** `src/services/worker/PaginationHelper.ts`
- **Action:** Add `priority` (or `o.priority`) to ALL 3 explicit SELECT column lists in `getObservations()`:
  1. Summary-scoped query (~L126-128)
  2. Session-scoped query (~L159-161)
  3. Generic query string (~L199)
- **Why:** PaginationHelper uses hardcoded column lists. Without adding `priority`, the viewer's paginated observation API (`GET /api/observations`) will silently drop the field, making the priority badge always show `null`.
- **Dependencies:** Step 3 (migration)
- **Risk:** Low

#### Step 6c: Update SSE broadcast pipeline
**Files:** `src/services/worker/agents/types.ts`, `src/services/worker/agents/ResponseProcessor.ts`
- **Action:**
  1. Add `priority: string` to `ObservationSSEPayload` interface in `types.ts`
  2. Update the payload construction in `ResponseProcessor.ts` (~line 231) to include `priority: obs.priority ?? 'informational'` when building the SSE payload from `ParsedObservation[]`
- **Why:** Real-time SSE updates to the viewer must include `priority` for the badge to work on newly-created observations before pagination takes over.
- **Dependencies:** Step 2 (ParsedObservation with priority)
- **Risk:** Low

#### Step 8: Add `<priority>` tag to SDK XML schema
**File:** `src/sdk/prompts.ts`
- **Action:** Add `<priority>[ critical | important | informational ]</priority>` tag to both XML schema templates (lines 49-80 for `buildInitPrompt` and lines 197-228 for `buildContinuationPrompt`). Place it after `<type>` and before `<title>`. Add an XML comment with guidance:
  ```
  <!-- critical: breaks workflows or causes data loss. important: significant insight or key decision. informational: routine observation (default). -->
  ```
- **Why:** The SDK agent must know about the field to populate it
- **Dependencies:** None
- **Risk:** Low — adding a new optional field to the schema is backward-compatible; agents that don't know about it will simply omit it, and the parser defaults to `informational`

### Phase 1A: Priority Tagging — Frontend

#### Step 9: Add priority constants
**File:** `src/ui/viewer/constants/filters.ts`
- **Action:** Add:
  ```typescript
  export const OBSERVATION_PRIORITIES = [
    'critical', 'important', 'informational'
  ] as const;
  ```
- **Why:** Centralized constants for filter UI, consistent with existing pattern
- **Dependencies:** None
- **Risk:** Low

#### Step 10: Update viewer Observation type and FilterState
**File:** `src/ui/viewer/types.ts`
- **Action:**
  - Add `priority: string | null` to `Observation` interface
  - Add `priorities: string[]` to `FilterState` interface
- **Why:** Frontend needs the types to render and filter
- **Dependencies:** None
- **Risk:** Low

#### Step 11: Add priority badge to ObservationCard
**File:** `src/ui/viewer/components/ObservationCard.tsx`
- **Action:** Add a priority badge next to the existing type badge. Use colorblind-safe palette:
  - `critical` = Vermillion (#CC3311)
  - `important` = Orange (#EE7733)
  - `informational` = Light gray (#BBBBBB) — or hidden to reduce visual noise
- **Why:** Visual indicator in the timeline view
- **Dependencies:** Step 10
- **Risk:** Low
- **Test:** Visual verification (no automated test for badge rendering)

#### Step 12: Add priority filter to CommandPalette
**File:** `src/ui/viewer/components/CommandPalette.tsx`
- **Action:** Add a "Priority" filter section using the existing `FilterChip` component pattern, between Type and Concept sections. Wire to `FilterState.priorities`
- **Why:** Users need to filter observations by priority
- **Dependencies:** Steps 9, 10
- **Risk:** Low

#### Step 13: Update useFilters hook (client-side filter + derived computations)
**File:** `src/ui/viewer/hooks/useFilters.ts`
- **Action:**
  1. Add `priorities: []` to `EMPTY_FILTER` state initialization (default: empty array meaning show all)
  2. Add `togglePriority` callback following the existing `toggleObsType` / `toggleConcept` pattern
  3. Add CLIENT-SIDE priority filtering logic in the filter application function
  4. **Update `hasActiveFilters` memoization** (~L59-67): add `filters.priorities.length > 0` check
  5. **Update `isFilterMode` memoization** (~L69-76): add `filters.priorities.length > 0` check
  6. **Update `activeFilterCount` memoization** (~L78-86): add `filters.priorities.length` to the count
  7. Update `clearAll` handler to reset `priorities: []`
- **Why:** Without updating the 3 derived computations, the "clear filters" button won't appear when priority filter is active, the filter badge count will be wrong, and `isFilterMode` won't activate filtered view mode
- **Dependencies:** Step 10
- **Risk:** Low

### Phase 1B: Consolidate Dual Route Registration

#### Step 14: Create new `/start-agent` endpoint + deprecate legacy init
**File:** `src/services/worker/http/routes/SessionRoutes.ts`
- **Action:**
  1. Add deprecation warning log to legacy `handleSessionInit`
  2. Create new handler `handleStartAgent()` for `POST /api/sessions/:sessionDbId/start-agent`:
     ```typescript
     // Handler body (verified requirements):
     // 1. Parse sessionDbId from req.params
     // 2. Resolve project via DB lookup:
     //    const session = this.sessionStore.getSessionById(sessionDbId)
     //    const project = session?.project ?? ''
     // 3. Call this.ensureGeneratorRunning(sessionDbId, 'start-agent')
     // 4. Call this.eventBroadcaster.broadcastSessionStarted(sessionDbId, project)
     // 5. Return { status: 'agent_started', sessionDbId }
     ```
     **Note:** `project` is NOT available in the request body from `session-init.ts`. It must be resolved via DB lookup. `ensureGeneratorRunning` does not return the project.
  3. Register route in `setupRoutes()`: `app.post('/api/sessions/:sessionDbId/start-agent', ...)`
  4. Legacy handlers for observations and summarize (zero callers) get deprecation logging only

  **VERIFIED:** `handleSessionInitByClaudeId` does NOT call `broadcastSessionStarted()`. Only the legacy `handleSessionInit` calls it (at line ~350). Therefore the new `/start-agent` endpoint MUST include both `ensureGeneratorRunning()` AND `broadcastSessionStarted()`. This is not conditional.

  **Side effects note:** The legacy `handleSessionInit` does 5 things: (1) initializeSession, (2) get latest prompt + Chroma sync, (3) start agent, (4) broadcast prompt, (5) broadcast session started. The new `/start-agent` endpoint includes steps 3 and 5 only. Steps 1-2 and 4 are already handled by `handleSessionInitByClaudeId` which runs first in `session-init.ts`.

- **Why:** The legacy init does too much (session init + chroma sync + agent start) when the caller only needs agent start. Clean separation.
- **Dependencies:** None
- **Risk:** Medium — Changing the init flow. Verified: session-init.ts is the only caller of the legacy init endpoint.
- **Test (RED):** `tests/worker/routes/session-routes-deprecation.test.ts`:
  - Test legacy `/sessions/:id/init` logs deprecation warning
  - Test new `/api/sessions/:id/start-agent` starts generator
  - Test new `/api/sessions/:id/start-agent` broadcasts session-started event
  - Test legacy `/sessions/:id/observations` logs deprecation warning
  - Test legacy `/sessions/:id/summarize` logs deprecation warning

#### Step 15: Update session-init.ts to use new endpoint
**File:** `src/cli/handlers/session-init.ts`
- **Action:** Replace the `fetchWithRetry` call to `/sessions/${sessionDbId}/init` (~L133-149) with a call to `POST /api/sessions/${sessionDbId}/start-agent`. The body stays the same (`{ userPrompt, promptNumber }`). Also update the debug log message at ~L133 to reference the new endpoint name (`/api/sessions/:id/start-agent`).
- **Why:** Stop using the legacy endpoint that lacks privacy checks; the new endpoint is purpose-built for agent startup
- **Dependencies:** Step 14
- **Risk:** Low — the new endpoint is a subset of what the old one did

#### Step 16: Add deprecation logging to remaining legacy handlers
**File:** `src/services/worker/http/routes/SessionRoutes.ts`
- **Action:** Add `logger.warn('HTTP', 'DEPRECATED: Legacy endpoint called', { endpoint, sessionDbId })` at the top of `handleObservations` and `handleSummarize` handlers. These have ZERO active callers, so the logging serves as a canary.
- **Why:** If any unknown caller hits these endpoints, we want visibility
- **Dependencies:** None
- **Risk:** Low
- **Test:** Covered by Step 14 test

### Phase 1C: Integration & Verification

#### Step 19: End-to-end integration test
- **Action:** Write integration test that:
  1. Creates an in-memory DB with migration 25 applied
  2. Stores observations with different priorities via ALL storage paths (storeObservations, storeObservation singular, importObservation)
  3. Queries via `queryObservations()` and verifies sort order
  4. Verifies default priority on observations stored without explicit priority
  5. Verifies imported observations retain their priority
  6. Retrieves observations via PaginationHelper and verifies `priority` field is present in response
- **File:** `tests/integration/priority-tagging.test.ts`
- **Why:** Validates the full pipeline from storage to retrieval across all 8 INSERT paths, including PaginationHelper retrieval
- **Dependencies:** Steps 1-7, 5b, 5c
- **Risk:** Low

#### Step 20: Build verification
- **Action:** Run `npm run build-and-sync` and verify no TypeScript errors
- **Why:** Ensures all type changes are consistent
- **Dependencies:** All previous steps
- **Risk:** Low

## Testing Strategy

### Unit Tests (RED first)
| Test File | What It Tests | Step |
|-----------|--------------|------|
| `tests/sdk/parser-priority.test.ts` | Priority extraction from XML, defaults, validation | 2 |
| `tests/sqlite/migration-25-priority.test.ts` | Column addition, default value, idempotency | 3 |
| `tests/context/observation-compiler.test.ts` | Priority-based sort order in query | 6 |
| `tests/worker/routes/session-routes-deprecation.test.ts` | Deprecation logging, new agent-start endpoint, session-started broadcast | 14 |

### Integration Tests
| Test File | What It Tests | Step |
|-----------|--------------|------|
| `tests/integration/priority-tagging.test.ts` | Full pipeline: all storage paths → query → priority ordering | 19 |
| `tests/sqlite/observations.test.ts` | Updated: ObservationInput with priority field | 1 |

### E2E Tests
- Manual: Start worker, create session, verify priority appears in viewer
- Manual: Filter by priority in CommandPalette

## Risks & Mitigations

- **Risk:** SessionStore god class (~2156 lines) — surgical changes to FOUR INSERT statements could introduce regressions
  - Mitigation: All four INSERT paths (`storeObservations`, `storeObservationsAndMarkComplete`, `storeObservation`, `importObservation`) follow identical patterns. Change all consistently. Existing test suite covers storage.

- **Risk:** 8 total INSERT paths across 4 files — easy to miss one
  - Mitigation: Complete inventory table above. Each path is a plan step with explicit file and line reference. Integration test (Step 19) validates all storage paths.

- **Risk:** Dual migration paths (SessionStore + MigrationRunner) must stay synchronized
  - Mitigation: Follow the proven `ensureReadTokensColumn()` pattern exactly. Both use PRAGMA column-existence checks for idempotency.

- **Risk:** SDK agents may not populate `<priority>` field immediately (model behavior)
  - Mitigation: Parser defaults to `informational` when field is missing. Existing observations backfill with default. No breaking change.

- **Risk:** Legacy endpoint removal could break unknown callers
  - Mitigation: We are NOT removing legacy endpoints, only adding deprecation logging. The only change is session-init.ts switching to the new agent-start endpoint.

- **Risk:** `transactions.ts` divergence deepens — currently 14 cols (missing read_tokens), will become 15 (adding priority), while SessionStore has 15→16
  - Mitigation: Add priority to both. Note: the divergence between `transactions.ts` (no read_tokens) and `SessionStore.ts` (has read_tokens) is pre-existing tech debt tracked for Phase 3.

- **Risk:** `broadcastSessionStarted` could be missed in new `/start-agent` endpoint
  - Mitigation: VERIFIED that `handleSessionInitByClaudeId` does NOT broadcast it. The new endpoint MUST include it. Test case explicitly verifies this.

- **Risk:** During rolling updates, SSE clients may receive payloads with `priority` before the viewer code is rebuilt
  - Mitigation: Unknown JSON fields are silently ignored by the viewer's SSE event handler (standard JSON parse behavior). This is benign and requires no special handling.

## Do NOT

- Do NOT remove legacy endpoints — only add deprecation logging
- Do NOT add priority to FTS5 index — it is a fixed enum, not free-text searchable. FTS5 triggers (migration 24) do not need updating.
- Do NOT change the `text` column in observations — it is a legacy field, orthogonal to priority
- Do NOT modify the ChromaSync pipeline — priority is not relevant for vector embeddings
- Do NOT add priority to `worker-types.ts` `ParsedObservation` — that is a separate legacy type used by Gemini/OpenAI-compat agents, not the SDK parser
- Do NOT forget `storeObservation()` (singular) — it is a THIRD INSERT path in SessionStore alongside the plural versions
- Do NOT forget `importObservation()` — it is a FOURTH INSERT path in SessionStore (uses `text` instead of `read_tokens`)
- Do NOT forget `observations/store.ts` standalone `storeObservation()` — FIFTH INSERT path, separate file from SessionStore
- Do NOT forget `import/bulk.ts` standalone `importObservation()` — SIXTH INSERT path, separate file from SessionStore
- Do NOT forget `transactions.ts` has TWO INSERT functions — `storeObservations()` AND `storeObservationsAndMarkComplete()`
- Do NOT forget `queryObservationsMulti()` — it has its own independent SQL that must match `queryObservations()` sort order
- Do NOT forget `PaginationHelper.getObservations()` — uses hardcoded column lists that must include `priority`
- Do NOT forget `useFilters` derived computations — `hasActiveFilters`, `isFilterMode`, `activeFilterCount` all need `priorities` check
- Do NOT break backward compatibility — all changes must default to `informational`
- Do NOT add migration version 24 — that is already taken by `recreateFTSTablesWithUnicode61()`. Use version 25.
- Do NOT add priority to the search/MCP skill — this is a separate concern for a future iteration
- Do NOT add priority to export/import CLI commands beyond the INSERT path fix — schema evolution for export format is tracked separately

## Success Criteria

- [ ] `priority` column exists in observations table with default `'informational'`
- [ ] ALL 8 INSERT paths write `priority` to the database
- [ ] SDK XML schema includes `<priority>` tag in both init and continuation prompts
- [ ] Parser extracts priority with correct validation and defaulting
- [ ] Context injection sorts by priority first, then recency (both `queryObservations` and `queryObservationsMulti`)
- [ ] PaginationHelper includes `priority` in all 3 SELECT column lists
- [ ] SSE broadcast includes `priority` in `ObservationSSEPayload`
- [ ] Viewer shows priority badge on ObservationCard
- [ ] CommandPalette has working priority filter
- [ ] `useFilters` derived computations (`hasActiveFilters`, `isFilterMode`, `activeFilterCount`) include priority
- [ ] New `/api/sessions/:id/start-agent` endpoint starts generator AND broadcasts session-started
- [ ] Legacy `/sessions/:id/init` logs deprecation warning
- [ ] `session-init.ts` no longer calls legacy init endpoint
- [ ] All new tests pass (target: 10+ new test cases)
- [ ] `npm run build-and-sync` succeeds with no TypeScript errors
- [ ] Existing test suite continues to pass (2164+ tests)

## Implementation Order

```
Step 1   (ObservationInput type)      ──┐
Step 2   (Parser)                     ──┤── Independent, can parallelize
Step 3   (Migration runner)           ──┤
Step 7   (Context types)              ──┤
Step 8   (SDK prompts)                ──┤
Step 9   (Filter constants)           ──┘
                                        │
Step 4   (SessionStore 4x INSERT)     ←─ Depends on Step 3
Step 5   (transactions.ts 2x INSERT)  ←─ Depends on Step 1
Step 5b  (observations/store.ts)      ←─ Depends on Step 1, 3
Step 5c  (import/bulk.ts)             ←─ Depends on Step 3
Step 6   (ObservationCompiler sort)   ←─ Depends on Step 3, 7
Step 6b  (PaginationHelper columns)   ←─ Depends on Step 3
Step 6c  (SSE payload pipeline)       ←─ Depends on Step 2
Step 10  (Viewer types)               ←─ Depends on Step 9
                                        │
Step 11  (ObservationCard badge)      ←─ Depends on Step 10
Step 12  (CommandPalette filter)      ←─ Depends on Step 9, 10
Step 13  (useFilters hook + derived)  ←─ Depends on Step 10
                                        │
Step 14  (New /start-agent endpoint)  ──┐── Independent of 1A
Step 15  (session-init.ts update)     ←─ Depends on Step 14
Step 16  (Deprecation logging)        ──┘── Independent
                                        │
Step 19  (Integration test)           ←─ Depends on Steps 1-7, 5b, 5c
Step 20  (Build verification)         ←─ Depends on all
```

Estimated effort: 1 session (~2-3 hours)
