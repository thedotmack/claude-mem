# Pathfinder Phase 4: Handoff Prompts for `/make-plan`

Each block below is a ready-to-run `/make-plan` prompt for one unified system from `03-unified-proposal.md`. Copy a block directly into `/make-plan`.

Prompts are ordered by priority (from Phase 2 ranking): **U1 (security) → U6 (low-hanging fruit) → U4 → U3 → U2 → U5 → U7 → U8**.

---

## U1. Close the Privacy-Stripping Summary Gap (PRIORITY 1 — SECURITY)

```
/make-plan

TARGET: Close the privacy-tag-stripping asymmetry so that `<private>`, `<claude-mem-context>`, `<system_instruction>`, `<persisted-output>`, and `<system-reminder>` tags cannot reach the `session_summaries` table.

CURRENT BUG: The summary ingest path at `src/services/worker/http/routes/SessionRoutes.ts` handler `handleSummarizeByClaudeId` (around line 669-705) accepts a `last_assistant_message` field that was only partially stripped upstream — `src/cli/handlers/summarize.ts:66` passes `stripSystemReminders=true` to `extractLastMessage`, which only removes `<system-reminder>` via `SYSTEM_REMINDER_REGEX` in `src/shared/transcript-parser.ts:84`. Other privacy tags pass through and land in `pending_messages` → `session_summaries`.

FIX:
1. In `SessionRoutes.ts` `handleSummarizeByClaudeId`, immediately after extracting `last_assistant_message` from the body (before calling `queueSummarize`), call `stripMemoryTags(last_assistant_message)` from `src/utils/tag-stripping.ts`.
2. Verify the call site handles the empty-after-strip case (skip queuing if empty, mirroring `SessionRoutes.ts:865-872`).

PHASE 1 FLOWCHART: PATHFINDER-2026-04-21/01-flowcharts/privacy-tag-filtering.md
EVIDENCE: PATHFINDER-2026-04-21/02-duplication-report.md §B5

ANTI-PATTERNS TO REJECT:
- Do NOT add a new "privacy service" or class. `stripMemoryTags` is already a stateless utility.
- Do NOT add a feature flag. Just strip.
- Do NOT strip inside `queueSummarize` — strip at the HTTP boundary where other user-facing inputs are stripped.

TESTS: Add a unit/integration test that POSTs a summary with `<private>foo</private>` in `last_assistant_message` and asserts the stored `session_summaries` row contains no trace of it.
```

---

## U6. Collapse tag-stripping Wrappers to One Export

```
/make-plan

TARGET: Reduce `src/utils/tag-stripping.ts` to a single public export `stripMemoryTags(content: string)` and update call sites.

CURRENT STATE: The file exports two wrapper functions that both call the internal function with identical logic:
- `stripMemoryTagsFromPrompt` at `src/utils/tag-stripping.ts:79-91` (approx)
- `stripMemoryTagsFromJson` at same region
Both call `stripTagsInternal`.

CALL SITES TO UPDATE:
- `src/services/worker/http/routes/SessionRoutes.ts:629` (tool_input)
- `src/services/worker/http/routes/SessionRoutes.ts:633` (tool_response)
- `src/services/worker/http/routes/SessionRoutes.ts:862` (user prompt)
- Plus the new site from U1 (last_assistant_message)

FIX:
1. Rename `stripTagsInternal` to the public export `stripMemoryTags` and remove the two wrapper functions.
2. Update call sites to use the new name.

PHASE 1 FLOWCHART: PATHFINDER-2026-04-21/01-flowcharts/privacy-tag-filtering.md
EVIDENCE: PATHFINDER-2026-04-21/02-duplication-report.md §A1

ANTI-PATTERNS TO REJECT:
- Do NOT add overloads or options for "pretty print" etc. — keep it one argument in, one string out.
- Do NOT keep the old names as re-exports. Just update the imports.
```

---

## U4. Single Process Registry (drop worker-level facade)

