# Claude-Mem Architecture Audit — 2026-04-19

**Context**: Luma container incident tonight. SDK session-4 SIGTERM'd after 17 min, 68 pending observations marked `failed`, 4 prior responses silently stored zero observations due to SDK format drift. Audit commissioned to find overengineering and propose the simplest elegant redesign.

**Method**: 6 parallel specialist audits with sequential-thinking reasoning, covering: queue/session lifecycle, SDK/agent/parser, worker bootstrap, storage/schema/migrations, search/Chroma/context, hook edge/CLI/routes.

**Scope**: ~13,700 LOC worker core.

**Potential simplification**: **~4,800 LOC ≈ 35% reduction**, same feature set, fewer failure modes.

---

## Executive summary

The luma incident is not a parser bug, not an SDK bug, not a queue primitive bug. It's a **philosophy bug** that shows up in three places:

> When something goes wrong, claude-mem cleans up aggressively (mark failed, drain, abandon) instead of leaving work in a state where it can be retried.

Every band-aid in the codebase rhymes with this. Once you see it, the redesign becomes obvious.

**Simple rule for the rebuild**: don't mark things "failed" — delete them or leave them pending. Don't coerce/rescue/fallback malformed output — log raw input, nack, retry a fresh agent. Don't parallel-implement; extract the base.

---

## Top 7 findings (ranked by severity)

### 1. The drain bug (CRITICAL — causes data loss on every SIGTERM)

- `SessionCompletionHandler.completeByDbId` at **`src/services/worker/session/SessionCompletionHandler.ts:43-54`** calls `markAllSessionMessagesAbandoned`, UPDATE-ing every `pending`/`processing` row to `status='failed'`.
- Called from 3 sites: `SessionCompletionHandler:43`, `worker-service.ts:911+934`, `SessionRoutes.ts:123`.
- The comment literally documents the band-aid: *"prevents the session from appearing in getSessionsWithPendingMessages forever"* — but that method only exists because we added a 4-state enum with a dead-end "failed" state.
- **Fix**: delete the drain (33 LOC) and delete `markAllSessionMessagesAbandoned` (10 LOC). On session completion either cascade-delete pending rows or leave them — no drama either way.

### 2. Queue over-engineering (`PendingMessageStore`, 513 LOC, 24 methods)

- **`'processed'` status** is defined in the enum but **never written by any code** — only `getRecentlyProcessed` reads it. Dead code.
- **Four** methods all do `processing → pending`: `resetStaleProcessingMessages`, `resetProcessingToPending`, `retryAllStuck`, `resetStuckMessages`. Collapse to one.
- **Two** methods mark failed: `markSessionMessagesFailed` + `markAllSessionMessagesAbandoned`. Both go away with finding #1.
- **Four** SessionManager "count" methods (`hasPendingMessages`, `getTotalQueueDepth`, `getTotalActiveWork`, `isAnySessionProcessing`) give the same answer.
- **Target design**: ≤150 LOC, 5 methods (`enqueue`, `dequeue`, `ack`, `nack`, `recover`), 2 statuses (`pending`, `processing`). Done = delete row. Retries implicit via `retry_count`; when exceeded, delete silently with debug log (no terminal "failed" state).

### 3. Three parallel agent implementations (`SDK` / `Gemini` / `OpenRouter`, 1,626 LOC)

- `SDKAgent.ts` 520, `GeminiAgent.ts` 559, `OpenRouterAgent.ts` 546. Each duplicates ~270 LOC of scaffolding: message loop, history truncation, conversation format, metadata prep, config loading.
- `getActiveAgent()` duplicated verbatim in **`worker-service.ts:635`** and **`SessionRoutes.ts:57`** (SessionRoutes throws, worker-service silently falls back — two behaviors).
- `startSessionProcessor` (`worker-service.ts:650-827`, 177 LOC) and `startGeneratorWithProvider` (`SessionRoutes.ts:182-367`, 185 LOC) are two parallel session-lifecycle managers.
- `runFallbackForTerminatedSession` (`worker-service.ts:863-920`, 58 LOC) is a band-aid that swaps providers mid-session — but SDK session context is gone and Gemini doesn't inherit it, so the fallback can't actually help. Delete.
- **Target**: 1 abstract `Agent` base (~150 LOC) + 3 thin adapters (~80 LOC each). One `SessionLifecycleManager` consumed by both entry points.

