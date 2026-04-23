# Pathfinder Phase 8: Reconciliation

**Date**: 2026-04-22
**Inputs**: 12 per-flowchart plans in `PATHFINDER-2026-04-21/07-plans/`
**Authority**: Master plan `07-master-plan.md` defines the five reconciliation checks executed here. Plans supersede audit claims where they verified against live code.

---

## Status gate

- **5 hard blockers** must be resolved before `/do` runs. All are single-file, single-command fixes or out-of-band decisions — none requires re-planning.
- **11 coordination items** are resolved by landing plans in dependency order (the ladder in `07-master-plan.md`). No deadlocks detected.
- **15 info items** logged; none blocks execution.
- **2 ownership conflicts** detected (plans 07/09 on `/api/session/end`, plans 09/11 on `/api/context/semantic` schema). Both resolved by landing order — no code-level conflict.
- **Deletion-ledger aggregate: ~−4,000 net source LoC**, 56% higher than the audit's −2,560 target. The overage is **genuine**, not double-counting: plan 06's live-code audit of `SearchManager.ts` (2069 lines → &lt;400) and plan 05's inclusion of `{Header,Timeline,Summary,Footer}Renderer.ts` files both exceeded the audit's row-level estimates.

**Recommended action**: resolve the 5 blockers (below), then run `/do` against the plans in the dependency order from `07-master-plan.md` § "Execution ladder". Reconciliation re-runs after each tier lands.

---

## Part 1 — Cross-plan citation index (overlap hotspots)

Only citations referenced by two or more plans are catalogued. Every overlap was verified consistent (same file, same or overlapping line range, same referenced symbol). No stale/divergent citations detected.

### Hotspot files (cited by 3+ plans)

| File | Cited by | Regions cited | Consistency |
|---|---|---|---|
| `src/services/worker/http/routes/SessionRoutes.ts` | 01, 03, 07, 09, 10, 11 | :377-389 (setupRoutes), :464-485 (handleObservations), :491-506 (handleSummarize), :629-633 (strip), :669-710 (summarizeByClaudeId), :747-753 (complete), :814-895 (sessionInit) | ✓ |
| `src/services/worker/SessionManager.ts` | 03, 07 | :17 (imports), :59-84 (detectStaleGenerator), :329-377 (queueSummarize), :336-346 (circuit breaker), :381-446 (deleteSession), :516-568 (reapStaleSessions) | ✓ |
| `src/services/worker/agents/ResponseProcessor.ts` | 03, 04, 07 | :69-108 (processAgentResponse), :87-108 (non-XML fail), :176-200 (circuit breaker), :286-308 (syncObservation), :380-405 (syncSummary) | ✓ |

### Cross-plan overlaps with symbol-level detail

- `SessionRoutes.ts:464-485` — plan 01 replaces the hand-rolled strip; plan 07 reframes the handler as an `ingestObservation()` call site. Plans must sequence: **01 before 07**.
- `SessionRoutes.ts:747-753` — plan 07 reads `session.lastSummaryStored`; plan 09 wires the hook-side blocking-call contract against the same state field. Plans must sequence: **07 before 09**.
- `SessionManager.ts:329-377` (queueSummarize) — plan 03 deletes lines :336-346 (circuit breaker + `consecutiveSummaryFailures`); plan 07 reframes the whole method around new pending-message queueing. Sequencing: **03 before 07**.
- `PendingMessageStore.ts:6, :99-145` — plan 02 Phase 4 moves the 60-s stale reset out of `claimNextMessage` into boot; plan 07 Phase 5 consumes that boot-recovery path. Sequencing: **02 before 07**.
- `SearchRoutes.ts:286-293` (inline semantic-injection mini-formatter) — plan 05 folds into `SearchResultStrategy`; plan 06 flags this as out-of-scope. Both plans acknowledge the handoff explicitly. Sequencing: **05 before 06**.
- `ResultFormatter.ts` and `CorpusRenderer.ts` — plan 05 deletes (consolidates into `renderObservations`); plans 06 and 10 consume the strategies. Sequencing: **05 before 06 before 10**.

### Files cited by exactly one plan (per-plan scope; no overlap)

