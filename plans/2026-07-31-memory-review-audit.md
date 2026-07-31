# Audit: claude-mem-dev vs "What the Evidence Supports" (Agent Memory Review 2026)

Date: 2026-07-31. Status: audit complete, action plan active. Branch: `feat/act-r-memory`.

Inputs (verified-neutral literature review, 81 sources, fact-gated):
- `plans/2026-07-31-agent-memory-review.md` — consensus C1–C13, demotions D1–D8, reference architecture, evaluation rules
- `plans/2026-07-31-corpus-table.csv`, `plans/2026-07-31-mechanism-matrix.csv`, `plans/2026-07-31-evidence-ledger.csv`

Audit method: each C-finding and each reference-architecture component checked against the
implementation on this branch (ACT-R reinforcement, reconsolidation, semantic layer,
Kimi integration). This is the local audit promised when the neutral review was commissioned.

## Verdict in one paragraph

The fork's core bets are the ones the evidence endorses — ACT-R base-level activation is the
ONLY cognitive result the review promotes to "cleanly transferable" (C13), retrieval-triggered
reweighting is the only mechanism that makes the testing effect applicable to a text store,
and mechanical provenance + non-destructive invalidation place us ahead of every system in
the corpus. The real gaps are: no verbatim episodic log, no explicit deletion policy, no
metrics harness, and a decay constant we imported instead of fitting.

## Where we are ahead of the field

| Capability | Review position | Our status |
| --- | --- | --- |
| ACT-R `Bi = ln(Σ tj^−d)` ranking | "The one cognitive result that transfers cleanly" (C13); score, don't erase (C3) | Implemented (`strength.ts`), retrieval-side only, no deletion by decay |
| Retrieval rewrites the item | Testing effect applies to text stores ONLY if retrieval rewrites/reweights (Open problems) | `recordRetrieved` appends a reinforcement date on every `get_observations` fetch |
| Mechanical provenance gate | Only 3/7 systems store source pointers; NONE uses them for audit (C4) | Consolidation verdicts without `source_ids` are rejected by the parser (D3 from the semantic-layer research) |
| Non-destructive invalidation + bi-temporal | Reference architecture prefers validity-interval tombstones; "described divergence, no comparative evidence" | `superseded_by` + `invalidated_at` + `valid_from/valid_to` on facts (v52/v53) |
| Cost framing | "Memory's measured benefit is cost, not accuracy" (C8) | Injection header already reports token savings (83–96%) |
| Write vocabulary | ADD/UPDATE/DELETE/NOOP de facto standard (C5), LLM judge as decider (C6) | Exactly this, from the semantic-layer consensus research |

## Gaps and required changes

### G1. No verbatim episodic log (biggest divergence)

Reference component #1: append-only verbatim log; storing only model-generated prose inherits
misattribution/suggestibility/present-state-bias with no fallback (C1, Schacter). Our raw tool
events are discarded after the observer compresses them (pending queue is cleared).
Partial mitigation: client-side transcripts (`~/.claude/projects/*.jsonl`) persist verbatim
records outside our system. Decision needed: store raw events ourselves or formally delegate
verbatim storage to client transcripts and document the reliance.

### G2. No explicit deletion policy

Harvard/ACL-2026 (C10): periodical frequency-threshold deletion yields large size reduction at
<2% accuracy cost; selective-add + delete beats naive growth by 10% absolute. We have
selective-add (dedup judge) and DELETE only on semantic facts; observations live forever.
Review rule: deletion is a SEPARATE explicit policy, never a decay side-effect (C3).
Action: implement frequency/age-threshold deletion for observations, opt-in, with audit log.

### G3. Decay constant imported, not fitted

Review (C13): "fit d to your own access logs; do not import 0.5 as a constant."
`CLAUDE_MEM_REINFORCE_POWER_D` is already env-configurable — what is missing is the fitting
procedure. Action: part of the metrics harness (H below) — fit d from real retrieval logs.
Note: repo check found no Ebbinghaus references in `src/`, `docs/`, or prior `plans/` —
`strength.ts` already cites Anderson & Schooler. No relabeling needed in-repo.

### G4. Experience-following risk in semantic injection

C10's failure mechanism: high input similarity to a retrieved record makes the agent replay it,
propagating errors. Our per-prompt semantic inject should carry a relevance floor.
Action: add `CLAUDE_MEM_SEMANTIC_INJECT_MIN_SCORE` (default conservative), drop sub-threshold hits.

### G5. Erasure semantics incomplete

Review: invalidation and hard deletion are DIFFERENT operations, both required. Our delete
endpoints do not cascade to superseded/invalidated rows.
Action: hard delete of an observation/fact also removes rows tombstoned BY it.

### G6. Untrodden ground we can own

- Provenance audit surface ("where did this belief come from") — zero systems in the corpus do it; ours is mechanically guaranteed already. Action: MCP `fact_provenance(id)` → fact + source observations chain.
- Temporal belief queries ("what did I believe at time X") — bi-temporal columns exist on facts; needs a query endpoint. Action: `valid_from/valid_to` filter on the facts API.
- Erasure/provenance as testable capabilities — no benchmark in the corpus measures either; our harness (H) includes them as first-class tests.
- Per-type decay rates — the review confirms NO source measures this ("finding, not gap"). Our deferred feature is a legitimately open problem; only do it inside the harness with measurement, never as an assertion.

## H. Metrics harness (build before further features — review rule: "build the harness before the system")

Location: `scripts/memory-eval/`. Data: the real production DB (~40 projects, thousands of
observations + facts — rule 9: real logged interaction beats synthetic benchmarks).

Harness requirements, mapped to the review's nine evaluation rules:

1. **Baselines always reported**: recency-only ranking (= upstream behavior) vs ACT-R ranking; FTS-only vs hybrid retrieval. Full-context baseline is N/A per-query at our scale, but the "recent block" (no retrieval) IS our full-context proxy — report it.
2. **Cost as a first-class axis**: tokens injected per query for every configuration.
3. **Declared scoring target**: observation/fact IDs, gold set built from real session linkage (observations created in the same session as a past user prompt are candidates; relevance confirmed by LLM judge on a sample) — written down in the harness README.
4. **Two metrics, disagreement reported**: lexical hit-rate@k AND LLM-judge relevance@k.
5. **Saturation check**: how often the no-retrieval recent block already contains the answer (if high, the eval can't discriminate designs).
6. **Non-conversational streams**: our queries are coding sessions, not LoCoMo chat — this is inherent; keep a non-coding control set to avoid overfitting to one domain.
7. **Mutation/obsolescence tests**: plant a contradicted fact, verify the superseded original stops surfacing and the successor inherits ranking.
8. **Erasure/provenance capability tests**: delete a fact → demonstrate absence; ask provenance of a fact → verify pointer chain resolves.
9. **Real data only**: no synthetic benchmark import; LoCoMo-style sets explicitly out.

First harness deliverable: fit `d` (G3) and measure ACT-R-on vs ACT-R-off (G1 of our earlier
queue) on the same gold set — that single experiment answers "is our ranking better than
upstream recency" with numbers, not intuition.

## Action queue (supersedes the older "association boost + metrics" item)

1. Metrics harness per §H (includes: fit d, ACT-R on/off, e5 A/B when e5 lands).
2. e5 embedding migration per `plans/2026-07-29-e5-embedding-migration.md` (unchanged; harness measures it).
3. Deletion policy (G2) + erasure cascade (G5).
4. Semantic-inject relevance floor (G4).
5. Provenance audit + temporal query API (G6).
6. Verbatim log decision (G1) — needs the user's call.
7. Per-type decay — only via harness measurement (G6).
