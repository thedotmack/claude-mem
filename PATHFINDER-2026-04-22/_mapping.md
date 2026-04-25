# PATHFINDER-2026-04-22 Mapping

Section-by-section mapping from the old `PATHFINDER-2026-04-21/` corpus to the new `PATHFINDER-2026-04-22/` corpus. Every plan author cites this document to know what old content flows where, what mutates, what gets deleted.

**Verification date**: 2026-04-22. Produced by Phase 0 Agent A after full read of all 12 old plans + 9 supporting docs.

---

## Legend

- **KEEP** — flows into new plan as-is (or near-as-is)
- **REWRITE** — concept migrates but under cleaner principles
- **DELETE** — no longer needed (second-system effect, happy-path violation, obsolete)
- **SPLIT** — portions go to multiple new plans

---

## Old Plan 01: privacy-tag-filtering

| Old section | Verdict | New location |
|---|---|---|
| Overview | KEEP | `00-principles.md` §Fail-fast tag-stripping closure |
| Dependencies | KEEP | `03-ingestion-path.md` §Dependencies |
| Verified facts V7a-V7k | REWRITE | `03-ingestion-path.md` §Concrete findings (citing `_reference.md`) |
| Concrete target signatures | KEEP | `03-ingestion-path.md` §Phase 1 (single-regex alternation) |
| Phase 1: Write parseAgentXml | KEEP | `03-ingestion-path.md` §Phase 1 |
| Phase 1b: Update agent contract | KEEP | `03-ingestion-path.md` §Phase 1b |
| Phase 2: Replace parse path in ResponseProcessor | KEEP | `03-ingestion-path.md` §Phase 2 |
| Phase 3: Remove `consecutiveSummaryFailures` | KEEP | `03-ingestion-path.md` §Phase 3 |
| Phase 4: Verification sweep | KEEP | `03-ingestion-path.md` §Phase 4 |
| Blast radius | REWRITE | `03-ingestion-path.md` §Files modified (condensed) |

**Net**: ~135 LoC deleted, ~35 LoC added.

---

## Old Plan 02: sqlite-persistence

| Old section | Verdict | New location |
|---|---|---|
| Overview / Scope | REWRITE | `01-data-integrity.md` §Scope |
| Dependencies | KEEP | `01-data-integrity.md` §Dependencies |
| Verified facts | REWRITE | `01-data-integrity.md` §Concrete findings |
| Phase 1: Add `schema.sql` | KEEP | `01-data-integrity.md` §Phase 1 (fresh schema, constraints, triggers) |
| Phase 2: Add `chroma_synced` | KEEP | `01-data-integrity.md` §Phase 2 |
| Phase 3: Migrate to UNIQUE | KEEP | `01-data-integrity.md` §Phase 3 |
| Phase 4: Boot-once `recoverStuckProcessing` | **DELETE** | Violates "no recovery code" principle. Replaced by self-healing claim query in `01-data-integrity.md` §Phase 4. |
| Phase 5: WAL housekeeping deletion | KEEP | `01-data-integrity.md` §Phase 5 (rely on SQLite default `wal_autocheckpoint=1000`) |

**Net**: ~140 LoC source-only reduction, +~295 LoC for fresh `schema.sql`.

---

## Old Plan 03: response-parsing-storage

**Heavy overlap with Plan 01.** Plans 01 and 03 both define `parseAgentXml` and touch `ResponseProcessor`. Recommendation: **consolidate Plan 03's unique content (atomic TX, `summaryStoredEvent` wiring) into the new `03-ingestion-path.md`, delete Plan 03 as a standalone artifact.**

| Old section | Verdict | New location |
|---|---|---|
| Overview / Dependencies | KEEP | `03-ingestion-path.md` §Dependencies |
| Verified facts V7a-V7k | REWRITE | `03-ingestion-path.md` §Concrete findings (deduplicated with Plan 01) |
| Phase 1: parseAgentXml in parser.ts | **DELETE** | Duplicate of old Plan 01 Phase 1 |
| Phase 1b: Agent contract update | **DELETE** | Duplicate of old Plan 01 Phase 1b |
| Phase 2: Replace parse path | REWRITE | Merged into `03-ingestion-path.md` §Phase 2 (add `summaryStoredEvent` emission) |
| Phase 3: Remove `consecutiveSummaryFailures` | **DELETE** | Duplicate of old Plan 01 Phase 3 |
| Phase 4: Verification sweep | REWRITE | Merged with Plan 01 sweep into `03-ingestion-path.md` §Phase 4 |

---

## Old Plan 04: vector-search-sync

| Old section | Verdict | New location |
|---|---|---|
| Overview / Scope | REWRITE | `01-data-integrity.md` §Chroma sync |
| Dependencies | KEEP | `01-data-integrity.md` §Dependencies |
| All 6 phases | REWRITE | `01-data-integrity.md` §Phase 6-8 (one-doc-per-observation, upsert-not-delete, `chroma_synced` column, backfill at boot) |
| `getExistingChromaIds` `@deprecated` fence | **DELETE** | Violates "no dead code" principle. Gone in same PR. |