```
/make-plan

TARGET: Delete the worker-level ProcessRegistry facade; make `src/supervisor/process-registry.ts` the sole process registry. Extract genuinely-useful spawn helpers to a plain-function module.

CURRENT STATE:
- `src/services/worker/ProcessRegistry.ts` (~528 lines) is a facade that delegates to `getSupervisor().getRegistry()` for state.
- `src/supervisor/process-registry.ts` (~409 lines) is the persistent registry (supervisor.json) with real logic.
- The facade adds spawn helpers (`createPidCapturingSpawn` at ~:393, `ensureProcessExit` at ~:185) that DO have value but don't need a class.

CALL SITES TO REWRITE (from Phase 2 evidence):
- Any import of `ProcessRegistry` from `src/services/worker/ProcessRegistry.ts` — change to `getSupervisor().getRegistry()` for state methods, OR to the new `process-spawning.ts` for spawn helpers.
- `src/services/worker/SessionManager.ts:535, 540, 631-670` (uses both spawn and state)
- `src/services/worker-service.ts:537` (orphan reaper setup — handled separately in U3)

FIX:
1. Create `src/services/worker/process-spawning.ts` exporting `createPidCapturingSpawn(...)` and `ensureProcessExit(...)` as plain functions.
2. Update every import of `src/services/worker/ProcessRegistry` to either `process-spawning.ts` (spawn helpers) or `getSupervisor().getRegistry()` (registration/lookup).
3. Delete `src/services/worker/ProcessRegistry.ts`.

PHASE 1 FLOWCHART: PATHFINDER-2026-04-21/01-flowcharts/session-lifecycle-management.md
EVIDENCE: PATHFINDER-2026-04-21/02-duplication-report.md §A7, §B8

ANTI-PATTERNS TO REJECT:
- Do NOT replace the worker facade with a "simpler worker facade." Delete it.
- Do NOT create an adapter class. Plain exported functions only for spawn helpers.
- Do NOT keep a re-export shim. Update all imports.
```

---

## U3. Unified Reaper (merge staleSession + orphan timers)

```
/make-plan

TARGET: Replace two independent reaper timers with a single `UnifiedReaper` that ticks every 30s and runs three checks at their respective cadences.

CURRENT STATE:
- `staleSessionReaperInterval` at `src/services/worker-service.ts:547` (2-min interval) calls `reapStaleSessions` in `src/services/worker/SessionManager.ts:516-568` which detects 5-min stuck generators and 15-min abandoned sessions.
- `startOrphanReaper` at `src/services/worker/ProcessRegistry.ts:508` (30s interval) runs `reapOrphanedProcesses` at `ProcessRegistry.ts:349` (dead-session PIDs, system orphans via ppid=1, idle daemon children).
- Shutdown at `worker-service.ts:1108-1110` clears `staleSessionReaperInterval`.

Relates to work item: **T32 refactor** (per context: "plan premise incorrect regarding unified reaper scope"). This plan clarifies the correct scope.

FIX:
1. Create `src/services/worker/UnifiedReaper.ts` with a single `setInterval` at 30s. Each tick:
   - Always: run orphan-process cleanup (existing `reapOrphanedProcesses` body).
   - Every 4th tick (2 min): run stuck-generator detection (existing `detectStaleGenerator` calls for each session with threshold 5 min).
   - Every 4th tick (2 min): run abandoned-session detection (threshold 15 min, deleteSession).
2. Move `reapStaleSessions` body into UnifiedReaper; keep `detectStaleGenerator` helper on SessionManager.
3. Delete `staleSessionReaperInterval` setup + teardown.
4. Delete `startOrphanReaper` (ProcessRegistry.ts:508) and the interval it returned.
5. Wire `UnifiedReaper` into worker startup (after sessionManager init) and shutdown (before graceful shutdown).

CALL SITES TO REWRITE:
- `src/services/worker-service.ts:547` → replace with `UnifiedReaper.start()`
- `src/services/worker-service.ts:1108-1110` → replace with `UnifiedReaper.stop()`
- `src/services/worker/ProcessRegistry.ts:508` → delete startOrphanReaper setup (migrated into UnifiedReaper)
- `src/services/worker/SessionManager.ts:516-568` → delete `reapStaleSessions` body (migrated)

PHASE 1 FLOWCHART: PATHFINDER-2026-04-21/01-flowcharts/session-lifecycle-management.md
EVIDENCE: PATHFINDER-2026-04-21/02-duplication-report.md §A4, §B9

ANTI-PATTERNS TO REJECT:
- Do NOT give each check its own timer "for flexibility." The whole point is ONE timer.
- Do NOT make intervals configurable via settings — hard-code 30s base tick and 4x multiplier.
- Do NOT build a plugin/registry. Three checks, called directly in sequence.
- Do NOT preserve the old reapers behind a feature flag.

NOTE: This plan supersedes any existing T32 plan premise; the unified reaper handles BOTH process orphans AND session-lifecycle concerns in one scheduler. Depends on U4 being complete first (so that ProcessRegistry refs resolve cleanly).
```