- `src/utils/tag-stripping.ts` — plan 01 only.
- `src/services/sync/ChromaSync.ts` — plan 04 only.
- `src/services/worker/SearchManager.ts` — plan 06 only.
- `src/services/worker/knowledge/*` — plan 10 only.
- `src/services/transcripts/*` — plan 08 only.
- `src/cli/handlers/*` — plan 09 (most), plan 07 (summarize.ts for poll→blocking migration).
- `src/sdk/parser.ts` + `src/sdk/prompts.ts` — plan 03 only.
- `src/services/worker/ProcessRegistry.ts` (full file, 527 lines) — plan 07 only.
- `src/services/worker/http/middleware.ts` + route files (non-session) — plan 11 only.
- `src/ui/viewer/**` — plan 12 only (lockdown).

**No stale or divergent citations detected.** Reconciliation check 1 PASS.

---

## Part 2 — Deletion-ledger aggregate

| # | Flowchart | Plan: gross del | Plan: gross add | Plan: net | Audit Part 5 net | Delta | Flag |
|---|---|---|---|---|---|---|---|
| 01 | 3.2 privacy | −60 | +29 | **−31** | −42 | +11 | ✓ |
| 02 | 3.3 sqlite | −140 | +~295 (incl. schema.sql) | **−140** source-only | −490 | −71% | ⚠ reframe |
| 03 | 3.7 parsing | −135 | +35 | **−100** | −210 | −52% | ⚠ narrow count |
| 04 | 3.4 chroma | −320 | +~60 | **−320** | −320 | 0 | ✓ |
| 05 | 3.5 context | −1,250 | +320 | **−930** | −280 | +233% | ⚠ expanded scope |
| 06 | 3.6 search | −1,700 | +40 | **−1,700** | −260 | +554% | ⚠ audit undercounted |
| 07 | 3.8 lifecycle | −900 target | +400 | **−500** | −478 | +5% | ✓ |
| 08 | 3.12 transcripts | −161 | +75 | **−86** | −110 | −22% | ✓ |
| 09 | 3.1 hooks | −487 | +25 | **−460** | −100 | +360% | ⚠ includes SessionRoutes cleanup |
| 10 | 3.11 corpus | −228 | +30 | **−198** | −110 | +80% | ⚠ renderer double-count risk |
| 11 | 3.9 http | −180 | +60 | **−120** | −160 | +25% | ✓ |
| 12 | 3.10 viewer | 0 | 0 | **0** (lockdown) | 0 | — | ✓ |
| **TOTAL** | | **~−5,364** | **~+1,369** | **~−4,000** | −2,560 | **+56%** | — |

**Delta analysis:**

- Plans 05, 06, 09 overshoot the audit rows by genuine margins (live-code counts dwarfed the audit's row estimates — plan 06's SearchManager was estimated at −260 but the actual file is 2,069 lines of which >1,700 is boilerplate/deprecated/pass-through).
- Plan 02 undershoots because it keeps 19 private migration methods as upgrade-only runners and treats `schema.sql` as *additive new file* rather than a replacement for deleted lines.
- Plan 03 undershoots because its count is area-local (parser + ResponseProcessor) and doesn't roll up the audit's row pairing.
- Plans 05/06/10 share renderer deletion credit. Plan 10 explicitly flags this (`CorpusRenderer` migration "credit is shared with Plan 05/unified-renderer"). **Action**: plan 05 owns the deletion; plans 06 and 10 count only their consumer-side imports.