### 4. Parser forgiveness layer lets SDK regressions slip silently (`src/sdk/parser.ts`)

- `parseObservations` line 68: when SDK omits `<type>`, parser fills in mode's first type (`"bugfix"`) and logs error but **continues**. Empty-content guard at line 90 eventually saves us, but no retry is triggered.
- `coerceObservationToSummary` (222-259) rescues missing `<summary>` tags — pure band-aid for prompt conditioning drift.
- **Fix (~10 LOC)**: null/missing type → reject observation; log raw response snippet. `observations.length === 0 && text.length > 100` → log full raw response. Would have instantly pinpointed the luma issue.

### 5. Storage over-fragmentation, dead FTS, triple-migration (`SessionStore.ts` 2,872 LOC)

- **FTS5 is fully dead.** `SessionSearch.ts:21-22,40-56` explicitly comments *"FTS5 tables are maintained for backward compatibility but not used for search... Vector search (Chroma) is now the primary search mechanism."* But 6 triggers still fire on every observation insert.
- **Three parallel migration systems**: `migrations.ts` (645 LOC), `migrations/runner.ts`, AND `SessionStore.ts` constructor re-inlines all migrations (~1,000 LOC). Single source of truth → `SessionStore.ts` drops to ~1,600 LOC.
- **Dead columns**: `observations.relevance_count`, `observations.generated_by_model` (migration 026 Thompson Sampling never implemented).
- **Legacy v1 tables** never written since v4: `sessions`, `memories`, `overviews`, `diagnostics`, `transcript_events`.
- **Folder theatre**: `observations/`, `sessions/`, `summaries/`, `prompts/` = 15 per-method files, 1,322 LOC, each exporting 1–2 functions. Merge to 4 `operations.ts` files / ~900 LOC.
- **Result**: 13 tables → 4, 30+ indexes → 10, 6 triggers → 0.

### 6. Chroma None-query bug (confirmed root cause)

- `src/services/worker/SearchManager.ts:1167-1190` (`findByFile`) destructures `files: rawFilePath` with no null guard; passes `undefined` to `queryChroma` at line 1190. Same pattern at `findByConcept:1109` and `findByType:1300`.
- Chroma MCP rejects with `query_texts.0 Input should be a valid string [type=string_type, input_value=None]` (Pydantic).
- **Fix**: 3 one-line guards returning 400 if filter param missing.

### 7. Context generation is 9 classes to render markdown (1,624 LOC)

`ContextBuilder → ObservationCompiler → TokenCalculator → (AgentFormatter | HumanFormatter) → (HeaderRenderer, SummaryRenderer, TimelineRenderer, FooterRenderer)`. Classic over-abstracted pipeline. One file, ~200 LOC, same behavior.

---

## Target architecture

```
Hook (Claude Code | Cursor | Windsurf | Gemini | raw)
  → plugin/scripts/*-hook.js   [thin — stdin JSON → HTTP POST]
      → POST /api/hooks/{event-type}
          → express middleware normalizes by platform header
              → queue.enqueue(session, type, payload)

Queue (SQLite, ~150 LOC, 2 statuses)
  pending ⇄ processing → (row deleted on success; nack'd on failure → retry_count++)
  recover() on worker start: processing-older-than-60s → pending
  NO "failed" status. NO drain on session completion.

Agent loop (per session, driven by queue events)
  Agent.run(session):
    spawn(provider_adapter)       [SDK | Gemini | OpenRouter — 80 LOC each]
    for msg in queue.dequeue(session):
      response = send(prompt)
      observations = parse(response)
      if observations.empty and response.length > 100:
        log raw snippet; nack               # retry, don't coerce
      else:
        store(observations); ack

Storage (4 tables)
  sdk_sessions, observations, session_summaries, user_prompts
  One operations.ts per entity (~180 LOC)
  All migrations in MigrationRunner — SessionStore is pure data access

Search (Chroma only)
  findByX (file | concept | type): null-guard filter → HybridSearchStrategy → format
  SearchManager stays as thin facade (1,929 → ~1,100 after removing findBy* duplicates)
  Three strategies kept — all actively used
  TimelineService → merged into TimelineBuilder

Context generation
  generateContext(observations, summaries, config, forHuman) → string
  Single file, ~200 LOC
```

