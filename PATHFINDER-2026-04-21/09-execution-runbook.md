# Pathfinder Phase 9: Execution Runbook

**This is the control document for `/do` execution of the claude-mem v6.5.0 brutal-audit cleanup.**

Read this file first. It tells you what to read next, what to skip, what rules apply, and where to mark progress. Do not rely on memory — check this file every turn. Do not re-plan; a plan already exists.

---

## STOP — read this before touching anything

### Reading hierarchy (canonical → supporting → stale → forbidden)

| Tier | Files | How to use |
|---|---|---|
| **Canonical (always authoritative)** | `07-plans/01-*.md` … `07-plans/12-*.md` | The 12 per-flowchart plans. Each is self-contained and /do-executable. When phase instructions conflict with anything else, the per-flowchart plan wins. |
| **Canonical (design authority, read-only)** | `05-clean-flowcharts.md` | The brutal-audit design. Per-flowchart plans already cite the relevant sections; re-read only to resolve ambiguity. **Never modify.** |
| **Canonical (this file)** | `09-execution-runbook.md` | Runbook + checklists. Update the checkboxes as tiers land. |
| **Canonical (reconciliation)** | `08-reconciliation.md` | Preflight status, tier dependencies, ownership conflicts, timer census, gaps ledger. Re-read before each tier. Re-run reconciliation itself after Tiers 3 and 4. |
| **Supporting (cite when needed)** | `07-master-plan.md` | Dispatch strategy + ladder. Skim once to orient, then work from `07-plans/`. |
| **Supporting (discovery evidence)** | `06-implementation-plan.md` **Phase 0 only** (V1–V20 verified-findings table, ~lines 22–47) | Cross-reference when a plan cites a V-number. The V-table is still authoritative. |
| **STALE — DO NOT FOLLOW** | `06-implementation-plan.md` **Phases 1–15** | Superseded by `07-plans/`. These 15 cross-cutting phases were written without `/make-plan` and collapse 12 flowcharts into phase-ordered chunks. Every instruction in these phases is replaced by the per-flowchart plan. If you find yourself reading Phase 1–15, stop and go to the corresponding `07-plans/` file. |
| **STALE — DO NOT FOLLOW** | `03-unified-proposal.md`, `04-handoff-prompts.md` | Earlier drafts, superseded by `05-clean-flowcharts.md`. Background only. |
| **Reference (read-only)** | `00-features.md`, `01-flowcharts/*.md`, `02-duplication-report.md` | "Before" state documentation. Read only when a plan cites them for the current implementation's shape. |

### Rules — do not drift

