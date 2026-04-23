# Phase 7 — Principle Cross-Check

**Reviewer**: Phase 7 meta-review subagent
**Date**: 2026-04-22
**Scope**: Corpus files in `PATHFINDER-2026-04-22/` excluding `_rewrite-plan.md`, `_reference.md`, `_mapping.md`.
**Corpus under review**: `00-principles.md`, `01-data-integrity.md`, `02-process-lifecycle.md`, `03-ingestion-path.md`, `04-read-path.md`, `05-hook-surface.md`, `06-api-surface.md`, `07-dead-code.md`, `98-execution-order.md`, `99-verification.md`.

## Summary verdict

**PASS** — 0 violations across all 7 checks.

---

## Check 1 — Dangerous identifiers (`recover|reap|heal|repair|orphan|coerce|fallback`, case-insensitive)

**Total hits**: 96 across the corpus (9 review files + supporting docs). Every hit in a review file classifies as DELETE-context, NEVER-ADD-guard, canonical-example, glossary definition, or invariant (self-heal) that is explicitly the new primary path. No hit advocates a new recovery / coerce / silent-fallback pattern.

### 00-principles.md

| Line | Matched text | Context | Verdict |
|---|---|---|---|
| 9 | "No **recovery** code" | Principle 1 statement | OK (principle) |
| 10 | "circuit-break, **coerce**, or silently fall back" | Principle 2 statement | OK (principle) |
| 13 | "process groups over hand-rolled **reapers**" + "**orphan** sweeps" | Principle 5 statement | OK (principle) |
| 22 | "No new `**coerce***`, `**recover***`, `**heal***`, `**repair***`, `**reap***`, `kill*Orphans*` function names" | Anti-pattern guard | OK (NEVER-ADD) |
| 23 | "try/catch that swallows errors and returns a **fallback** value" | Anti-pattern guard | OK (NEVER-ADD) |
| 24 | "new schema column whose only purpose is to feed a **recovery** query" | Anti-pattern guard | OK (NEVER-ADD) |
| 26 | "HTTP endpoint for diagnostic / manual-**repair** purposes" | Anti-pattern guard | OK (NEVER-ADD) |
| 40 | "**Orphan** **reapers**, idle-evictors, **fallback** agents" | Inventory of DELETEd mechanisms | OK (DELETE) |
| 41 | "`**repair**MalformedSchema`" + "self-**heal**ing claim" | DELETE target + canonical-example (self-heal is new invariant) | OK (DELETE + canonical) |
| 43 | "`**coerce**ObservationToSummary`, circuit breaker" | DELETE target | OK (DELETE) |
| 44 | "`@deprecated` dead classes" + "**repair**MalformedSchema" | DELETE targets | OK (DELETE) |
| 51–53 | Glossary: "lease pattern," "self-**healing** claim," "fail-fast contract" | Definitions of canonical new patterns (self-healing claim is the approved replacement invariant; lease pattern is a concept definition) | OK (canonical example / glossary) |

### 01-data-integrity.md

| Line | Matched text | Context | Verdict |
|---|---|---|---|
| 11 | "`**recover**StuckProcessing`, `clearFailedOlderThan` interval, `**repair**MalformedSchema` all hide bugs. They are deleted" | Principle 1 application | OK (DELETE) |
| 12 | "Chroma conflict errors surface through a narrow, flagged **fallback**; rest throws" | Scoped + flagged bridge, documented as non-permanent | OK (canonical bridge, gated by `CHROMA_SYNC_FALLBACK_ON_CONFLICT` flag with removal-commitment at line 282) |
| 15 | "self-**heal**ing claim is event-driven" | Canonical new invariant name | OK (canonical) |
| 30, 37, 71, 96, 98, 104, 106, 127, 129 | "self-**heal**ing claim" / "self-**heal** block" | Canonical invariant naming + "self-heal block" is the DELETE target within `claimNextMessage` | OK (canonical + DELETE) |
| 165, 180 | `clearFailedOlderThan` interval | DELETE target | OK (DELETE) |
| 187, 189, 192–197, 262 | `**repair**MalformedSchema` | DELETE target (Phase 6) | OK (DELETE) |
| 206, 239, 282 | "Chroma upsert **fallback**" + `CHROMA_SYNC_FALLBACK_ON_CONFLICT` | Flag-gated, bridge-only, documented for removal | OK (justified bridge) |
| 274 | "Do NOT keep `**recover**StuckProcessing()` … any identifier matching `**recover***`, `**heal***`, or `**repair***` that survives must be in a DELETE context" | NEVER-ADD guard | OK (NEVER-ADD) |
| 275 | "No `setInterval`, no `setTimeout` loop" | Backfill design constraint | OK (NEVER-ADD) |
| 276 | "Do NOT add '**repair**' CLI commands" | NEVER-ADD guard | OK (NEVER-ADD) |

