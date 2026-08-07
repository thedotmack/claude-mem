# Memory Grounding — anti compounding-fiction (observer hardening + echo detection + groundedness metric)

Date: 2026-08-05. Status: approved by user (layers 1-3), ready for implementation.
Branch: `feat/memory-grounding`. Protocol: 1 task = 1 branch = 1 PR.

## Problem (user's framing)

Reconsolidation without an external reality check is toxic: the agent writes its
own reconstruction to memory, reads it next session as confirmation, builds the
next layer on top — compounding fiction ("it worked today" → memory → "it
reliably works" → confident report about an unverified system). Our audit
(`plans/2026-07-31-memory-review-audit.md`) already caught the entry vector
live: the observer records intent as fact ("is expected to return…", "While
preparing to…"), reinforcement is truth-blind by construction, and injected
memory shapes new observations (experience-following, review C10).

## Layer 1 — Observer hardening (write-side)

`src/sdk/prompts.ts` (observation prompt): an observation is written ONLY when
anchored to a concrete reality artifact — command output, exit code, diff,
error text, file content. Intent/expectation without an outcome ("expected
to…", "preparing to…", "about to…") is not an observation. When no artifact
exists yet, stay silent. Facts field must quote the artifact (path, command,
status), not paraphrase intent.

## Layer 2 — Echo detection (the compounding loop breaker)

The dedup judge cannot currently tell "the world re-confirmed the fact" from
"the agent retold its own memory". Rule:

A new observation B is an **echo** when ALL hold:
1. a semantically-near existing observation A exists (dedup FTS shortlist,
   same as today);
2. A was recently injected (new `last_surfaced` column, migration v55, updated
   by the existing recordSurfaced path in ContextBuilder);
3. B carries no new tool evidence (empty `files_read` AND `files_modified` —
   v1 proxy, documented as such).

Echo handling: B is **stored** (audit beats purity) but `reinforcement_dates`
stay NULL (no seed) and B is excluded from the ACT-R injection pool and from
dedup candidacy (same filter as superseded). Crucially, A is **not**
reinforced by B — memory can no longer confirm itself; only repetition from a
fresh tool event counts as world-confirmation.

## Layer 3 — Groundedness metric (memory-eval)

New command `bun scripts/memory-eval/run.ts groundedness`:
- % of active observations with tool evidence (non-empty files_read or
  files_modified);
- % of active semantic facts whose ALL source observations have tool evidence;
- % of echo-flagged observations over time (after layer 2 ships).
Read-only on the production DB; numbers go into the report file. Baseline first,
then re-measure after layers 1-2 have run for a while.

## Explicitly deferred

- Layer 4 verbatim log: RESOLVED as "rely on client transcripts" (Claude
  `~/.claude/projects/*.jsonl` + Kimi `~/.kimi-code/sessions/*/wire.jsonl` —
  verified both exist with full tool.call/tool.result pairs). Follow-up: store
  the transcript path on observations so provenance can reach the footage.
- Layer 5 (user-correction boost): user_prompt events as high-weight supersede
  candidates. Remembered in the todo tracker, not in this branch.
- LLM relevance filter for injection: pending user decision (quota cost).

## Acceptance

- Observer prompt diff visible; no observation-type schema changes.
- Migration v55 (`last_surfaced`) idempotent, like v50-54.
- Echo rules covered by unit tests (each of the 3 conditions separately,
  storage-without-seed, exclusion from injection and dedup).
- `groundedness` prints baseline numbers from the live DB (read-only).
- Full suite green, tsc clean, bundle rebuilt.

## Postscript: the lesson that proved the point (2026-08-07)

While debugging the GPU-query case the operator (me, Kimi) twice explained
memory behavior from unmeasured intuition ("90% of the corpus is memory-work",
"the project pool is memory-heavy") — both wrong; the actual corpus is 6.2%
claude-mem-dev, and project `search` held the RTX 3090 series all along. The
real bug (platformSource where-filter on the semantic path) was found only
after querying the database instead of narrating.

This is exactly the compounding-fiction failure this document addresses —
confident reconstruction without checking the artifact of reality. Rule,
recorded for every future session that reads this file:

1. Before explaining system behavior, query the artifact (DB, logs, running
   process) first. No artifact, no claim.
2. Never invent distributions, percentages, or counts — measure them.
3. Label every statement "verified" or "assumption"; an assumption is a
   starting point for a check, never an answer.

The fix landed in PR #5 (semantic path honors the unified-memory setting).