1. **One tier at a time.** Finish all plans in a tier before starting the next. Plans within a tier may run in parallel.
2. **One plan at a time inside a session** (unless you're the orchestrator dispatching subagents). `/do` executes one per-flowchart plan per subagent; the subagent opens the plan file, works its phases in order, runs every Verification block, then reports back.
3. **Copy from file:line — never invent APIs.** Every plan phase says "copy from `<file>:<line>`". If the line doesn't match what you expect, stop and ask — don't guess.
4. **Never widen scope.** If a plan's phase list doesn't mention a file, don't touch that file. Out-of-scope fixes go in a new follow-up plan, never in the current execution.
5. **Never edit `05-clean-flowcharts.md`.** It is the design authority. If reality contradicts 05, write a correction into the affected per-flowchart plan as a `> **Preflight edit YYYY-MM-DD**` note — do not silently modify the plan body, and never the design doc.
6. **Never edit `06-implementation-plan.md` Phases 1–15.** They are stale by definition.
7. **Check every Verification checklist.** "Phase complete" means every checkbox in the phase's Verification block is green. A subagent that reports "done" without running the greps/tests is rejected.
8. **Update this runbook as you go.** Mark tier boxes complete only after all plans in the tier pass verification. Mark a plan in-progress the moment a subagent is dispatched; mark it landed when verification passes; mark it blocked if verification fails.
9. **Stop the tier on failure.** If any plan in a tier fails verification, halt the tier — do not start the next tier until the failure is triaged.
10. **Re-run reconciliation after Tier 3 and Tier 4** (largest cross-plan overlap). The existing reconciliation process is in `08-reconciliation.md` § "Part 6"; repeat the five checks against the landed state.
11. **Viewer regression (plan 12) runs after every tier.** Plan 12 is a lockdown doc; its regression suite (`tests/viewer-lockdown/*`) executes once before Tier 1 to baseline, then again after Tiers 1, 2, 3, 4, 5, 6. Any regression halts the tier.
12. **Do not commit the worktree branch partway through a tier** unless the tier's partial state builds and tests pass. Per-plan commits within a tier are fine.
13. **When in doubt, read `08-reconciliation.md` Part 6** — it lists the landing decision and preflight status.
14. **Ask the user before destructive moves outside the plan's scope.** Deleting extra files, bumping unrelated dependencies, reorganizing directories = all require permission.

### Preflight status (must be true before Tier 1 starts)

- [x] **B1** — `package.json` engines.node bumped to `>=20.0.0` (applied 2026-04-22)
- [x] **B2** — plan 07 Phase 7 spec: HTTP 200 + `{timedOut: true}` on 110s timeout (applied 2026-04-22)
- [x] **C3** — plan 02 Phase 2: `user_prompts.chroma_synced` column added alongside observations + summaries (applied 2026-04-22)
- [x] **C6** — plan 03 Phase 2 + plan 07 Phase 7: `session.summaryStoredEvent` wiring (applied 2026-04-22)
- [x] **C7 (REVERTED 2026-04-22)** — earlier proposal introduced a dedicated `sqliteHousekeepingInterval`, which added a new repeating timer. Replaced by zero-timer model: `clearFailedOlderThan` moves to boot-once (plan 02); explicit `PRAGMA wal_checkpoint` calls are deleted (SQLite's `wal_autocheckpoint` default = 1000 pages is the contract). See 05 Part 4 revision 2026-04-22.
- [x] **C10** — plan 11 Phase 6: per-boot cache lifecycle contract documented (applied 2026-04-22)

**Preflight gate**: all six boxes must be `[x]` before launching Tier 1. If any is `[ ]`, stop — preflight edits are mandatory, not optional.

**In-flight blockers (gated during tier execution, not preflight):**
- **B3** (plan 10, Tier 5): prompt-caching TTL cost smoke test must pass before declaring plan 10 landed.
- **B4** (plan 11, Tier 6): plan 11 Phase 1 `npm install zod@^3.x` must run before any other plan 11 phase.
- **B5** (plan 04, Tier 3): Chroma upsert fallback error-text match is brittle; landed as-is with documentation, but flagged for ops review.

---

## Execution ladder — check off as you land

Tick the plan box only when every phase in the plan has passed verification AND the post-tier reconciliation (if applicable) is clean.

### Tier 1 — privacy foundation + viewer baseline (parallel)
- [ ] **Plan 01** — `07-plans/01-privacy-tag-filtering.md` (5 phases, ~−31 LoC)
- [ ] **Plan 12** — `07-plans/12-viewer-ui-layer.md` (6 phases, lockdown: baseline regression suite)

**Tier gate**: plan 12 Phase 4 must produce a clean baseline snapshot before any other tier runs. Plan 01's summary privacy gap (P1 security bug) must be verified closed via the `<private>secret</private>` regression test.

### Tier 2 — data plane (parallel)
- [ ] **Plan 02** — `07-plans/02-sqlite-persistence.md` (7 phases, ~−140 LoC source, +~295 add inc. schema.sql)
- [ ] **Plan 03** — `07-plans/03-response-parsing-storage.md` (5 phases, ~−100 LoC)

**Tier gate**: plan 02 Phase 2 must land `chroma_synced` on observations + summaries + user_prompts (three tables per preflight C3). Plan 03 Phase 2 step 5 must wire `summaryStoredEvent.emit('stored', summaryId)`. Plan 12 regression re-run.

### Tier 3 — chroma + renderer (parallel)
- [ ] **Plan 04** — `07-plans/04-vector-search-sync.md` (6 phases, ~−320 LoC) — depends on plan 02
- [ ] **Plan 05** — `07-plans/05-context-injection-engine.md` (8 phases, ~−930 LoC)

**Tier gate**: plan 04 relies on plan 02's migration. Plan 05's ANSI byte-equal snapshots must pass. **Re-run full reconciliation** per rule 10. Plan 12 regression re-run.

### Tier 4 — search + session lifecycle (parallel)
- [ ] **Plan 06** — `07-plans/06-hybrid-search-orchestration.md` (7 phases, ~−1700 LoC) — depends on plan 05
- [ ] **Plan 07** — `07-plans/07-session-lifecycle-management.md` (8 phases, ~−500 LoC) — depends on plans 01, 02, 03

**Tier gate**: plan 07 Phase 7 blocking endpoint must pass both happy-path and 110s-timeout integration tests with HTTP 200 on both paths (preflight B2). Plan 06 must return 503 `{error:'chroma_unavailable'}` when Chroma is down, not silent SQL fallback. **Re-run full reconciliation** per rule 10. Plan 12 regression re-run.

### Tier 5 — transcripts + hooks + corpus (parallel)
- [ ] **Plan 08** — `07-plans/08-transcript-watcher-integration.md` (6 phases, ~−86 LoC) — depends on plans 01, 07
- [ ] **Plan 09** — `07-plans/09-lifecycle-hooks.md` (7 phases, ~−460 LoC) — depends on plans 01, 05, 07
- [ ] **Plan 10** — `07-plans/10-knowledge-corpus-builder.md` (7 phases, ~−198 LoC) — depends on plans 05, 06

**Tier gate**: plan 09 Phase 3 Windows Terminal tab-close test (hook exit 0 on 110s timeout). Plan 10 Phase 7 step 3 cost smoke test (preflight B3). Plan 08 relies on Node 20+ (preflight B1). Plan 12 regression re-run.

### Tier 6 — http routes + zod (solo)
- [ ] **Plan 11** — `07-plans/11-http-server-routes.md` (8 phases, ~−120 LoC) — depends on plan 09

**Tier gate**: plan 11 Phase 1 `npm install zod@^3.x` (preflight B4). Schemas attach to post-plan-09 endpoint surface (4 session endpoints, folded context endpoints). Plan 12 regression re-run (final).

### Post-landing
- [ ] Full reconciliation re-run; all green.
- [ ] Deletion-ledger total landed within ±10% of the reconciliation target (~−3,800 LoC after double-count correction).
- [ ] Viewer regression baseline from Tier 1 matches viewer behavior after Tier 6 (modulo bearer-token re-baseline per plan 12 T1 + preflight C10).
- [ ] Full test suite clean on Node 20+.
- [ ] `grep -r "ProcessRegistry" src/` returns zero hits in `src/services/worker/` (supervisor registry is the only one left).
- [ ] `grep -rn "setInterval" src/services/worker/ src/services/worker-service.ts` returns **zero** hits. Zero-timer model: every recurring check is replaced by an event-driven handler, a per-operation `setTimeout`, or boot-once reconciliation. See 05 Part 4 (revised 2026-04-22).
- [ ] `grep -rn "startOrphanReaper\|staleSessionReaperInterval\|reapStaleSessions\|startReaperTick\|ReaperTick" src/` returns zero hits.
- [ ] `grep -rn "POLL_INTERVAL_MS\|MAX_WAIT_FOR_SUMMARY_MS" src/` returns zero hits (polling loop gone).
- [ ] `grep -rn "coerceObservationToSummary\|consecutiveSummaryFailures\|findDuplicateObservation\|stripMemoryTagsFromJson\|stripMemoryTagsFromPrompt" src/` returns zero hits.

---

## Per-plan quick reference

| Plan | Flowchart | Key files touched | Critical invariant to preserve |
|---|---|---|---|
| 01 | 3.2 privacy | `src/utils/tag-stripping.ts`, `src/services/worker/http/routes/SessionRoutes.ts` | Every text-ingress point strips memory tags; summary path closes P1 security gap |
| 02 | 3.3 sqlite | `src/services/sqlite/**` | WAL mode, FTS5 triggers, tables unchanged; only constraints + columns added |
| 03 | 3.7 parsing | `src/sdk/parser.ts`, `src/services/worker/agents/ResponseProcessor.ts`, `src/sdk/prompts.ts` | Atomic obs+summary TX preserved; parser contract enforced (no coerce) |
| 04 | 3.4 chroma | `src/services/sync/ChromaSync.ts` | Writes to SQLite never blocked by Chroma; `chroma_synced` flag drives backfill |
| 05 | 3.5 context | `src/services/context/**`, `src/services/worker/search/ResultFormatter.ts`, `src/services/worker/knowledge/CorpusRenderer.ts` | Agent + Human outputs byte-identical post-refactor |
| 06 | 3.6 search | `src/services/worker/SearchManager.ts`, `src/services/worker/search/**` | All three search paths preserved; 503 on Chroma-down, no silent fallback |
| 07 | 3.8 session | `src/services/worker/ProcessRegistry.ts` (deleted), `src/services/worker/worker-service.ts`, `src/services/worker/SessionManager.ts` | Subprocess crash recovery preserved via `child.on('exit')` handlers (already wired); previous-worker-crash orphans cleaned via boot-once `killSystemOrphans()`; abandoned-session cleanup via per-session `setTimeout(deleteSession,15min)` scheduled on last-generator-completion. **No repeating background timers.** |
| 08 | 3.12 transcripts | `src/services/transcripts/**` | Codex JSONL ingestion preserved; session_end → queueSummarize still triggers |
| 09 | 3.1 hooks | `src/cli/handlers/**`, `src/services/worker/http/routes/SessionRoutes.ts` | Hook exit codes preserved; Windows Terminal tab behavior (exit 0) preserved |
| 10 | 3.11 corpus | `src/services/worker/knowledge/**`, `src/services/worker/http/routes/CorpusRoutes.ts` | Build / query / rebuild / delete HTTP surface preserved; prime/reprime removed |
| 11 | 3.9 http | `src/services/worker/http/**`, all route files | All user-facing routes preserved; SSE preserved; admin endpoints preserved |
| 12 | 3.10 viewer | `tests/viewer-lockdown/*` (new) | No source changes; invariants I1–I12 hold |

---

## If something goes wrong

1. **Read `08-reconciliation.md` Part 5 gaps ledger first** — the issue may be a known blocker or coordination item.
2. **Check preflight status** at the top of this file. A missed preflight is the most common drift source.
3. **Do not "fix" by widening scope.** If a plan phase fails, the fix goes in that phase or a follow-up plan. Do not hand-edit the codebase outside the plan's scope.
4. **If a plan's file:line citation is stale** (file has moved or line numbers shifted because an earlier tier already edited it), note it in the plan body as a `> **Live correction YYYY-MM-DD**:` block and proceed with the updated location. Do not re-run the subagent that wrote the plan.
5. **If reconciliation after a tier fails the deletion-ledger check** by more than ±15% below target, a plan's deletions were incomplete. Re-read the plan's Phase verification blocks; the missing greps point to the undone work.
6. **If a plan reports "blocked"** because an upstream plan's assumption doesn't hold, escalate to the user with the plan file + phase number + the broken assumption. Do not improvise.

---

## Why this file exists

`07-master-plan.md` describes the split-and-dispatch strategy. `08-reconciliation.md` captures the snapshot of the 12 plans and the preflight decisions. Neither is a runbook with live state — they're snapshots. This file is the living execution record: it says what to read, what to skip, what to check off, and what rules prevent drift. An agent picking up the work cold reads **this file first** and can orient from here without having to reconstruct the state from 20 prior docs.