---

## Ordered execution plan

Each phase is independently shippable.

| # | Phase | LOC saved | Effort | Risk |
|---|---|---|---|---|
| 1 | Delete drain + parser strictness + Chroma null guards | ~55 | 1 hr | Low — **fixes incident** |
| 2 | Collapse `buildInitPrompt`/`buildContinuationPrompt`, unify `getActiveAgent()` | ~125 | 2 hrs | Low |
| 3 | Delete `'processed'` status, 4-way `reset*` collapse, 3-way `count*` collapse | ~60 | 3 hrs | Low |
| 4 | Delete FTS triggers + virtual tables + dead `SessionSearch` branches | ~200 | 4 hrs | Low (Chroma owns search) |
| 5 | Collapse context generation (9 classes → 1 file) | ~900 | 1 day | Low (pure rendering) |
| 6 | Delete `runFallbackForTerminatedSession` fallback chain | ~60 | 2 hrs | Medium — gate behind setting if desired |
| 7 | Extract `BaseAgent` + thin adapters for 3 providers | ~270 | 3 days | Medium — touches all 3 agents |
| 8 | Delete legacy `/sessions/:sessionDbId/*` endpoint shape | ~200 | 1 day | Medium — verify no external callers |
| 9 | Consolidate 3 migration systems → 1 `MigrationRunner`, strip `SessionStore` | ~1,200 | 3 days | Medium — careful ordering |
| 10 | Merge per-method storage files | ~420 | 1 day | Low — pure refactor |
| 11 | Drop legacy v1 tables + dead columns | schema cleanup | 4 hrs | Low |
| 12 | Extract `SessionLifecycleManager` from SessionRoutes + worker-service | ~400 reshuffled | 1 week | Higher — core lifecycle |
| 13 | Flatten 4-hop hook chain → `hook.js` directly posts to `/api/hooks/*` | ~1,400 | 1 week | Higher — touches every IDE adapter |

- **Fast path** (Phases 1–5, ~1 week): fixes incident + kills ~1,340 LOC + eliminates 6 FTS triggers on every insert.
- **Full refactor** (Phases 1–13, ~4–6 weeks): ~4,800 LOC deletion, 13 → 4 tables, 1 path for everything.

---

## Subsystem details

### Queue & session lifecycle

**Files**: `PendingMessageStore.ts` (513), `SessionManager.ts` (684), `SessionQueueProcessor.ts` (149), `SessionCompletionHandler.ts` (60), `SessionRoutes.ts` (1,078), `SessionStore.ts` (2,872).

**State machine today** (over-engineered):
```
pending ─claim─→ processing ─confirm─→ (deleted)
                              └─stale─→ pending  [4 methods do this!]
                              └─fail──→ failed   [2 methods do this, drain bug lives here]
                                        └─retry─→ pending
                                        └─clear─→ (deleted)
pending ─retryExhausted─→ failed                  [markFailed]
'processed' is defined but NO code writes it      [dead]
```

**Target state machine**:
```
pending ⇄ processing → (deleted on ack, retry_count++ on nack)
recover(): processing-older-than-60s → pending (called on worker startup + on each claim)
```

**Cuts**: 33 LOC drain logic, 10 LOC `markAllSessionMessagesAbandoned`, 16 LOC generator-error drain in SessionRoutes, 16 LOC `getRecentlyProcessed` + 'processed' enum, 22 LOC redundant query methods in SessionManager, 160–210 LOC legacy `/sessions/:dbId/*` endpoint shape. **Total ~410 LOC core + 160 LOC routes**.

### SDK / agent / parser / prompts

**Files**: `SDKAgent.ts` (521), `GeminiAgent.ts` (559), `OpenRouterAgent.ts` (546), `OneShotQuery.ts` (150), `ResponseProcessor.ts` (435), `FallbackErrorHandler.ts` (74), `parser.ts` (307), `prompts.ts` (333).