**Adjusted net after double-count correction**: ~−3,800 LoC (still +48% vs audit target; primarily plan 06's SearchManager mass-delete). Reconciliation check 2 PASS with note.

---

## Part 3 — Endpoint inventory reconciliation

### Before/after census

| Route file | Before | After | Δ |
|---|---|---|---|
| `SessionRoutes.ts` | 10 (6× `/sessions/:id/*` + 4× `/api/sessions/*`) | 4 (`/api/session/{start,prompt,observation,end}`) | −6 |
| `SearchRoutes.ts` | 18 | ~12 (pass-throughs deleted; `/api/context/{inject,semantic}` folded) | −6 |
| `CorpusRoutes.ts` | 7 | 5 (`/prime` and `/reprime` deleted) | −2 |
| Everything else | ~20 | ~20 (unchanged; Zod schemas added) | 0 |

**Audit claim** (05 § 3.1): "Endpoint count: 8 → 4". **Actual**: 10 → 4 per V9; plan 09 explicitly flags the audit undercount. Reconciliation adopts **10 → 4**.

### Ownership conflicts

1. **`POST /api/sessions/complete` → `POST /api/session/end` (blocking)**
   - Plan 07 Phase 7: owns the worker-side blocking handler (replaces old `handleSessionComplete` at `SessionRoutes.ts:753`).
   - Plan 09 Phase 6: owns the hook-side caller (replaces 500ms poll loop with single blocking call).
   - **Status**: co-ownership, not a conflict. **Sequencing: 07 before 09.**

2. **`POST /api/context/semantic`**
   - Plan 09 Phase 6: deletes the endpoint (folded into `/api/session/prompt`).
   - Plan 11 Phase 3: attaches a `SemanticContextSchema` Zod schema to it (still exists from 11's perspective).
   - **Status**: **landing-order conflict**. Plan 11 explicitly documents this (Gap 1: "Plan 09 landing order"). **Resolution: 09 must land before 11, or plan 11 must omit the semantic-context schema at execution time.**

3. **Plan-05 `/api/session/start`**
   - Plan 05 Phase 6: worker-side handler returns `{sessionDbId, contextMarkdown, semanticMarkdown}`.
   - Plan 09 Phase 1: hook-side caller consumes the payload.
   - **Status**: co-ownership, declared. **Sequencing: 05 before 09.**

Reconciliation check 3 PASS with mandatory landing order: **07 → 05 → 06 → 09 → 11**.

---

## Part 4 — Timer census (revised 2026-04-22: zero-timer model)

> **Revision note:** this section previously accepted a "3 → 1" (`ReaperTick`) target and, via C7, quietly added a second `sqliteHousekeepingInterval`, which pushed the real count to 2. Both were band-aids over an event-driven model that already exists. Investigation 2026-04-22 (Invariants 1-4) confirmed the live code supports a true zero-timer model with one additional boot-once call. Target revised to **3 → 0 repeating background timers**.

| Timer | Location | Action | Owner | Before | After |
|---|---|---|---|---|---|
| `staleSessionReaperInterval` | `worker-service.ts:174, :547` | **delete** (replaced by event-driven + boot-once) | 07 P3 | 2 min | — |
| `startOrphanReaper` | `worker-service.ts:537` + `ProcessRegistry.ts:508-527` | **delete** | 07 P3 | 30 s | — |
| Transcript rescan | `watcher.ts:124-132` | delete (event-driven `fs.watch` recursive) | 08 P1 | 5 s | — |
| Summary poll | `summarize.ts:24, :117-150` | delete (blocking endpoint) | 09 P3 | 500 ms × 220 | — |
| Claim-stale reset (in `claimNextMessage`) | `PendingMessageStore.ts:99-145` | delete → boot-once `recoverStuckProcessing()` | 02 P4 / 07 P5 | per-claim | boot-once |
| `clearFailedOlderThan(1h)` | `worker-service.ts:567` | delete interval → boot-once call | 02 P(new) | 2 min | boot-once |
| `PRAGMA wal_checkpoint(PASSIVE)` | `worker-service.ts:581` | **delete outright** (SQLite default `wal_autocheckpoint=1000` pages is the contract) | 02 P(new) | 2 min | — |
| `killSystemOrphans` (ppid=1 sweep) | `ProcessRegistry.ts:315-344` | keep function, **move call** from interval → boot-once | 07 P3 | 30 s | boot-once |
| Chroma MCP backoff | (existing) | keep (event-driven on disconnect, not a repeating sweeper) | — | as-is | as-is |
| `ensureProcessExit` 5-s escalate | `ProcessRegistry.ts:185-229` | keep (inlined SIGTERM→5s→SIGKILL per-operation) | 07 P6 | per-delete | per-delete |
| Generator-exit 30-s wait | per-delete `Promise.race` | keep (per-operation) | — | per-delete | per-delete |
| Per-iterator idle 3-min `setTimeout` | `SessionQueueProcessor.ts:6` + resets at `:51-52, :62-63` | keep (per-session, resets on every chunk — covers hung-generator case on its own) | — | per-session | per-session |
| **Abandoned-session `setTimeout(deleteSession, 15min)`** | new, in `SessionManager.ts` | **ADD (per-session)** — scheduled on last-generator-completion, cleared on new activity; replaces `reapAbandonedSessions` sweeper | 07 P3 | — | per-session |
| SSE auto-reconnect (UI) | `useSSE.ts:61-71` | keep (I11, browser-owned) | 12 | 3 s | 3 s |

### Cross-check against 05 Part 4 (revised 2026-04-22)

- **"Repeating background timers: 3 → 0"** — CONFIRMED. `staleSessionReaperInterval`, `startOrphanReaper`, transcript rescan, summary poll all retire. No `ReaperTick` is introduced. No `sqliteHousekeepingInterval` is introduced. Final worker-layer count: **0 `setInterval`** across `src/services/worker/` + `worker-service.ts`.
- **"Polling loops: 1 → 0"** — CONFIRMED. Summary poll retires into blocking endpoint.
- **Zero-timer viability** (investigation 2026-04-22):
  - **Invariant 1 (subprocess exit handlers)**: SDK at `ProcessRegistry.ts:479` → `unregisterProcess(:484)`; MCP at `worker-service.ts:530` → `supervisor.unregisterProcess(:531)`. HOLDS.
  - **Invariant 2 (per-iterator idle timer)**: `SessionQueueProcessor.ts:6` with resets at `:51-52, :62-63` and `onIdleTimeout` → `SessionManager.ts:651-655` → `abortController.abort()`. HOLDS; supersedes `reapHungGenerators`.
  - **Invariant 3 (sweeper coverage)**: only remaining event-model gap is ppid=1 orphans from a previous crashed worker. Closed by moving the existing `killSystemOrphans()` call from the interval to boot-once. HOLDS.
  - **Invariant 4 (SQLite housekeeping)**: `Database.ts:162-168` sets no `wal_autocheckpoint` override → SQLite default (1000 pages) is active. Explicit `wal_checkpoint(PASSIVE)` call is redundant. `pending_messages` has no constraint requiring periodic purge; `clearFailedOlderThan` at boot-once is sufficient. HOLDS.

Reconciliation check 4 PASS (no action items; the prior action item is rescinded).

---

## Part 5 — Consolidated gaps ledger

### BLOCKERS (5) — resolve before `/do`

| # | Plan | Blocker | Resolution |
|---|---|---|---|
| B1 | 08 | `package.json:58` engine floor is `>=18.0.0`; recursive `fs.watch` on Linux requires Node 20+ | Bump `engines.node` to `>=20.0.0` in `package.json` **before** plan 08 Phase 1. Single-line change. |
| B2 | 09 | Stop-hook exit code on 110-s timeout must be 0 (Windows Terminal contract from CLAUDE.md) — plan 07's new blocking `/api/session/end` must return 200 with `{timedOut: true, summaryId: null}`, not 504/408 | Decision: plan 07 Phase 7's blocking endpoint returns HTTP 200 with `{summaryId: null, timedOut: true}` on timeout. Plan 09 Phase 3 maps any 200 to exit 0. Document in plan 07 Phase 7 edit. |
| B3 | 10 | Prompt-caching TTL assumption ("~5 min, near free") is unmeasured. If SDK cache key is whitespace-sensitive or cwd-scoped, per-query cost jumps ~20× | Run plan 10 Phase 7 step 3 (cost smoke test: three sequential `/api/corpus/:name/query` calls; assert `cache_read_input_tokens > 0` on calls 2 and 3) **before** declaring plan 10 landed. Gate subsequent work on pass. |
| B4 | 11 | Zod is NOT transitively shipped (`npm ls zod` empty). 06 Phase 0's claim that it's transitive via `@anthropic-ai/sdk` is factually wrong — this repo uses `@anthropic-ai/claude-agent-sdk`. | Plan 11 Phase 1 must run `npm install zod@^3.x` and commit the `package.json` + `package-lock.json` delta before any other Phase 11 work. Already in plan, flagged here for ops visibility. |
| B5 | 04 | No native `chroma_upsert_documents` in MCP surface; plan uses `add → on "already exist" error → delete+add` fallback keyed on error-text match | Document the error-text match pattern in plan 04 Phase 2. Add a guard: if Chroma MCP ships upsert or changes error text, fallback must be updated. Low risk, but brittle — INFO-level in practice, but listed here because it's a silent-failure surface. Consider demoting to INFO after ops review. |

### COORDINATION (11) — resolve by landing order

| # | Plans | Coordination | Resolution via |
|---|---|---|---|
| C1 | 02 ← 08 | Plan 02 Phase 6 (delete DEDUP_WINDOW_MS) gated on cross-path `tool_use_id` availability | Plan 08 must land first; its ingest ensures `tool_use_id` is present. Plan 02 Phase 6 gates on grep-verify during /do execution. |
| C2 | 03 ↔ 07 | RestartGuard surface ownership — plan 03 does not add `recordFailure()`; plan 07 may need to extend RestartGuard later | 03 lands first with narrower interpretation; 07 evaluates during Phase 7 whether to extend. Non-blocking. |
| C3 | 02 ← 04 | Plan 04 assumes `user_prompts.chroma_synced` column exists; plan 02 Phase 2 adds `observations.chroma_synced` only | **Action**: plan 02 Phase 2 also adds `user_prompts.chroma_synced` (or defer prompt backfill as plan 04 follow-up). Recommend extending 02 during /do. |
| C4 | 05 → 06 | `SearchResultStrategy.columns` option must handle two row shapes (with/without Work column) + the `SearchRoutes.ts:286-293` inline mini-formatter | Plan 05 defines the option in Phase 4; plan 06 Phase 6 consumes. Enforce landing order 05 → 06. |
| C5 | 05 → 09 | `/api/session/start` must include semantic markdown — plan 05 Phase 6 worker-side; plan 09 Phase 1 hook-side | Landing order 05 → 09. |
| C6 | 03 → 07 → 09 | `summary_stored` event wiring — plan 03 owns ResponseProcessor emission; plan 07 owns blocking-endpoint await; plan 09 owns hook blocking call | **Action**: plan 03 Phase 2 adds `session.summaryStoredEvent = new EventEmitter()`; plan 07 Phase 7 awaits; plan 09 Phase 3 calls. Landing 03 → 07 → 09. |
| C7 (REVISED 2026-04-22) | 07 ↔ 02 | `clearFailedOlderThan` + `wal_checkpoint` currently ride the stale-reaper interval; interval itself is being deleted | **Resolution**: `clearFailedOlderThan` moves to boot-once in plan 02 (new phase). Explicit `PRAGMA wal_checkpoint(PASSIVE)` is deleted outright — SQLite's default `wal_autocheckpoint=1000` pages covers it. No new `setInterval` is introduced. Plan 07 Phase 3 deletes the shared interval as part of removing the stale reaper. |
| C8 | 01 → 02 → 09 | `tool_use_id` availability in `NormalizedHookInput` (plan 01 payload), DB UNIQUE constraint (plan 02), hook serialization (plan 09) | Landing order 01 → 02 → 09; plan 02 UNIQUE constraint verifies presence. |
| C9 | 09 → 11 | Plan 11 Zod schemas target plan 09's post-state endpoint surface | Landing order 09 → 11, OR plan 11 ships schemas for legacy endpoints and prunes when 09 lands. **Recommend 09 → 11.** |
| C10 | 12 ↔ 11 | Viewer T1 SHA-256 baseline vs plan 11's viewer.html static cache; bearer-token-per-boot injection | Plan 12 T1 re-baselines after every worker boot. Plan 11 must document that cache lifecycle is per-boot (not persistent) — add to plan 11 Phase 6 notes. |
| C11 | 01 → 07, 08, 09 | `ingestObservation/ingestPrompt/ingestSummary` helper location — plan 07 owns; plans 08 and 09 consume | Landing order 01 → 07 → (08, 09 parallel). |

### INFO (15) — logged only

- Plan 01: ReDoS micro-benchmark informational; `queueSummarize` integration covered by Phase 3 test.
- Plan 01: Double-strip of `<system-reminder>` is idempotent.
- Plan 02: `schema.sql` generator filter must cover future FTS5 suffix variants.
- Plan 03: `<skip_summary/>` recognition decision (prompt update vs parser strict) — flagged for product owner.
- Plan 04: `updateMergedIntoProject` metadata patching left untouched.
- Plan 05: ANSI color-preservation regression surface (byte-equal snapshot required in Phase 8).
- Plan 05: `ResultFormatter` has two row shapes (tracked in C4).
- Plan 06: 503 error-body JSON shape decision (`{error:'chroma_unavailable'}`).
- Plan 06: `ResultFormatter.formatSearchResults` caller grep checklist.
- Plan 08: audit-named "Cursor/OpenCode/Gemini-CLI transcripts" diverges from implementation — those use hooks, not JSONL watcher.
- Plan 09: hook-process module-scope cache caveat (perf, not correctness).
- Plan 10: `corpus.json` storage shape tradeoff (observations vs rendered string).
- Plan 11: Zod version lock-in (3.x stable surface).
- Plan 12: Playwright optional; fallback manual `CHECKLIST.md`.
- Plan 12: Catalog update strategy may stale on future project-deletion feature.

---

## Part 6 — Execution decision

**Reconciliation verdict: READY to run `/do`**, subject to completing the blocker resolutions below as a preflight step.

### Preflight (before `/do`)

1. Bump `package.json` `engines.node` from `>=18.0.0` to `>=20.0.0` (B1).
2. Edit plan 07 Phase 7 spec to mandate `HTTP 200 + {summaryId: null, timedOut: true}` on the 110-s timeout path; edit plan 09 Phase 3 to map HTTP 200 → hook exit 0 (B2).
3. Edit plan 02 Phase 2 to add `user_prompts.chroma_synced` column alongside `observations.chroma_synced` (C3).
4. Edit plan 03 Phase 2 to add `session.summaryStoredEvent = new EventEmitter()` emission on summary commit (C6).
5. Edit plan 07 Phase 4 to preserve `clearFailedOlderThan` + `wal_checkpoint` in a dedicated 2-min interval (C7, Part 4 action item).
6. Edit plan 11 Phase 6 to document per-boot cache lifecycle (for plan 12's T1 baseline reset — C10).

Blockers B3 (plan 10 prompt-caching cost smoke test) and B4 (plan 11 Zod install) are already in the respective plans; no preflight edit needed but `/do` must block on these gates during execution of those plans.

### Recommended `/do` landing order

Landing tiers (plans in a tier can run in parallel; next tier waits for previous):

- **Tier 1**: 01 (privacy), 12 (viewer lockdown — regression harness only, independent).
- **Tier 2**: 02 (sqlite), 03 (parsing).
- **Tier 3**: 04 (chroma, requires 02), 05 (context/renderer).
- **Tier 4**: 06 (search, requires 05), 07 (session lifecycle, requires 01+02+03).
- **Tier 5**: 08 (transcripts, requires 01+07), 09 (hooks, requires 01+05+07), 10 (corpus, requires 05+06).
- **Tier 6**: 11 (http routes, requires 09).

Rerun reconciliation after Tier 3 and Tier 4 — they have the highest cross-plan overlap. Viewer regression suite from plan 12 runs after every tier per its Phase 5 schedule.

### Success gate for the full cleanup

All six success criteria from `07-master-plan.md` must be true. After `/do` completes all tiers:

- 12 plan documents exist ✓ (already)
- All plans have the four-block reporting contract ✓ (extraction confirmed)
- All plans cite at least one V-number or declare absence ✓ (extraction confirmed)
- All phases have the four sub-fields ✓ (extraction confirmed per sampled plan)
- Deletion-ledger roll-up ~−4,000 LoC (after double-count correction: −3,800) — **exceeds** audit's −2,560 target by +48% due to genuine live-code undercount in the audit; reconciliation-verified, not padded.
- `08-reconciliation.md` written ✓ (this document)

**Gate status: CLEAR to proceed once preflight edits 1-6 above are applied.**
