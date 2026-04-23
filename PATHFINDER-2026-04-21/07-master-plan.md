# Pathfinder Phase 7: Master Orchestration Plan

**Date**: 2026-04-22
**Produced by**: `/make-plan` skill invoked on `05-clean-flowcharts.md`
**Supersedes**: `06-implementation-plan.md` as the top-level execution doc (06 is kept as Phase 0 Documentation-Discovery evidence; its verified-findings V1–V20 are still canonical and are re-cited from each per-flowchart plan).

> **For `/do` execution, read `09-execution-runbook.md` first** — it's the live runbook with drift-prevention rules, preflight status, and tier-by-tier checkboxes. This master plan describes the dispatch *strategy*; the runbook tracks the *state*.

---

## Why this plan exists

`06-implementation-plan.md` was written *without* invoking the `/make-plan` skill, so it collapsed 12 distinct flowcharts into 15 cross-cutting phases and lost per-flowchart isolation. A new chat context executing a single phase from 06 had to skim across multiple flowchart sections to piece its work together, which is the exact failure mode `/make-plan` exists to prevent.

**This plan fixes that by one-to-one mapping**: every flowchart in `05-clean-flowcharts.md` gets its own self-contained plan document in `07-plans/`, authored by a subagent that runs `/make-plan` methodology against that single flowchart. Any chat session can then execute any per-flowchart plan cold, with all design references, verified findings, and copy-ready snippets inlined.

---

## Phase 0 — Documentation Discovery (consolidated)

Sources and verified findings are not re-derived here — they already exist:

- **Design sources**: `05-clean-flowcharts.md` (canonical flowcharts + deletion ledger + execution order), `02-duplication-report.md` (cross-feature duplication), `03-unified-proposal.md` (U1–U8 targets), `00-features.md` (feature boundary map).
- **Verified-findings ledger**: `06-implementation-plan.md` Phase 0 table (V1–V20). Every per-flowchart plan **must** cite the V-numbers that apply to its scope and use the V-number reality over the audit's claim whenever they disagree.
- **Allowed APIs**: `06-implementation-plan.md` Phase 0 "Allowed APIs" section (`bun:sqlite`, Express 4, Zod, `fs.watch`, Claude Agent SDK). No new libraries are adopted in Phase 7; if a per-flowchart plan needs one it surfaces the request and stops.
- **Anti-patterns**: `06-implementation-plan.md` Phase 0 "Anti-patterns" (A–E). Every per-flowchart plan re-lists the subset of A–E it applies.

---

## Split strategy — 12 flowcharts, 12 plans

Each section of Part 3 in `05-clean-flowcharts.md` becomes exactly one plan document. The `01/` flowchart file in `PATHFINDER-2026-04-21/01-flowcharts/` is the "before" reference; the `05` section is the "after" design; the `07-plans/NN-<slug>.md` is the executable plan.

| # | Plan file | Flowchart in 05 | Original flowchart file | Primary 06 phases covered |
|---|---|---|---|---|
| 01 | `07-plans/01-privacy-tag-filtering.md` | 3.2 | `privacy-tag-filtering.md` | Phase 1 |
| 02 | `07-plans/02-sqlite-persistence.md` | 3.3 | `sqlite-persistence.md` | Phase 9 |
| 03 | `07-plans/03-response-parsing-storage.md` | 3.7 | `response-parsing-storage.md` | Phase 3 |
| 04 | `07-plans/04-vector-search-sync.md` | 3.4 | `vector-search-sync.md` | Phase 10 |
| 05 | `07-plans/05-context-injection-engine.md` | 3.5 | `context-injection-engine.md` | Phase 8 (partial) |
| 06 | `07-plans/06-hybrid-search-orchestration.md` | 3.6 | `hybrid-search-orchestration.md` | Phase 4, Phase 8 (partial) |
| 07 | `07-plans/07-session-lifecycle-management.md` | 3.8 | `session-lifecycle-management.md` | Phases 5, 6 |
| 08 | `07-plans/08-transcript-watcher-integration.md` | 3.12 | `transcript-watcher-integration.md` | Phase 7 |
| 09 | `07-plans/09-lifecycle-hooks.md` | 3.1 | `lifecycle-hooks.md` | Phases 2, 11 |
| 10 | `07-plans/10-knowledge-corpus-builder.md` | 3.11 | `knowledge-corpus-builder.md` | Phase 13 |
| 11 | `07-plans/11-http-server-routes.md` | 3.9 | `http-server-routes.md` | Phases 12, 14 |
| 12 | `07-plans/12-viewer-ui-layer.md` | 3.10 | `viewer-ui-layer.md` | — (no-change lockdown) |

The numeric prefix on each plan file encodes the **dispatch-and-execution order** (see "Dependency ordering" below). Filename slugs match the flowchart section title for easy grep.

---

## Dispatch strategy — parallel subagents, one per flowchart

### Why subagents (and not one monolithic author)
Each plan needs independent grep-verification against the live codebase (file:line citations, API confirmations, API-non-existence checks). Running these in parallel divides the codebase scan cost by 12 and forces each plan to stand alone — the subagent has no shared context, so anything it omits would not be available in a downstream `/do` execution either.

