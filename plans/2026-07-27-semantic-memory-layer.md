# Semantic Memory Layer (Episodes → Knowledge)

Date: 2026-07-27. Status: validated against external consensus (2026-07-28),
deltas integrated, ready for implementation. Branch: `feat/act-r-memory`.

External evidence base: `plans/2026-07-27-semantic-memory-layer-research.md` —
consensus of 8 primary sources (CoALA, Generative Agents, Mem0, A-MEM, Zep,
HippoRAG, MemGPT, McKenzie & Eichenbaum) with verbatim quotes, verdict on this
design, and three recommended deltas (DELETE verdict, bi-temporal timestamps,
mandatory source_id per verdict).

## Problem

All memory today is **episodic**: every observation is bound to a session and a
moment in time. Human memory gradually melts episodes into **semantic
knowledge** — durable facts with no episode attached ("this project runs on
Bun", "tests run via `bun test`", "the user prefers Russian"). claude-mem has
no such layer: the same fact is re-learned from episodes every session, and
context injection spends its budget on episode timelines instead of a compact
"what is known" block.

## Proposal

A second memory tier of **semantic facts** — short, durable, LLM-distilled
statements about a project/user, consolidated periodically from observations.

### Data model (migration v53)

New table `semantic_facts`:

| column | notes |
| --- | --- |
| `id` | PK |
| `project` | same scoping as observations |
| `kind` | `project_convention` / `architecture` / `environment` / `user_preference` / `decision_rationale` |
| `fact` | one sentence, self-contained, no session references |
| `source_observation_ids` | JSON array — provenance / audit trail |
| `reinforcement_dates`, `last_reinforced`, `relevance_count` | same ACT-R columns as observations (strength engine is reused as-is) |
| `superseded_by` | reconsolidation, same semantics as observations v52 (UPDATE verdict) |
| `invalidated_at` | tombstone for the DELETE verdict — the fact stopped being true with no successor; row stays (C3: never physically delete), drops out of injection/FTS like superseded rows |
| `valid_from`, `valid_to` | bi-temporal (Zep/Graphiti, delta D2): when the fact held true in the world, vs `created_at`/`invalidated_at` which track when the system learned it. `valid_from` defaults to the earliest source observation's date; `valid_to` set on UPDATE/DELETE. Reserved and populated cheaply now, enables "what did we believe at time X" later |
| `content_hash` | `SHA256(project + fact)[:16]`, UNIQUE per project — free dedup on insert |
| `created_at`, `created_at_epoch`, `updated_at_epoch` | system-time (t'created), complements the bi-temporal pair |

Facts do **not** decay out of injection by age (consensus C6). They leave only
via `superseded_by` (UPDATE — contradiction with successor), `invalidated_at`
(DELETE — stopped being true, no successor), or explicit user delete. Strength
decides order only when the block exceeds its cap.

### Consolidation job

Trigger: worker-side, after a session's summary is stored
(`ResponseProcessor` post-store hook), throttled per project:
`CLAUDE_MEM_CONSOLIDATE_MIN_INTERVAL_HOURS` (default 12) and
`CLAUDE_MEM_CONSOLIDATE_MIN_OBSERVATIONS` (default 20 new observations since
last run). Opt-in master switch `CLAUDE_MEM_CONSOLIDATION_ENABLED=true`
(default **off** — it costs one LLM call per run, same policy as the dedup
judge).

Input to the LLM: active facts for the project (capped, strongest first) +
new observations since the last consolidation (title/narrative/concepts).
Output (strict JSON, parsed defensively like the dedup judge):

- `ADD {kind, fact, source_ids}` — genuinely new knowledge;
- `UPDATE {target_fact_id, fact, source_ids}` — the world changed; the new
  fact text replaces the old one → old row `superseded_by` the new row,
  `valid_to` set, and the older half of its reinforcement dates transfers
  (existing `supersedeObservation` generalized over both tables);
- `DELETE {target_fact_id}` — the fact simply stopped being true with no
  successor (delta D1, Mem0) → tombstone via `invalidated_at` + `valid_to`,
  never physical removal (C3);
- `NOOP` — episodes added nothing durable.

**Fact-gate (delta D3):** the verdict parser mechanically rejects any
ADD/UPDATE verdict carrying zero `source_ids` — exactly how Generative Agents
constrain reflections to cited evidence. A hallucinated fact with no
provenance fails parsing the same way malformed JSON does.

The prompt instructs: facts must be session-agnostic, atomic, and phrased as
standing truths ("tests run via `bun test`", never "in session X we fixed…").

### Injection

`ContextBuilder` gains a `## Project Knowledge` block rendered **above** the
observations timeline: up to `CLAUDE_MEM_FACTS_INJECT_COUNT` (default 15)
active facts — `superseded_by IS NULL AND invalidated_at IS NULL` — strongest
first, one line each (~300–500 tokens total). Facts surfaced this way get
`recordSurfaced` (β-term), identical to observations.

### Retrieval

- MCP: new tool `facts` (list active facts, ~30 tokens/line) + `fact_ids` in
  `get_observations` responses stay untouched; facts are recallable by id via
  `get_facts(ids)` which fires `recordRetrieved` (retrieval practice, same as
  observations).
- Search: facts join the FTS5 index (own virtual table) so `search` can
  return fact hits alongside observations (marked `kind: fact`).

### What this is NOT

- Not a replacement for episodes: observations remain the evidence base;
  facts carry `source_observation_ids` back to them.
- Not per-prompt: consolidation is session-granular and throttled — prompt
  latency is unaffected.
- Not on by default: zero LLM cost until explicitly enabled.

## Implementation outline

1. Migration v53 + `SemanticFactStore` (insert with content-hash dedup,
   supersede, strength columns — mirrors the observations helpers).
2. `src/services/reinforcement/consolidation.ts` — prompt build + verdict
   parse (pure, unit-testable) and `consolidation-judge.ts` — SDK call,
   throttle checks, apply verdicts (mirrors `dedup.ts` / `dedup-judge.ts`
   split).
3. `ResponseProcessor` post-store trigger (best-effort, all failures logged
   and swallowed).
4. `ContextBuilder`/`ObservationCompiler` — facts block + cap.
5. MCP tools `facts` / `get_facts` + FTS table.
6. Tests: migration, store (dedup/supersede/strength), verdict parsing,
   throttle logic, injection block, MCP handler.
7. Docs: `docs/public/configuration.mdx` — new settings keys.

## Open questions

- Cross-project facts (user preferences are arguably global): v1 keeps
  `project` scoping with a reserved `__global__` project value; promotion to
  global is a later decision.
- Whether consolidation should also *shrink* episodes (archive old
  observations once their knowledge is distilled): deferred — soft decay
  already handles surfacing; deletion is a separate policy decision.