**Net**: ~320 LoC deleted, ~60 LoC added.

---

## Old Plan 05: context-injection-engine

| Old section | Verdict | New location |
|---|---|---|
| Overview | REWRITE | `04-read-path.md` §Unified rendering |
| Dependencies | KEEP | `04-read-path.md` §Dependencies |
| Four RenderStrategy classes | **DELETE** | Strategies collapse to ONE config object with four literals — violates "no speculative abstraction" principle |
| Phase 1: Create `renderObservations(obs, strategy)` | KEEP | `04-read-path.md` §Phase 1 (extract common walk, accept `RenderStrategy` config) |
| Phases 2-5: Delete old formatters, wire consumers | KEEP | `04-read-path.md` §Phases 2-5 |
| Phase 6: Verification | KEEP | `04-read-path.md` §Verification (byte-equality snapshot) |
| Phase 7: Prompt-caching cost note | REWRITE | `99-verification.md` §Cost smoke test gate |

**Net**: ~1,250 LoC deleted, ~320 LoC added.

---

## Old Plan 06: hybrid-search-orchestration

| Old section | Verdict | New location |
|---|---|---|
| Overview | REWRITE | `04-read-path.md` §Search consolidation |
| Dependencies | KEEP | `04-read-path.md` §Dependencies |
| Verified facts | REWRITE | `04-read-path.md` §Concrete findings |
| All 7 phases | KEEP | `04-read-path.md` §Phases 6-12 (delete `SearchManager.findBy*`, consolidate recency filter, route through `SearchOrchestrator`) |
| Silent-fallback to filter-only | **DELETE** | Violates "fail-fast" — Plan 04 §Phase 6 throws 503 on Chroma error |

**Net**: ~1,700 LoC deleted, ~40 LoC added.

---

## Old Plan 07: session-lifecycle-management — NEEDS REWRITE WHOLESALE

This is the plan that carried all the lifecycle debt. Almost every section maps to DELETE or REWRITE.

| Old section | Verdict | New location |
|---|---|---|
| Overview / Scope | REWRITE | `02-process-lifecycle.md` §Scope (lazy-spawn from hooks, process groups, no supervisor, no reapers, no idle-shutdown) |
| Dependencies | KEEP | `02-process-lifecycle.md` §Dependencies |
| Concrete findings (ProcessRegistry, SessionManager) | REWRITE | `02-process-lifecycle.md` §Concrete findings |
| Mechanism A: Exit handlers | KEEP | `02-process-lifecycle.md` §Mechanism A (retains `child.on('exit')` as authoritative) |
| Mechanism B: Per-session `abandonedTimer` setTimeout | **DELETE** | Polling loop in timer clothing. Replaced by synchronous cleanup in `generatorPromise.finally` |
| Mechanism C: Boot-once reconciliation block | **DELETE** | `recoverStuckProcessing`, `killSystemOrphans`, `pruneDeadEntries`, `clearFailedOlderThan` — all violate "no recovery code" |
| Phase 1: Ingest helpers | SPLIT | Helpers (`ingestObservation`, `ingestPrompt`, `ingestSummary`) move to `03-ingestion-path.md` §Phase 0 (prerequisite) |
| Phase 2-7: Process lifecycle | REWRITE | `02-process-lifecycle.md` §Phases 1-8 |
| Phase 8: Verification | KEEP | `02-process-lifecycle.md` §Verification (zero setInterval grep, process-group kill test) |

**Net**: ~900 LoC deleted, ~400 LoC added, massive cleanup of second-system content.

---

## Old Plan 08: transcript-watcher-integration

| Old section | Verdict | New location |
|---|---|---|
| All content | KEEP | `03-ingestion-path.md` §Phases 5-9 (recursive `fs.watch`, `pendingTools` → DB UNIQUE, HTTP loopback → direct `ingestObservation`) |

**Net**: ~161 LoC deleted, ~75 LoC added.

---

## Old Plan 09: lifecycle-hooks

| Old section | Verdict | New location |
|---|---|---|
| Overview / Scope | REWRITE | `05-hook-surface.md` §Scope (10 endpoints → 4, cache alive once, blocking `/api/session/end`) |
| Endpoint reality check | KEEP | `05-hook-surface.md` §Endpoint inventory |
| Hook → endpoint mapping | KEEP | `05-hook-surface.md` §Mapping table |
| Phase 1-7: Delete legacy endpoints, consolidate | KEEP | `05-hook-surface.md` §Phases 1-7 |
| Summarize polling loop | **DELETE** | Violates "fail-fast" — `05-hook-surface.md` §Phase 3 replaces with blocking endpoint |
| Shell retry loops in hooks.json | **DELETE** | Violates DRY + "no retry in hooks" — `05-hook-surface.md` §Phase 1 deletes them |

**Net**: ~487 LoC deleted, ~25 LoC added.

---

## Old Plan 10: knowledge-corpus-builder

| Old section | Verdict | New location |
|---|---|---|
| All content | KEEP | `04-read-path.md` §Phases 13-18 (delete session_id, delete prime/reprime auto-reprime regex, rewrite /query with systemPrompt) |