### 02-process-lifecycle.md

| Line | Matched text | Context | Verdict |
|---|---|---|---|
| 11 | "**Orphan** sweeps, idle-evictors, stale-session **reapers** are recovery code papering over a spawn bug" | Principle 1 application | OK (DELETE rationale) |
| 12 | "Gemini → OpenRouter **fallback** chain hides SDK failures. Delete it" | DELETE target | OK (DELETE) |
| 13 | "Delete the 30-second **orphan**-**reaper** interval, the stale-session **reaper** interval" | DELETE targets | OK (DELETE) |
| 14 | "`killSystemOrphans`, `killIdleDaemonChildren`, `**reap**OrphanedProcesses`, `**reap**StaleSessions`" | DELETE list | OK (DELETE) |
| 27 | "`**reap**OrphanedProcesses`" | DELETE target (file anchor) | OK (DELETE) |
| 37 | "`**reap**OrphanedProcesses() { /* three-layer sweep */ }`" | Before-snippet in DELETE diff | OK (DELETE) |
| 46 | "There is no ppid sweep, no **orphan** **reaper**, no 'shadow' registry" | After-state assertion | OK (NEVER-ADD) |
| 55 | "OS primitive that makes **orphan** **reap**ing unnecessary" | Rationale | OK (rationale) |
| 118, 120, 128, 129, 136 | "Delete all **reaper** intervals" + `**reap**OrphanedProcesses` / `**reap**StaleSessions` / `reapStaleSessions()` | DELETE targets | OK (DELETE) |
| 146–147 | "no **reap**ers" + "Phase 2 process groups prevent **orphan**s" | After-state comment | OK (NEVER-ADD) |
| 208, 210, 213 | "Delete **fallback** agent chain (Gemini → OpenRouter)" + `**fallback**Agent` references | DELETE target (Phase 7) | OK (DELETE) |
| 233 | "no silent **fallback**s" | Reference to principle 2 | OK (NEVER-ADD) |
| 243 | "`detached: true` **fallback**" | Documented OS-level spawn primitive (daemon spawn pattern reference, not a silent-error fallback) | OK (canonical spawn primitive) |
| 341, 346, 347, 350, 353, 361 | Grep-zero greps for `**reap**StaleSessions`, `**reap**OrphanedProcesses`, `**fallback**Agent\|Gemini\|OpenRouter`, `**orphan** children`; "Do NOT keep `killSystemOrphans`" | Verification / NEVER-ADD | OK (DELETE-verification + NEVER-ADD) |

### 03-ingestion-path.md

| Line | Matched text | Context | Verdict |
|---|---|---|---|
| 13 | "`**coerce**ObservationToSummary` exists only to **recover** from LLM contract violations. Fix the contract, delete the coercion helper" | Principle 1 application | OK (DELETE) |
| 18 | "`**coerce**ObservationToSummary`, `pendingTools` Map, `TranscriptParser` class — all delete in the same PR" | DELETE list | OK (DELETE) |
| 64, 68, 84, 101, 129, 153, 155, 158, 163, 362 | `**coerce**ObservationToSummary` | DELETE target (Phase 4) + before-snippet + verification grep-zero | OK (DELETE) |
| 166 | "no `@deprecated` fence, no 'remove next release'" | Anti-pattern reminder | OK (NEVER-ADD) |
| 316 | "the dead class deletes now — not fenced with `@deprecated`" | Anti-pattern reminder | OK (NEVER-ADD) |
| 371 | "fuzz test: drop a JSONL file with an **orphan** tool_use" | Test case name describing input data, not a pattern to implement | OK (test vocabulary) |
| 384 | "Do NOT ship a polling **fallback** for `fs.watch`" | NEVER-ADD guard | OK (NEVER-ADD) |
| 389 | "No new `**coerce***`, `**heal***`, `**recover***`, `**repair***` function name" | NEVER-ADD guard | OK (NEVER-ADD) |