### Subagent contract (MANDATORY for every dispatch)

Each subagent receives a prompt with the following five fields, exactly matching the `/make-plan` skill's Subagent Reporting Contract:

1. **Target flowchart**: Section number in `05-clean-flowcharts.md` + the corresponding `01-flowcharts/*.md` "before" file + the output path in `07-plans/`.
2. **Reading list**: `05` (read full file; the section under plan is the authoritative "after" design), `06` Phase 0 ledger (V1–V20), the live codebase files cited in `05` (verify file:line; do not copy from the audit without re-grep).
3. **Dependencies**: Upstream flowcharts whose plans must land first, downstream flowcharts that depend on this one (copied from the dependency table below).
4. **Phase contract**: Every phase in the output plan must include (a) What to implement, framed as *copy from doc:line*; (b) Documentation references (05 section + V-numbers + live file:line); (c) Verification checklist (grep counts, tests); (d) Anti-pattern guards (subset of 06 Phase 0 A–E).
5. **Reporting contract** — the plan doc opens with:
   - **Sources consulted** — every file/URL read, with line ranges.
   - **Concrete findings** — exact API signatures, exact file:line locations, differences from the audit.
   - **Copy-ready snippet locations** — files and line ranges a future `/do` run will copy from.
   - **Confidence + gaps** — what the subagent could not verify and would need a follow-up read to confirm.

A plan doc missing any of the five reporting-contract fields is **rejected** and the subagent is redispatched.

### Parallelism envelope
All 12 subagents dispatch in one batch. They do not talk to each other. Cross-flowchart ordering concerns are handled by each plan citing its dependencies in its header, not by serializing the authoring work. Execution order (via `/do`) is the dependency order below; **authoring order is irrelevant** as long as every plan header lists its deps.

---

## Dependency ordering (for `/do` execution, not for authoring)

Derived from `05-clean-flowcharts.md` Part 6 and reconciled with `06-implementation-plan.md` Phase-dependency graph (line 659+).

```
01 privacy-tag-filtering          ──┬──► 08 transcript-watcher
                                    ├──► 09 lifecycle-hooks
                                    └──► 07 session-lifecycle

02 sqlite-persistence             ──┬──► 03 response-parsing
                                    ├──► 04 vector-search-sync   (needs chroma_synced migration)
                                    └──► 07 session-lifecycle   (needs boot-recovery path)

03 response-parsing-storage       ──┬──► 07 session-lifecycle   (parser contract used by ResponseProcessor)

05 context-injection-engine       ──┬──► 06 hybrid-search        (both consume U2 renderObservations)
                                    └──► 10 knowledge-corpus     (CorpusDetailStrategy is a renderObservations strategy)

06 hybrid-search-orchestration    ──┬──► 10 knowledge-corpus     (CorpusBuilder calls SearchOrchestrator)

07 session-lifecycle-management   ──┬──► 09 lifecycle-hooks      (blocking /api/session/end)

11 http-server-routes             ── independent of all except 12 (Zod middleware wraps existing routes)

12 viewer-ui-layer                ── independent; lockdown-only plan (no code changes planned)
```

**Execution ladder (top-down for `/do`):**
1. `01-privacy-tag-filtering` — unblocks everything that ingests text.
2. `02-sqlite-persistence` — unblocks every downstream DB change.
3. `03-response-parsing-storage` — unblocks session lifecycle.
4. `04-vector-search-sync` — requires 02's `chroma_synced` migration.
5. `05-context-injection-engine` — introduces U2 renderer; unblocks 06 and 10.
6. `06-hybrid-search-orchestration` — consumes U2 renderer; unblocks 10.
7. `07-session-lifecycle-management` — biggest cull; requires 01, 02, 03.
8. `08-transcript-watcher-integration` — requires 01 (shared ingest helper).
9. `09-lifecycle-hooks` — requires 01, 07 (blocking endpoint must exist).
10. `10-knowledge-corpus-builder` — requires 05, 06.
11. `11-http-server-routes` — independent; land any time after 01 for consistency.
12. `12-viewer-ui-layer` — lockdown doc; no code changes; land last as final regression gate.

If a downstream plan cannot be executed because an upstream one hasn't landed, `/do` halts that branch and reports the missing prerequisite. Parallel execution of independent branches (e.g., 04 and 07) is allowed.

---

## Aggregation / reconciliation step (post-dispatch)

After all 12 per-flowchart plans have been authored, the orchestrator (a human or a follow-up `/make-plan` session) performs these reconciliation checks:

1. **Cross-plan citation consistency** — every file:line cited in more than one plan must resolve to the same code. Any divergence indicates two subagents read different commits; re-dispatch the one citing the older line.
2. **Deletion-ledger totals** — sum the "lines deleted" claimed by all 12 plans; must be within ±15% of `05` Part 5's `-2560` net-lines figure. A large overshoot means duplicate deletion claims (two plans claiming ownership of the same file); the aggregator resolves ownership.
3. **Endpoint inventory** — collate every `/api/*` endpoint claimed as added/removed/renamed across 09 and 11; must equal `05` 3.1's "8→4" and `05` 3.9's route table exactly.
4. **Timer census** — aggregate every `setInterval`/`setTimeout` each plan claims to delete vs. keep; must match `05` Part 4 (3 repeating background timers → **0**, replaced by event-driven handlers + per-session `setTimeout`s + boot-once reconciliation).
5. **Confidence/Gap roll-up** — extract every plan's "Confidence + gaps" block into one aggregated gaps ledger. Any gap blocking execution triggers a targeted discovery subagent before `/do` runs.

Reconciliation writes `PATHFINDER-2026-04-21/08-reconciliation.md` before `/do` executes anything.

---

## Per-flowchart dispatch payload template

Every subagent dispatched in this batch receives this prompt scaffold (with `<FIELDS>` substituted):

```
You are implementing the /make-plan skill methodology on ONE flowchart from claude-mem
v6.5.0's brutal-audit refactor. You have no context from prior sessions; treat this
prompt as self-contained.

TARGET:
- Flowchart section: <SECTION> of PATHFINDER-2026-04-21/05-clean-flowcharts.md
  ("<FLOWCHART NAME>")
- Before-state file: PATHFINDER-2026-04-21/01-flowcharts/<BEFORE>.md
- Output path: PATHFINDER-2026-04-21/07-plans/<NN>-<SLUG>.md

DEPENDENCIES (cite in plan header):
- Upstream (must land before): <UPSTREAM LIST>
- Downstream (depends on this): <DOWNSTREAM LIST>

READING LIST (all five required):
1. PATHFINDER-2026-04-21/05-clean-flowcharts.md — full file for cross-refs; section
   <SECTION> is the authoritative "after" design.
2. PATHFINDER-2026-04-21/06-implementation-plan.md — Phase 0 verified-findings
   V1..V20 (lines ~26-47). Cite V-numbers whose scope touches this flowchart and
   prefer V-reality over audit claims.
3. PATHFINDER-2026-04-21/01-flowcharts/<BEFORE>.md — "before" diagram.
4. Live codebase files cited in section <SECTION> — re-grep every file:line before
   trusting it.
5. Any dependency plans already in PATHFINDER-2026-04-21/07-plans/ — for cross-plan
   citation consistency.

PHASE CONTRACT (every phase in the plan):
(a) What to implement — framed as "Copy from <file>:<line-range> into <dest>",
    never "transform existing code".
(b) Documentation references — 05 section + V-numbers + live file:line.
(c) Verification checklist — concrete greps (with expected counts) + tests to run.
(d) Anti-pattern guards — subset of 06 Phase 0 A–E relevant to this phase.

REPORTING CONTRACT (plan doc opens with four blocks):
- Sources consulted (files/URLs + line ranges)
- Concrete findings (exact APIs, file:line, deltas from audit)
- Copy-ready snippet locations (files a /do run will copy from)
- Confidence + gaps (what you could not verify; what a follow-up discovery must close)

CONSTRAINTS:
- Do NOT invent APIs. If a method "should exist", grep the class first and report
  absence in the Gaps block.
- Do NOT widen scope beyond <SECTION>'s "Kept user-facing" list.
- Cite exact file:line for every change; never write "somewhere in SearchManager".
- Plans must be /do-executable: each phase self-contained, copy-ready, verifiable.

WRITE the plan to PATHFINDER-2026-04-21/07-plans/<NN>-<SLUG>.md and stop. Do NOT
edit source code. Do NOT run /do. Report back with a one-paragraph summary
including the plan's phase count, total expected lines deleted, and top 1-2 gaps.
```

---

## What this orchestration plan does NOT do

- It does not edit source code. All source edits happen inside per-flowchart plans, executed by `/do` in a later session.
- It does not produce a consolidated deletion PR. Each per-flowchart plan is a separate landable unit.
- It does not redo the brutal audit. `05-clean-flowcharts.md` is the design authority; this plan only restructures its execution.
- It does not obsolete `06-implementation-plan.md`. 06's Phase 0 (verified-findings V1–V20) remains the canonical discovery record. 06's Phases 1–15 are superseded by the 12 per-flowchart plans, which preserve the same deletion targets but repackage them by flowchart boundary.

---

## Success criteria for Phase 7 (this orchestration plan)

- [ ] 12 plan documents exist under `PATHFINDER-2026-04-21/07-plans/`.
- [ ] Every plan opens with the four-block reporting contract (sources / findings / snippets / confidence).
- [ ] Every plan cites at least one V-number from 06's verified-findings ledger (or states explicitly that none apply).
- [ ] Every plan's phase has all four required sub-fields (What / Docs / Verification / Anti-pattern).
- [ ] Deletion-ledger roll-up across the 12 plans sums to −2500 ±15% net lines.
- [ ] 08-reconciliation.md is written before any `/do` execution.

When all six are true, the cleanup is ready for `/do` to execute the 12 plans in the dependency order above.