**Duplicate scaffolding across 3 agents**: message loop (~90 LOC each), `truncateHistory` identical (42 LOC ×2), conversation-format wrappers (6 LOC ×2), config loading (~70 LOC ×2), metadata prep (11 LOC ×2). **~270 LOC of pure copy-paste.**

**Prompt duplication**: `buildInitPrompt` (43-100, 57 LOC) and `buildContinuationPrompt` (198-259, 61 LOC) differ by ~5 lines. Collapse to one parameterized function.

**Parser fix** (`parser.ts:33-111`):
```typescript
// Add near line 66:
if (!type || type.trim() === '') {
  logger.error('PARSER', 'Observation has no type — rejecting', { correlationId });
  continue;  // don't fallback to mode[0]
}
// Add after the while loop:
if (observations.length === 0 && text.trim().length > 100) {
  logger.warn('PARSER', 'Large response produced zero observations; raw:',
    { correlationId }, text.slice(0, 500));
}
```

**Cuts**: 110 LOC prompt collapse, 270 LOC agent scaffolding, 58 LOC fallback chain, 11 LOC provider-selector dedup, +10 LOC parser strictness. **Total ~370 LOC cut + 10 LOC added**.

### Worker bootstrap & supervision

**Three overlapping systems**: `src/supervisor/*` (735 LOC, persistent daemon registry), `src/services/infrastructure/*` (1,923 LOC, GracefulShutdown/HealthMonitor/ProcessManager/WorktreeAdoption), `src/services/worker/ProcessRegistry.ts` (511 LOC, session-scoped RAM registry).

**The two registries are justified** — supervisor is persistent/daemon-wide, worker is RAM-only/session-scoped. Keep both.

**`worker-service.ts` (1,405 LOC) should be ≤300**. Extract:
- `BackgroundInitializer` (`initializeBackground`, ~227 LOC)
- `SessionProcessor` (`startSessionProcessor`, ~178 LOC)
- `PendingQueueRecovery` (`processPendingQueues`, ~109 LOC)
- `FallbackAgentOrchestrator` (delete in phase 6)
- `StatusBroadcaster` (17 LOC)

**SIGTERM 143 telemetry gap**: no single log line identifies who killed the SDK process. Add source + supervisor state + parent-alive check to the exit log.

**Cuts**: 414 LOC deletable (ProcessManager Bun resolution 140, `registerSignalHandlers` 6, `HealthMonitor` 228, misc 40) + extraction moves.

### Storage / schema / migrations

**FTS5 is dead but triggers on every insert**. 6 triggers × ~200 LOC SQL + 50 LOC TS → delete. Chroma already owns search.

**Three migration systems**:
1. `migrations.ts` (645 LOC, numbered migrations)
2. `migrations/runner.ts` (partial `MigrationRunner`)
3. `SessionStore.ts` constructor inlines 15+ private migration methods (~1,000 LOC)

Single source of truth → `SessionStore` shrinks 2,872 → ~1,600.

**Dead columns (migration 026)**: `observations.relevance_count`, `observations.generated_by_model`. Thompson Sampling never implemented. Drop in v11+.

**Legacy v1 tables**: `sessions`, `memories`, `overviews`, `diagnostics`, `transcript_events`. Not written since v4. Drop.

**Per-method folder theatre**: 15 tiny files (59 avg LOC) across `observations/`, `sessions/`, `summaries/`, `prompts/`. Merge to 4 `operations.ts`, each ~180 LOC.

**Proposed schema**: 4 tables (`sdk_sessions`, `observations`, `session_summaries`, `user_prompts`), 10 indexes, 0 triggers, 0 FTS.

### Search / Chroma / context

**Chroma None-bug exact fix** (`SearchManager.ts:1167-1190, 1109, 1300`):
```typescript
async findByFile(args: any) {
  const { files: rawFilePath, ...filters } = this.normalizeParams(args);
  const filePath = Array.isArray(rawFilePath) ? rawFilePath[0] : rawFilePath;
  if (!filePath || (typeof filePath === 'string' && filePath.trim() === '')) {
    return { content: [{ type: 'text', text: 'File path is required' }] };
  }
  // ... existing code
}
```