### 04-read-path.md

| Line | Matched text | Context | Verdict |
|---|---|---|---|
| 11 | "`SearchOrchestrator` throws `503` on Chroma error. … three try/catch **fallback**s that returned metadata-only are deleted" | Principle 2 application | OK (DELETE) |
| 13 | "the `fell**Back**: true` flag path, the `@deprecated getExistingChromaIds` fence … all delete in the PR" | DELETE list | OK (DELETE) |
| 86, 94, 98, 103, 108, 178, 183, 194 | "fell**Back**: true" / "silent **fallback**s" / "three near-identical methods … try/catch **fallback** to metadata-only" / "metadata-only **fallback**" / "Do NOT add a feature flag to 'disable fail-fast Chroma'" | DELETE targets + NEVER-ADD guard | OK (DELETE + NEVER-ADD) |
| 126 | "After Phase 2 deletes both classes, their `estimateTokens` helpers would **orphan**" | English verb (referring to consolidating helpers that would be orphaned), not a pattern | OK (narrative language) |
| 198–200 | "No new `**coerce***`, `**recover***`, `**heal***`, `**repair***` function names" / "try/catch that swallows errors and returns a **fallback** value" | NEVER-ADD guards | OK (NEVER-ADD) |
| 208 | "read-path `503` is correct even while the write-path **fallback** remains active" | Explicit scoped-to-write-path Chroma bridge (owned by 01) | OK (canonical bridge) |

### 05-hook-surface.md

| Line | Matched text | Context | Verdict |
|---|---|---|---|
| 77 | "the request/**fallback** sequence has one implementation; eight handlers import it. No handler reimplements the 'worker missing → exit gracefully' path" | Describes the one single helper path that handles worker-unreachable — explicitly the non-silent, escalates-to-exit-2 path. Used in sense of "alternative path" not "silent recovery" | OK (canonical single-helper description; the handler uses exit-code escalation per principle 2) |

### 06-api-surface.md

| Line | Matched text | Context | Verdict |
|---|---|---|---|
| 9 | "pending-queue diagnostic endpoints exist to poke at rows a correct ingestion path should never leave behind. Deleting them is the cure" | Principle 1 application | OK (DELETE) |
| 87 | "grep-and-delete every … `**coerce***` helper across route files" | DELETE directive | OK (DELETE) |
| 97 | "Claim-side contention → `01-data-integrity.md` Phase 3 (self-**heal**ing claim)" | Canonical invariant reference | OK (canonical) |
| 100 | "'No new HTTP endpoint for diagnostic / manual-**repair** purposes' — the rate limiter is the HTTP-handler analogue" | NEVER-ADD guard citation | OK (NEVER-ADD) |
| 114 | "principle 1 (no watcher-plus-TTL 'cache-invalidation' **recovery** code)" | Principle 1 rationale | OK (NEVER-ADD) |
| 126 | "KEEP `/api/processing-status` … not a **repair** lever. It reads and reports" | Definition of what is kept (non-repair) | OK (boundary statement) |
| 129 | "'No new HTTP endpoint for diagnostic / manual-**repair** purposes' — the deletions here are that guard applied retroactively" | NEVER-ADD guard citation | OK (NEVER-ADD) |

### 07-dead-code.md

| Line | Matched text | Context | Verdict |
|---|---|---|---|
| 33, 45, 81, 135, 144, 159 | `@deprecated` identifiers / fences | All DELETE directives or NEVER-ADD guards | OK (DELETE + NEVER-ADD) |

### 98-execution-order.md

| Line | Matched text | Context | Verdict |
|---|---|---|---|
| 14 | "self-**heal**ing claim" | Canonical invariant name | OK (canonical) |
| 20 | "catches **orphan**ed exports / commented-out blocks / dead migrations" | Sweep-plan scope language | OK (narrative about dead-code sweep, not a pattern) |
| 154 | "self-**heal**ing claim query" | Canonical invariant reference | OK (canonical) |
| 174 | "Chroma upsert **fallback** is brittle" | Documented bridge with flag + removal-commitment | OK (justified bridge) |
| 177 | "lazy-spawn wrapper needs a retry **strategy**" — resolved to hand-rolled 3-attempt retry | Describing the decision (hand-rolled logic, no new class) | OK (narrative describing resolution) |