---

## U2. Unified Observation Renderer

```
/make-plan

TARGET: Create a single `ObservationRenderer` that four call sites use with pluggable strategies, eliminating ~600 lines of overlapping traversal and formatting logic.

CURRENT STATE (four independent renderers producing markdown from observations):
- `src/services/worker/search/ResultFormatter.ts:25-200` — CLI search results, grouped-by-date+file tables
- `src/services/context/formatters/AgentFormatter.ts:36-200` — LLM-compact one-liners
- `src/services/context/formatters/HumanFormatter.ts:35-238` — ANSI terminal output
- `src/services/worker/knowledge/CorpusRenderer.ts:14-133` — full-detail agent priming

All four look up type icon via ModeManager, estimate tokens, format title/subtitle, walk facts/concepts. Shared grouping helper already exists in `src/shared/timeline-formatting.ts`.

FIX:
1. Create `src/services/rendering/ObservationRenderer.ts` with:
   - `renderObservations(obs[], strategy): string`
   - Shared traversal: ModeManager lookup, token calc, time formatting, facts/concepts iteration.
2. Define `RenderStrategy` interface: `headerLine(obs)`, `detailLines(obs)`, `footerLine(obs)`, `groupingMode: 'date-file' | 'day-timeline' | 'none'`.
3. Concrete strategies (small files, each ~60 lines):
   - `SearchResultStrategy`
   - `AgentContextStrategy`
   - `HumanContextStrategy`
   - `CorpusDetailStrategy`
4. Reduce the four existing renderer files to thin shells: construct a strategy, call the renderer.
5. Delete the duplicate iteration/formatting code.

CALL SITES TO REWRITE:
- `ResultFormatter.formatSearchResults` (ResultFormatter.ts:25) → build SearchResultStrategy, call renderer
- `AgentFormatter.renderAgentTable` (AgentFormatter.ts:86) → build AgentContextStrategy, call renderer
- `HumanFormatter.renderHumanTable` (HumanFormatter.ts:80) → build HumanContextStrategy, call renderer
- `CorpusRenderer.renderCorpus` (CorpusRenderer.ts:14) → build CorpusDetailStrategy, call renderer

PHASE 1 FLOWCHARTS:
- PATHFINDER-2026-04-21/01-flowcharts/context-injection-engine.md
- PATHFINDER-2026-04-21/01-flowcharts/hybrid-search-orchestration.md
- PATHFINDER-2026-04-21/01-flowcharts/knowledge-corpus-builder.md
EVIDENCE: PATHFINDER-2026-04-21/02-duplication-report.md §A2, §A8, §B2

ANTI-PATTERNS TO REJECT:
- Do NOT build a registry or factory for strategies. Construct directly at call sites.
- Do NOT make strategies discoverable by name. They are four concrete classes.
- Do NOT introduce a DSL for rendering — plain TypeScript strategies only.
- Do NOT support dynamic output formats ("just in case"). If a fifth audience appears later, add a fifth strategy then.

TESTS: Snapshot tests for each of the four output formats using fixture observations; confirm byte-identical output before/after refactor.
```

---

## U5. Canonical XML Parser in Import Tool