**Net**: ~228 LoC deleted, ~30 LoC added.

---

## Old Plan 11: http-server-routes

| Old section | Verdict | New location |
|---|---|---|
| Overview | REWRITE | `06-api-surface.md` §Scope (Zod middleware, delete rate limiter, cache static files) |
| Anti-patterns | KEEP | `06-api-surface.md` §Anti-patterns |
| Phase 1: Zod dependency | KEEP | `06-api-surface.md` §Phase 1 (preflight: `npm install zod@^3.x`) |
| Phase 2-8: validateBody middleware, schemas, cache, oversize, verification | KEEP | `06-api-surface.md` §Phases 2-8 |
| Diagnostic endpoint deletions | SPLIT | `/api/pending-queue/*` deletions move to `06-api-surface.md` §Phase 9 |

**Net**: ~180 LoC deleted, ~60 LoC added.

---

## Old Plan 12: viewer-ui-layer

| Old section | Verdict | New location |
|---|---|---|
| Plan type (lockdown/regression) | KEEP | `99-verification.md` §Viewer lockdown |
| Phases 1-6: Inventory, invariants, regression tests | KEEP | `99-verification.md` §Phases 1-6 |

**Net**: 0 LoC source change; 12 regression artifacts under `tests/viewer-lockdown/`.

---

## Supporting documents

| Old file | Verdict | New location |
|---|---|---|
| `00-features.md` | KEEP as audit trail | Archive to `PATHFINDER-2026-04-21/_archive/` (reference only) |
| `02-duplication-report.md` | KEEP as audit trail | Archive |
| `03-unified-proposal.md` | KEEP as audit trail | Archive |
| `04-handoff-prompts.md` | REWRITE | Becomes per-plan "how to run this" blocks in each new plan |
| `05-clean-flowcharts.md` | KEEP as source of truth | Flowcharts cited by new plans; file itself archived |
| `06-implementation-plan.md` Phase 0 (V1-V20) | KEEP | Merged into `_reference.md` |
| `06-implementation-plan.md` Phases 1-15 | **DELETE** | Superseded by per-plan structure |
| `07-master-plan.md` | REWRITE | Becomes `98-execution-order.md` |
| `08-reconciliation.md` | REWRITE | Merged into `98-execution-order.md` |
| `09-execution-runbook.md` | REWRITE | Merged into `98-execution-order.md` (DAG + preflight + post-landing grep) |

---

## Orphan content

**Archive `PATHFINDER-2026-04-21/` wholesale once the new corpus lands.** No orphans — every section either maps to a new plan or goes to the archive. If the new corpus passes Phase 7 principle-cross-check, the old directory becomes pure history.

---

## Cross-plan coupling points

| Shared invariant | Owner (new corpus) | Consumers |
|---|---|---|
| `stripMemoryTags` single-regex | `03-ingestion-path.md` §Phase 1 | All ingestion paths |
| `ingestObservation`/`ingestPrompt`/`ingestSummary` helpers | `03-ingestion-path.md` §Phase 0 | Transcript watcher, hook handlers, worker routes |
| `chroma_synced` column + boot-once backfill | `01-data-integrity.md` §Phase 2 | Chroma sync module |
| `UNIQUE(session_id, tool_use_id)` | `01-data-integrity.md` §Phase 3 | `PendingMessageStore`, transcript processor |
| `summaryStoredEvent` emission | `03-ingestion-path.md` §Phase 2 | `05-hook-surface.md` §Phase 3 (blocking endpoint awaits this event) |
| `renderObservations(obs, strategy)` | `04-read-path.md` §Phase 1 | All formatters, search results, corpus detail |
| `RECENCY_WINDOW_MS` constant | `types.ts:16` (already exists; consolidation in `04-read-path.md` §Phase 3) | Every search/filter call site |
| Process-group spawn + `kill(-pgid)` | `02-process-lifecycle.md` §Mechanism A | `ProcessRegistry` (deleted), `supervisor/process-registry.ts` (kept) |
| Zod schemas + `validateBody` middleware | `06-api-surface.md` §Phase 2 | All POST/PUT route handlers |

---

## Gaps to resolve before plan authoring

1. **Plan 01 / Plan 03 overlap** — new `03-ingestion-path.md` must merge their unique content cleanly. Authoring checkpoint: one `parseAgentXml` definition, one `ResponseProcessor` modification path.
2. **Plan 07 Phase 1 co-ownership** — ingest helpers land BEFORE `03-ingestion-path`'s other phases. Mark as Phase 0 of `03-ingestion-path`.
3. **Prompt-caching cost smoke test** — gate before `04-read-path` knowledge-corpus phases land. Verification lives in `99-verification.md`.
4. **`engines.node >= 20.0.0` bump** — preflight for `03-ingestion-path` recursive `fs.watch`.
5. **`npm install zod@^3.x`** — preflight for `06-api-surface` Zod middleware.
6. **Chroma upsert fallback flag** — `01-data-integrity.md` §Chroma must gate behind a flag documented here.

---

**Status: READY FOR CORPUS AUTHORING.** Every new-plan author knows their scope, sources, and cross-plan couplings.