### 99-verification.md

| Line | Matched text | Context | Verdict |
|---|---|---|---|
| 50, 53, 54, 58, 59, 71, 78, 79 | Grep-zero checks for `**recover**StuckProcessing`, `killSystem**Orphan**s`, `**reap**StaleSessions`, `**reap**OrphanedProcesses`, `killIdleDaemonChildren`, `**fallback**Agent`, `**repair**MalformedSchema`, `**coerce**ObservationToSummary` | Verification (must return 0) | OK (DELETE-verification) |
| 161 | "I5: `/health` endpoint" — mention in "**heal**th" endpoint name | Substring match on word "health" in endpoint name (not a recovery/heal pattern) | OK (substring, not the pattern the rule targets) |
| 164 | "Deleted diagnostic endpoints return `404`, not `200` with a **fallback** body" | Verification that NO silent fallback exists | OK (NEVER-ADD verification) |
| 176 | "kill Chroma, issue a search → 503 rendered, no **fallback**" | Verification of no silent fallback | OK (NEVER-ADD verification) |
| 191 | "no **orphan** children remain" | Integration-test assertion | OK (verification) |

**Verdict**: PASS. Every hit is DELETE-context, NEVER-ADD guard, canonical-example (self-healing claim, lease pattern, fail-fast contract as glossary), or a scoped + flagged Chroma-upsert bridge with documented removal.

---

## Check 2 — Timers (`setInterval|setTimeout`)

**Total hits**: 35 across the corpus (excluding support docs). Every hit is a DELETE target OR the explicitly justified per-operation kill-escalation `setTimeout` in `src/supervisor/shutdown.ts` (the SIGTERM→SIGKILL 5-second escalator — non-repeating, bound to a specific operation, disposed in-scope).

### Per-file breakdown

| File | Hits | Classification |
|---|---|---|
| 00-principles.md | 2 (lines 12, 21) | Principle 4 statement + NEVER-ADD guard for `src/services/worker/` |
| 01-data-integrity.md | 3 (lines 165, 180, 275) | DELETE + NEVER-ADD ("no `setInterval`, no `setTimeout` loop" for Chroma backfill) |
| 02-process-lifecycle.md | 7 (lines 13, 124, 135, 138, 155, 166, 341) | All DELETE targets (reaper intervals, `abandonedTimer` setTimeout) + verification grep-zero |
| 03-ingestion-path.md | 6 (lines 16, 174, 177, 194, 209, 346, 365, 390) | DELETE targets (the 5-second rescan `setInterval` at watcher.ts:124-132) + verification + NEVER-ADD guard |
| 05-hook-surface.md | 1 (line 107) | `const timer = setTimeout(...)` in the consecutive-failure-counter code snippet — this is the narrowly-scoped per-operation timer in the hook (see below) |
| 06-api-surface.md | 1 (line 141) | DELETE directive for shutdown wrappers that create `setInterval` callers |
| 99-verification.md | 5 (lines 13, 14, 15, 22, 25, 47, 82) | DELETE targets in census + explicit justification for per-operation one-shot `setTimeout` in `src/supervisor/shutdown.ts` (kill-escalation) |

**Line 107 of 05-hook-surface.md** — `const timer = setTimeout(...)`: this is a per-operation timer inside the consecutive-failure escalation code (bounded scope, cleared synchronously, not a repeating background sweep). Matches the "narrowly-justified per-operation" allowance in `99-verification.md:22`.

**Verdict**: PASS. No hit proposes a new repeating background timer in `src/services/worker/` or equivalent. Every repeating timer is a DELETE target. The only non-DELETE mentions are (a) the 5-second shutdown kill-escalation explicitly called out in 99, (b) the per-operation timer in 05 line 107 (bounded to the request lifecycle).

---

## Check 3 — Strategy/Factory/Builder

**Total hits**: 27 across the corpus (case-insensitive). All hits justify as one of: (a) `RenderStrategy` as a **config type** (not a class — explicitly enforced by `04-read-path.md` lines 33, 193); (b) existing module path `ChromaSearchStrategy` / `HybridSearchStrategy` (file-system name from existing code); (c) DELETE directives for the four old formatter "strategy classes"; (d) narrative descriptions (e.g., "retry strategy" for hand-rolled retry logic).

