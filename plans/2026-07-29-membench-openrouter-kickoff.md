# MemBench — Handoff Doc

**Purpose:** everything a fresh Claude Code session needs to build MemBench.
Written 2026-07-29, revised to center the fork-and-measure loop below.

---

## 1. The core loop (this is the benchmark)

> Take a transcript. Run claude-mem through it — parallel-hit all the models to get
> every observation-set variant. Fork the session, perform a task, and see how many
> tokens were used to perform that task, and whether the task was done successfully
> or not.

Concretely, per corpus item:

```
                          ┌─ model A ─→ observations_A ─→ fork ─→ task ─→ {tokens_A, success_A}
transcript ─→ obs prompt ─┼─ model B ─→ observations_B ─→ fork ─→ task ─→ {tokens_B, success_B}
   (one)      (parallel)  ├─ model C ─→ observations_C ─→ fork ─→ task ─→ {tokens_C, success_C}
                          └─ controls ──────────────────→ fork ─→ task ─→ {tokens_∅, success_∅}
```

1. **Transcript in.** A real working session (repo state pinned at the commit the
   session ended on).
2. **Parallel observation generation.** The same transcript + the production
   observation prompt (`src/sdk/prompts.ts`) hits every candidate model via
   OpenRouter concurrently. Each model yields its observation-set variant.
3. **Fork the session.** For each variant: a fresh executor session on the same repo
   at the same pinned state, with that variant injected in claude-mem's normal
   context format (`/api/context/inject` shape). Same task prompt for every fork.
4. **Perform the task.** Executor runs to completion, uninterrupted.
5. **Measure two things.**
   - **Tokens used** to perform the task (input + output; cost in dollars alongside).
   - **Task success** — done or not, against a per-task, pre-written, mechanically
     checkable definition wherever possible (tests pass / behavior present), judge
     call only where it can't be mechanical.

The claim being tested: better observations → the fork finishes the same task with
fewer tokens and/or higher success. The independent variable is *which model wrote
the memory*; everything else is identical across forks.

**Controls per corpus item (these make the numbers mean something):**
- **No-memory fork** — the floor. Every model's tokens/success is read against this.
- **Oracle fork** — hand-written ideal notes; the ceiling. "Model X captured 71% of
  the oracle's token savings" is the calibrated headline.
- **Shuffled fork** — observations from a *different* transcript, to prove effects
  come from content, not from "any plausible context primes the executor."

Replication: executors are stochastic — k runs per fork (k≥3), report mean ± spread.

## 2. What ships (the runnable benchmark)