```
/make-plan

TARGET: Make `src/bin/import-xml-observations.ts` use `parseSummary` from `src/sdk/parser.ts` instead of its parallel implementation.

CURRENT STATE: `src/bin/import-xml-observations.ts:162` has its own `parseSummary` that lacks ModeManager type validation. If summary XML schema evolves, the two diverge silently.

FIX:
1. Delete the inline parser in `import-xml-observations.ts`.
2. Import `parseSummary` from `src/sdk/parser.ts` and call it.
3. If (and only if) the import tool genuinely needs to skip type validation for historical observations with retired types, add an options argument to `parseSummary` (e.g., `{ strict: false }`) and pass it.

PHASE 1 FLOWCHART: PATHFINDER-2026-04-21/01-flowcharts/response-parsing-storage.md
EVIDENCE: PATHFINDER-2026-04-21/02-duplication-report.md §B4

ANTI-PATTERNS TO REJECT:
- Do NOT extend the parser API with an options object unless test data actually requires it. Start strict.
- Do NOT keep the inline parser as a fallback.
```

---

## U7. Delete SearchManager Deprecated Methods

```
/make-plan

TARGET: Remove `@deprecated` private methods from `src/services/worker/SearchManager.ts`.

CURRENT STATE: SearchManager retains legacy private methods (`queryChroma`, `searchChromaForTimeline`) that are flagged `@deprecated` and superseded by `SearchOrchestrator` strategies.

FIX:
1. Grep for remaining callers — likely none (they are private).
2. Delete the methods.
3. Confirm no test or compile breakage.

PHASE 1 FLOWCHART: PATHFINDER-2026-04-21/01-flowcharts/hybrid-search-orchestration.md
EVIDENCE: PATHFINDER-2026-04-21/02-duplication-report.md §B7

ANTI-PATTERNS TO REJECT:
- Do NOT leave dead deprecated code "just in case."
```

---

## U8. Transcript-Watcher Direct Queue + `ingestObservation` Helper

```
/make-plan

TARGET: Eliminate HTTP loopback in the transcript-watcher path by extracting the privacy-check + tag-strip + queue logic into a shared helper `ingestObservation(payload)` called directly by both `SessionRoutes` and `TranscriptEventProcessor`.

CURRENT STATE:
- `src/services/transcripts/processor.ts:240-244` calls `observationHandler.execute()` which POSTs to `/api/sessions/observations` via loopback HTTP.
- `src/services/worker/http/routes/SessionRoutes.ts:565-659` runs validation, privacy check, `stripMemoryTags` on tool_input/response, and `sessionManager.queueObservation`.

FIX:
1. Extract the validation + privacy-check + strip + queue logic from `SessionRoutes.ts:565-659` into a helper `ingestObservation(payload, { source })` in `src/services/worker/observation-ingest.ts`.
2. Update `SessionRoutes.handleObservationsByClaudeId` to call the helper.
3. Update `src/services/transcripts/processor.ts` to call the helper directly (delete the observationHandler invocation at line 240-244).

CALL SITES TO REWRITE:
- `src/services/worker/http/routes/SessionRoutes.ts:565-659` → reduce to thin wrapper over `ingestObservation`
- `src/services/transcripts/processor.ts:240-244` → replace observationHandler call with direct `ingestObservation` call

PHASE 1 FLOWCHARTS:
- PATHFINDER-2026-04-21/01-flowcharts/transcript-watcher-integration.md
- PATHFINDER-2026-04-21/01-flowcharts/lifecycle-hooks.md
EVIDENCE: PATHFINDER-2026-04-21/02-duplication-report.md §B3

ANTI-PATTERNS TO REJECT:
- Do NOT parameterize every difference between the two callers ("source: enum of 7 possible values"). Two call sites, two keyword args max.
- Do NOT move the logic into `SessionManager` itself — queue ingest is a boundary concern (privacy + strip happen here).
- Do NOT preserve the observationHandler → HTTP path as a fallback.

NOTE: Depends on U1 + U6 landing first so the strip helper name is already unified.
```

---

## Execution Order Recommendation

1. **U1** (security fix — land immediately)
2. **U6** (trivial; unblocks U1 cleanup)
3. **U5** (trivial; prevents drift)
4. **U7** (trivial; dead code)
5. **U4** (enables clean U3)
6. **U3** (unified reaper — requires U4 done)
7. **U8** (requires U1 + U6)
8. **U2** (largest, lowest risk — snapshot tests gate)

Each `/make-plan` invocation should produce a phased plan with ≤3 tasks per phase. Land in that order, verifying after each.