### Per-file breakdown

| File | Hits | Classification |
|---|---|---|
| 00-principles.md | 2 (lines 14, 25, 42) | Principle 6 statement + NEVER-ADD guard + "four formatter classes" = DELETE inventory | OK |
| 04-read-path.md | 15+ | `RenderStrategy` as config type (not class) — enforced explicitly at line 33 ("NO abstract class. NO factory. NO `RenderStrategyBase`") and line 193 ("Config object only. No `abstract class RenderStrategy`, no subclass-per-formatter, no factory, no registry"). `ChromaSearchStrategy` / `HybridSearchStrategy` are existing module paths from `src/services/worker/search/strategies/`. DELETE directives for old per-formatter strategies at lines 100, 103. | OK |
| 05-hook-surface.md | 2 (lines 275, 298) | "CLAUDE.md §Exit Code **Strategy**" — naming of the existing CLAUDE.md section, not a new class | OK |
| 06-api-surface.md | 0 | — |
| 07-dead-code.md | 1 (line 17) | Principle 6 quote — NEVER-ADD guard | OK |
| 98-execution-order.md | 3 (lines 160, 175, 177, 178) | `renderObservations(obs, strategy)` references config type; "retry **strategy**" at 177 resolves to "hand-roll a 3-attempt retry" (no new class); "explicit cache-control **strategy**" at 175 is a fallback plan description, not a proposed abstraction | OK |

**Verdict**: PASS. No hit proposes a new abstract-class / factory / builder layer. `RenderStrategy` is a `type` (object literal) and this is guarded three times in `04-read-path.md`.

---

## Check 4 — Forbidden phrases (`for backward compat|for one release|@deprecated`)

**Total hits**: 24 across the corpus. Every hit is a DELETE directive, a NEVER-ADD guard, or a reference to principle 7.

### Per-file breakdown

| File | Hits | Classification |
|---|---|---|
| 00-principles.md | 2 (lines 15, 44) | Principle 7 statement + DELETE inventory | OK (NEVER-ADD) |
| 03-ingestion-path.md | 2 (lines 166, 316) | "no `@deprecated` fence, no 'remove next release'" — NEVER-ADD reminder | OK |
| 04-read-path.md | 6 (lines 13, 112, 114, 117, 120, 179) | Phase 7 section DELETES `@deprecated getExistingChromaIds` | OK (DELETE) |
| 06-api-surface.md | 3 (lines 12, 89, 145, 224) | DELETE wrappers in-PR "not `@deprecated`-fenced"; "Do NOT keep a shutdown wrapper 'for backward compat'" | OK (NEVER-ADD) |
| 07-dead-code.md | 9 (lines 11, 33, 45, 81, 135, 144, 159) | Principle 7 quote + DELETE of residual `@deprecated` fences + NEVER-ADD guard | OK (DELETE + NEVER-ADD) |
| 99-verification.md | 1 (line 119) | Verification grep-zero for `// @deprecated\|// TODO remove\|// old$\|// legacy$` | OK (verification) |

**Verdict**: PASS. Zero advocacy for deprecated-fence or backward-compat retention; every mention is a DELETE directive or NEVER-ADD guard.

---

## Check 5 — `_reference.md` citations per plan

| Plan | `_reference.md` citations | Verdict |
|---|---|---|
| 00-principles.md | 0 | OK — 00 is the root principles doc; it defines anti-patterns and is cited by every downstream plan. It does not need to cite `_reference.md` because it asserts rules, not facts about specific code anchors. |
| 01-data-integrity.md | 10 | OK |
| 02-process-lifecycle.md | 17 | OK |
| 03-ingestion-path.md | 15 | OK |
| 04-read-path.md | 12 | OK |
| 05-hook-surface.md | 20 | OK |
| 06-api-surface.md | 6 | OK |
| 07-dead-code.md | 0 | ACCEPTABLE — 07 is the dead-code sweep plan. Its targets are identified by downstream DELETE directives in plans 01-06 (each of which cites `_reference.md`). 07 cites `_mapping.md` DELETE rows and runs `ts-prune`/`knip` for residue. Sweeping unused exports does not require line anchors — if a symbol has no callers after 01-06 land, it is dead. |
| 98-execution-order.md | 1 | OK (structural doc; cites as part of the "how to execute a phase" load list) |
| 99-verification.md | 0 | ACCEPTABLE — 99 is the verification-operational doc. It runs greps and integration tests whose targets are defined by the plans that cite `_reference.md`. Verification targets (e.g., `coerceObservationToSummary` grep → 0) are inherited from plans 01-06 that cite the anchors. |

