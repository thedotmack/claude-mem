# [plan-09] Data-Pipeline Integrity & Migration Transparency — stop "healthy worker, frozen observations"

## Defect

The worker can report healthy while data silently fails to reach or be retrievable from the store, and the failures are swallowed so distinct root causes present identically. Session identity is stamped inconsistently across the live-observer / re-sync / manual paths; generated summaries and observations are not stamped with the originating content_session_id at write time; `EXCLUDED_PROJECTS` is honored on capture but not in the Stop hook so excluded projects still get summaries; the FTS5 index omits the `type` column so a type-token conjunction returns zero; and manual memory-write tools are blocked in the worker runtime. The fix is a verified, consistent write-and-read contract: stamp identity once at write time on every path, apply exclusion uniformly, index every queryable column, and keep the manual write tools functional.

## Children

- #2769 — Stamp originating content_session_id onto generated session_summaries/observations at write time
- #2772 — Chroma `memory_session_id` holds the content session id on the live-observer path (inconsistent with re-sync/manual)
- #2767 — `EXCLUDED_PROJECTS` does not block the Stop hook — summaries still generated for excluded projects
- #2729 — FTS5 conjunction with type-token returns 0 (`type` column not in the search index)
- #2705 — Manual memory-write tools (`observation_add` / `memory_add`) blocked in the worker runtime

## Fix sequence

Design doc: `plans/09-data-pipeline-integrity.md`. Stamp content_session_id at write time on all three paths; apply EXCLUDED_PROJECTS in the Stop hook; add `type` (and other queried columns) to the FTS5 schema with a migration; re-enable the worker-runtime write tools; assert the field→column→trigger chain.

## Test matrix

| Path | Required behavior |
|---|---|
| live observer / re-sync / manual | identical content_session_id stamping |
| excluded project | Stop hook generates nothing |
| search `type:bugfix` + token | returns matching rows |
| worker runtime | observation_add / memory_add succeed |

## Out of scope

Observer output validity (plan-11); grammar/parse coverage (plan-13).