**`SearchManager` (1,929 LOC)** is a thin facade over `SearchOrchestrator` + strategies + formatters. Keep it — but its `findBy*` methods reimplement `HybridSearchStrategy` logic (~150 LOC duplicate). Delegate to orchestrator instead.

**Three strategies justified**: SQLite (filter-only), Chroma (semantic), Hybrid (metadata-first + semantic ranking). Hybrid actively used by all `findBy*`.

**Context generation (1,624 LOC across 9 classes)** is a classic over-abstracted render pipeline. Collapse to single `generateContext()` (~200 LOC). Salvage: `buildTimeline`, `calculateTokenEconomics`.

**Three timeline pieces**: `TimelineBuilder` (303, used by orchestrator), `TimelineService` (263, used only twice by SearchManager), `timeline/queries.ts` (SQL, keep). Merge `TimelineService` into `TimelineBuilder`.

**Cut**: ~1,650 LOC (900 context collapse + 263 TimelineService merge + 150 findBy duplication + 250 legacy SearchManager methods + 230 filter consolidation).

### Hook edge / CLI / routes

**Chain today (4 hops)**: Claude Code → `plugin/scripts/*.js` → `src/cli/hook-command.ts` → `src/cli/handlers/*.ts` + adapter → HTTP POST → worker route.

**All 5 adapters actively used** (claude-code, cursor, gemini-cli, windsurf, raw). Real multi-IDE pressure.

**Dual URL shapes** in `SessionRoutes`: `/sessions/:sessionDbId/*` (by DB id) AND `/api/sessions/*` (by content session id). Hooks all use `/api/sessions/*`; the `/sessions/:dbId/*` endpoints are internal-only. Either delete the internal ones or mark + restrict.

**Target 2-hop chain**: each `plugin/scripts/*-hook.js` is a thin stdin-JSON → HTTP POST; adapter normalization moves into Express middleware; `src/cli/*` deletes (~1,415 LOC).

**SessionRoutes.ts (1,077 LOC)** → extract `SessionLifecycleManager` (~250 LOC), routes shrink to ~350 LOC handler logic.

---

## Cross-cutting band-aid pattern

Every over-engineered subsystem got there the same way:

1. Ship a feature.
2. Hit a failure mode (SDK died mid-session, prompt drifted, FTS migration arrived with Chroma, new provider added).
3. Instead of refactoring the base, **add a compensating mechanism alongside** (`markAllSessionMessagesAbandoned`, `coerceObservationToSummary`, `runFallbackForTerminatedSession`, a third migration system, a second process registry).
4. Each compensator needs its own helper methods (`getSessionsWithPendingMessages`, `isSessionTerminatedError`, `detectStaleGenerator`, `resetStaleProcessingMessages`, four methods to "reset stuck").
5. The surface grows; the cores age; new developers read the helpers and build more helpers on top.

The resulting system, after the full refactor: ~8,900 LOC instead of 13,700, 4 tables instead of 13, 2 queue statuses instead of 4, 1 agent base + 3 adapters instead of 3 copies, 1 migration system instead of 3, 2-hop chain instead of 4. Same features. Less to break. Retryable instead of drainable.

---

## Verified ground truth from the luma incident

- Container: `claude-mem-luma` on port 37779. 30 observations stored (ids 1–30) between 05:20–05:32.
- 05:34:40 onwards: SDK started emitting bare `<observation>` (not wrapped in ```xml```) with every content field null. 4 consecutive responses → 0 stored. Parser logged `Observation missing type field, using "bugfix"` + `Skipping empty observation (all content fields null)`.
- 05:37:39: SDK subprocess SIGTERM'd (exit 143). `SessionCompletionHandler` fired → `markAllSessionMessagesAbandoned` → `UPDATE pending_messages SET status='failed' WHERE status IN ('pending','processing')` → **68 rows flipped to `failed`**.
- No retry, no replay. Those 68 observations are gone.
- DB state: 30 observations kept, 83 `failed` + 1 `summarize failed` in `pending_messages`.