The deliverable is not a report — it's a **runnable artifact**: transcripts, tasks,
and the harness, such that anyone (including Alex Atallah's team) can execute the
whole thing and reproduce the table.

- **Corpus:** `corpus/<item-id>/` containing `transcript.*` (sanitized session),
  `repo.lock` (repo URL + pinned commit), `task.md` (the task prompt), `success.md`
  or `check.sh` (the pass/fail definition), provenance notes. Versioned and frozen
  (content-hashed) per release.
- **Harness:** one command runs the loop end-to-end —
  generate variants (parallel, OpenRouter) → build forks → run tasks → emit
  `results.jsonl` (one row per fork-run: item, model, run, tokens_in/out, cost_usd,
  success, duration) + `summary.json` → render the scoreboard table.
- **Artifacts per run:** every fork's full transcript and diff retained, so any
  number can be audited down to the run that produced it.
- Package shape: `membench/` in this repo, mirroring `swebench/`'s conventions
  (Bun + TS, zero runtime deps, mock-provider offline tests, JSONL artifacts).

## 3. Metrics

**Primary (the scoreboard):**
| Per model | Meaning |
|---|---|
| Success rate | share of fork-runs completing the task, vs no-memory floor |
| Tokens to done | mean tokens on successful runs, vs floor and oracle |
| % of oracle savings | (floor − model) / (floor − oracle) on tokens |
| Cost | real dollars (OpenRouter `usage.cost`) — observation-side and execution-side |

**Diagnostics (recorded, never headlined):** observation count, observation tokens,
parse/structure notes, turns, per-task breakdowns. Count and value are different
metrics — count is a covariate here, full stop. XML/structure adherence is plumbing:
if a model can't emit parseable observations from the prompt alone, use provider
structured-output/JSON modes so its *content* competes anyway, and report the
accommodation per row.

## 4. Corpus sourcing (transcripts and tasks)

- **Transcripts:** claude-mem's own DB (`~/.claude-mem/claude-mem.db`) and Claude
  Code transcript files — real sessions, sanitized (secrets/PII) before freezing.
- **Tasks:** strongest source is **hindsight** — pick transcript/task pairs where the
  *actual next session* on that project defines the task ("the future already
  happened"), which kills task-authorship bias. Where the DB lacks a clean pair,
  author the follow-up task but derive it from the repo's real next commit/issue
  when possible. Every task states its success check at authoring time, before any
  model runs.
- Start small (5–10 items) to shake out the harness and produce Alex's cost numbers;
  grow the corpus once the loop is proven.

## 5. Partnership context (facts)

- **Alex Atallah (OpenRouter co-founder) is donating credits** (X DM, Jul 26). His
  asks: (1) **cite OpenRouter** in what's published; (2) **a cost estimate** — owed,
  first deliverable. The loop makes this concrete: cost per corpus item =
  N_models × (observation pass) + (N_models + 3 controls) × k runs × (executor pass).
  Run 2–3 items end-to-end, read real `usage.cost` off every call, extrapolate, and
  price the executor side both ways (through OpenRouter vs Claude Code defaults).
- Strategic timing: Stripe reportedly exploring a ~$10B OpenRouter acquisition
  (PYMNTS 2026).
- Positioning: recall benchmarks (LongMemEval, LoCoMo) test finding planted facts.
  MemBench tests whether the right things get written down and whether they make
  future work cheaper and more successful. Different category; claude-mem is uniquely
  positioned — it has real consecutive-session production data, a production
  injection pipeline, and 50M+ sessions of fleet telemetry to corroborate lab
  numbers.

## 6. Candidate model pool (via OpenRouter)

`anthropic/claude-sonnet-4-6` · `anthropic/claude-haiku-4-5` (fleet-dominant, ~66%
of sessions) · `qwen/qwen3.6-27b` · `deepseek/deepseek-v4-flash` (fleet
over-performer) · `openai/gpt-oss-20b`/`120b` · `xiaomi/mimo-v2-flash:free`
(current claude-mem OpenRouter default — 0% observer success in fleet data, so
benchmarking it is also a product decision). Optionally 1–2 locally-served models
for the constrained-decoding comparison. Pool, not a locked slate.

## 7. Assets and constraints

- **Use production surfaces, don't reimplement:** observation prompt
  (`src/sdk/prompts.ts`), parser (`src/sdk/parser.ts`), OpenRouter provider
  conventions (`src/services/worker/OpenRouterProvider.ts`), injection format
  (`/api/context/inject`).
- **Reusable infra:** `swebench/` package on this branch — standalone OpenRouter
  client with retry + real `usage.cost` capture, config resolution, process runner,
  JSONL artifact pattern, mock-provider offline test pattern. Same package shape for
  `membench/`.
- **This remote environment blocks `openrouter.ai` and `huggingface.co`** (proxy 403),
  no Docker. Build + offline-test here; all live inference (including the cost
  probe) runs on a networked machine with the claude-mem worker up.
- **Telemetry corroboration sources** (never score, only corroborate):
  `observer_turn_rollup` (correct per-session source), `session_compressed` (fires
  per pipeline *operation*, not per session — analysis trap, don't repeat),
  `context_injected` (`tokens_saved_vs_naive`). Known caveats: ~20% field coverage
  on counts, ~13% `unknown` model attribution, model-name fragmentation needs a
  normalization map.

## 8. Design notes that informed the loop (background, not binding)

A sequential-thinking pass played five designs through end-to-end (full analysis in
this file's git history, commit `743946e`; older spec drafts in `plans/membench/` —
reference material from a stressed session, not the plan). What survived and is
folded in above: hindsight task-sourcing beats authored tasks; executor runs are the
binding cost → a cheap **memory-only probe** (can an agent holding *only* the
observation set answer what the task needs? scored correct/absent/**misleading**) is
available as a screening layer before expensive fork runs and as a mechanism
explainer; **misleading memory** (fabricated note → executor trusts it → wrong
output) is worth tracking as a first-class outcome; multi-session compounding chains
are the flagship *second* experiment once the single-fork loop separates models.

## 9. Integrity commitments

1. Every published number reproducible from the open harness + corpus.
2. All results published, **including where Claude models lose.**
3. No silent metric or corpus changes; versioned everything.
4. OpenRouter cited.

---

### Paste-ready kickoff prompt for the new session

> Read `plans/2026-07-29-membench-openrouter-kickoff.md`. Build the §1 loop as a
> runnable benchmark per §2: `membench/` package mirroring `swebench/` conventions —
> corpus format, parallel observation generation via OpenRouter, session forks with
> injected variants + the three controls, task execution, `results.jsonl` +
> scoreboard. Offline-test everything with mock providers (live inference happens on
> my machine, not in this environment). Start with a 5-item corpus sourced per §4.
> First deliverable after the harness dry-runs: the cost-estimate table for Alex
> Atallah (§5), priced both executor-routing ways. Surface decisions needing my
> input as you hit them.