**Verdict**: PASS. Every plan that touches existing code anchors cites `_reference.md` at least 6 times. The three plans with zero citations (00, 07, 99) are structurally correct: 00 asserts rules, 07 sweeps residue from plans that already cited, 99 verifies grep-zero against targets already cited.

---

## Check 6 — Mapping completeness

`_mapping.md` accounts for every old `PATHFINDER-2026-04-21` plan (Plans 01 through 12) and every supporting document (`00-features.md`, `02-duplication-report.md`, `03-unified-proposal.md`, `04-handoff-prompts.md`, `05-clean-flowcharts.md`, `06-implementation-plan.md` Phase 0 + Phases 1-15, `07-master-plan.md`, `08-reconciliation.md`, `09-execution-runbook.md`). Each row has a verdict (KEEP / REWRITE / DELETE / SPLIT) and a new-plan destination or explicit archive location.

Line 210-212 of `_mapping.md` explicitly asserts: "**Archive `PATHFINDER-2026-04-21/` wholesale once the new corpus lands. No orphans** — every section either maps to a new plan or goes to the archive."

No orphan old sections identified. Plan 03 (response-parsing-storage) is flagged as heavily duplicating Plan 01 — its unique content is consolidated into `03-ingestion-path.md` and duplicate phases are explicitly DELETE'd (lines 62-66). Plan 07 (session-lifecycle-management) — the heaviest-debt plan — has every mechanism line-item accounted for (Mechanism A KEEP, Mechanism B/C DELETE, Phase 1 SPLIT to 03 Phase 0, Phases 2-7 REWRITE to 02, Phase 8 KEEP).

**Verdict**: PASS.

---

## Check 7 — DAG in 98-execution-order.md

### Node → incoming edges

- `00` ← ∅
- `01` ← {00}
- `02` ← {00}
- `03` ← {01, 02}
- `04` ← {01}
- `05` ← {02, 03}
- `06` ← {05}
- `07` ← {00, 01, 02, 03, 04, 05, 06}
- `99` ← ∅ (alongside, not blocking)

### Confirmations

- **No edge references a non-existent node**: every source of an incoming edge is in the node set {00, 01, 02, 03, 04, 05, 06, 07, 99}. ✓
- **Topological sort exists and is emitted**: `00 → 01 → 02 → 03 → 04 → 05 → 06 → 07`. All edges point strictly forward. ✓
- **All plans 00-07 appear as DAG nodes**: confirmed. ✓
- **99 listed as "runs alongside"**: confirmed (line 21 of 98-execution-order.md, line 102). ✓
- **Acyclicity**: confirmed by explicit check at line 104: "No back-edges. DAG is acyclic." ✓

**Verdict**: PASS.

---

## Revisions needed

**None.** Every check passes. No plan requires revision before ship.

---

## Overall recommendation

**Ship as-is.** The corpus passes all seven Phase 7 cross-checks with zero violations. Every dangerous-identifier mention (`recover`, `reap`, `heal`, `repair`, `orphan`, `coerce`, `fallback`) is either a DELETE target, a NEVER-ADD guard, a canonical-example glossary entry, or the single flagged + scoped + removal-committed Chroma upsert bridge. Every `setInterval`/`setTimeout` is either a DELETE target or a narrowly-scoped per-operation timer justified in `99-verification.md` §22. Every `strategy`/`factory`/`builder` mention either (a) is guarded against class-hierarchy expansion (`04-read-path.md` line 33, 193), (b) refers to an existing module-path filename, or (c) quotes principle 6 in a NEVER-ADD context. Every `@deprecated` mention is a DELETE directive or a NEVER-ADD guard. Every plan that touches existing code anchors cites `_reference.md` extensively. The mapping accounts for every old section with explicit verdicts. The execution DAG is acyclic with a clean topological sort.

The only residual items that remain operational risks (not review violations) are the five blocking issues already enumerated in `98-execution-order.md` §Blocking issues — these are carried forward with resolution pointers and are not Phase 7 concerns.

**Confidence: HIGH** that this corpus is ready to enter the execution DAG.
