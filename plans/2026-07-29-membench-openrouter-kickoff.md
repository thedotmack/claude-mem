# MemBench × OpenRouter — What We're Benchmarking

**Purpose of this doc:** give a fresh Claude Code session everything it needs to design
and build MemBench from a clean slate. Written 2026-07-29, revised same day after
refocusing on the value question and playing the tape through five candidate designs
(sequential-thinking pass, 8 thoughts).

**Framing note:** prior design drafts exist at
[`plans/membench/membench-spec-v0.2.md`](membench/membench-spec-v0.2.md) and
`membench-spec-v0.1.md`. They came out of a long, stressed design session — treat them
as **reference material, not the plan.** This doc defines *what we measure and why*,
plus five candidate experimental designs with their tapes played through. It
deliberately does **not** commit to a methodology, sequencing, or thresholds — that's
the fresh-eyes session's job.

---

## 1. THE question

> "I really want to see how different sets of observations made by the different
> models affect the quality of future output. Observation count doesn't tell us that
> story empirically." — Alex (Newman), 2026-07-29

The benchmark's independent variable is **which model wrote the observation set**.
The dependent variable is **the quality of a future session's output** when that set
is injected. Everything else — executor, task, repo state, injection format — is held
constant or explicitly controlled.

Two clarifications that reshape earlier drafts:

- **Observation count and observation value are different metrics.** Count (yield) is
  an input-side property and at most a covariate. It appears in §4 as a diagnostic,
  never as a headline.
- **XML/structure adherence is demoted to plumbing.** It's real (and it saves users
  tokens, and it's the anecdote that started this — it was mentioned to Alex Atallah
  as an example of what the telemetry can teach), but it is not what we're
  benchmarking. If a model can't emit parseable observations from the prompt alone,
  we may use provider structured-output/JSON modes to get its *content* onto the
  field anyway — we're measuring what a model *notices and writes down*, not its tag
  discipline. Any serving accommodation is reported per row.

Why claude-mem is uniquely positioned to run this (confirmed repeatedly while playing
the tapes): (a) it's the only system holding **real consecutive-session production
data** — session N's transcript *and* what the user actually did in session N+1;
(b) it has a **production injection pipeline** to run futures through, so the
benchmark exercises the real product surface; (c) it has **fleet telemetry** to
corroborate lab numbers at 50M+ session scale.

## 2. Partnership context (facts)

- **Alex Atallah (OpenRouter co-founder) is donating OpenRouter credits** (X DM,
  Jul 26). His asks: (1) **cite OpenRouter** in what gets published; (2) **a cost
  estimate** — owed, first deliverable. It must contain per-model observation-
  generation cost per session and a projected total for the chosen design matrix
  (executor inference priced both through-OpenRouter and on-Claude-Code-defaults).
- Strategic urgency: Stripe reportedly exploring a ~$10B OpenRouter acquisition
  (PYMNTS 2026). A published, citable, OpenRouter-powered benchmark lands at the
  right moment.
- Category positioning: recall benchmarks (LongMemEval, LoCoMo, needle-in-haystack)
  test *finding planted facts*. MemBench tests whether the right things get *written
  down* and whether they make *future work better*. Different question; no overlap;
  claude-mem doesn't compete on perfect recall and says so loudly.

## 3. Candidate experimental designs — five tapes, played through

Each design answers: where do "futures" come from, what is "output quality"
concretely, what does one datum look like, and where does the tape snag. A structural
finding from playing them: the design space factors into **(futures source) ×
(output measure)** — so these compose rather than compete.

### A. Authored follow-up task pairs

**Tape:** Take a real session (e.g. "debugged Chroma sync on Windows, found uv path
quoting bug, decided to pin uv 0.8.x"). Author the follow-up task a returning
engineer would do ("extend the fix to WSL"). Per model X: X observes session 1 →
observation set `Ox`; fresh executor gets the task + `Ox` injected via the normal
context format; run to completion.
**One datum:** `{session, model, run_k, diff, tokens, turns, judge_scores}`.
**Output quality:** task rubric score (did it fix the case, did it *respect the
recorded decision*), tokens/turns to done, re-derivation count, tests pass.
**Table/headline:** rows = observer models + controls; "Sonnet-written memory scored
8.1/10 on follow-ups vs 6.9 Haiku vs 6.2 no-memory."
**Snags:** executor variance forces ≥3 runs/cell (compute-expensive: 20 sessions ×
7 models × 3 runs = 420 executor runs); task-authorship bias (author knows what
session 1 contained — mitigate by deriving tasks from the repo's actual next
commit/issue); convergence risk (if every model catches the few load-bearing facts,
scores collapse together — distinguishable from "metric too blunt" only via the
oracle/floor gap).
**Verdict:** the direct, defensible measurement. Cost is the enemy.

### B. Production hindsight replay (the moat design)

**Tape:** claude-mem's DB already contains real consecutive sessions on the same
project. Pick pairs where session N+1's opening prompt clearly continues session N's
work. Per model X: X re-observes session N's transcript → `Ox`; replay session N+1's
*real* opening prompt against a fresh executor with `Ox` injected; compare outputs
across models — and against the actual session N+1 that happened.
**Ground truth is hindsight:** a fact was worth remembering iff session N+1 actually
needed it. Nobody authored anything; reality did. Task-authorship bias: gone.
**One datum:** `{pair, model, output, needed_facts_present: 3/4,
context_sufficiency: did the executor have to re-explore/ask for things memory
should have carried}`.
**Snags:** privacy/sanitization (real sessions — fine internally, public corpus
needs scrubbing or donated sessions); open-loop divergence (replaying only the
opening prompt loses the real user's steering — prefer pairs whose opening ask is
self-contained, limit horizon); repo-state reconstruction (need git state at session
N+1 start — transcripts usually pin it, but it's real plumbing).
**Verdict:** highest ecological validity, zero authorship bias, and **only claude-mem
can run it** — this is the unique-position design.

### C. Blind memory-swap with pairwise judge preference

**Tape:** same follow-up task run once per observer's memory (+ no-memory control);
strip identifiers; judge sees both final artifacts (diff + approach) and picks a
winner with rationale; Bradley-Terry/Elo across many comparisons → a "Memory Arena"
ladder.
**One datum:** `{task, pairing: haiku_vs_sonnet, winner, margin, rationale}`.
**Snags:** it does *not* save executor compute — only judge-calibration pain
(pairwise preference is more reliable than absolute rubrics); style-over-substance
risk (judge prefers the cleaner diff even when the other run honored a critical
recorded constraint — mitigate by giving the judge the session-1 fact list and
asking "which output better honors what was already known"); tie-domination on tasks
where memory doesn't bite.
**Verdict:** not an independent design — it's the **scoring layer** to bolt onto A or
B's runs. Best public-presentation artifact.

### D. Multi-session compounding chains

**Tape:** a 3–4 episode project arc on a fixed repo (scaffold → bug → extend →
refactor). Per model X, the loop runs closed: executor does ep1, X observes it; ep2
runs with X's ep1 notes injected; X observes ep2; … Each model's memory shapes its
own trajectory — good notes compound, and so do errors.
**Measures:** per-episode + cumulative task scores, tokens, and **decision
consistency** (does ep4's output contradict decisions recorded in ep1–3?).
**Headline:** a memory-compounding curve — "by episode 4, agents on Haiku-written
memory had drifted from 2.1 recorded decisions vs 0.4 on deepseek's." Nobody has
published anything like it; it's the truest match to claude-mem's value prop.
**Snags (hard):** variance compounds — one fluky episode poisons the rest of the
chain, so chains need replication and cost multiplies (5 models × 3 chains × 4
episodes = 60 executor runs per arc); by ep4, attribution is murky (which episode's
observation failed? needs per-episode failure attribution); arcs are heavy to design
and gameable once public. You *cannot* freeze executor outputs across models — that
would break the premise.
**Verdict:** the flagship *result*, the wrong *first* experiment. Run it second, on
the 2–3 models A/B already separated.

### E. Memory-only probe (no executor runs)

**Tape:** from a session pair (ideally B's hindsight pairs), extract what the future
actually needed to know. A probe agent gets **only** `Ox` — no repo, no transcript —
and must answer: "where is rate limiting implemented? what was decided about retry
backoff? what's the Windows-path gotcha?"
**One datum:** `{pair, model, questions: 6, correct: 4, absent: 1, misleading: 1}`.
**Cost:** pennies — no executor runs; the full model matrix is an afternoon.
**Snags:** measures information *sufficiency*, not *use* — a set can be sufficient
and ignored, or insufficient with the executor recovering by re-reading code; so E
can't produce the headline, only the mechanism. Question extraction must come from
real next-sessions or it inherits authorship bias. Score `{correct, absent,
misleading}` separately — **misleading is the killer stat** ("model X's notes misled
the probe 11% of the time").
**Verdict:** the cheap screening layer that makes the expensive designs affordable —
run E across *all* models first, send the interesting 3–4 into A/B, and publish the
E↔A correlation as a validity check on the cheap metric. This is also the
cost-structure answer Alex's donated credits deserve.

### Synthesis (what survived every tape)

1. **Hindsight beats authorship everywhere it's available.** B's "the future already
   happened" grounding should feed A (tasks from real next commits) and E (questions
   from real next needs).
2. **Executor-run cost is the binding constraint.** The funnel — E-screen across all
   models, A/B deep on the survivors, D as the second-wave showpiece, C as the
   scoring layer — is the cost architecture.
3. **"Misleading memory" is a first-class outcome, not a diagnostic.** It emerged
   independently in two tapes. The chain *fabricated note → executor trusts it → bad
   future output* connects fabrication to value, is measurable in A/B runs, and has
   never been measured by anyone.
4. **Three controls, not two:** no-memory floor, oracle ceiling, and a
   **shuffled-memory control** (inject model X's observations from a *different*
   session) to prove effects come from content, not from "any plausible-looking
   context primes the executor." The shuffled control appears in none of the prior
   specs and is the one skeptics will demand.

## 4. Diagnostics & covariates (input-side, explicitly not the story)

Reported to *explain* rankings, never to headline them:
- **Yield/count:** obs per session/turn, share of sessions with ≥1 observation,
  distributions not means. (The anecdote that started this: fleet data shows yield
  varies wildly by model — but count doesn't tell the value story empirically.)
- **Structure:** parse rate through `src/sdk/parser.ts`; API-served vs
  grammar-constrained serving split (locals ~0% invalid via constrained decoding;
  fleet proxies: Haiku ~25% invalid, Sonnet ~19%, Opus ~4.5%). Token-cost
  implications acknowledged. Handled via structured-output accommodations where
  needed, reported per row.
- **Grounding at write time:** supported/partial/unsupported vs transcript — feeds
  the misleading-memory chain in §3.
- **Classification/tags:** obs_type fidelity, catch-all dumping, file-reference
  accuracy.
- **Compression density, latency, cost per valid observation** (OpenRouter
  `usage.cost` = real dollars; feeds Alex's estimate).

## 5. Fleet corroboration (production reality check — corroborates, never scores)

- `observer_turn_rollup`: per-session-end; `observations_created`, `top_model`,
  outcome, fabrication counts. The correct per-session source.
- `session_compressed`: fires **per pipeline operation, not per session** (analysis
  mistake already made once; don't repeat); `tokens_input/output`, `cost_usd`,
  `compression_ratio`.
- `context_injected`: `tokens_saved_vs_naive` — production proxy for reuse value.
- Caveats to publish verbatim: ~20% field coverage on count fields; ~13% `unknown`
  model attribution; model-name fragmentation needs a normalization map first.

## 6. Candidate model pool (through OpenRouter, per the deal)

A pool, not a locked slate: `anthropic/claude-sonnet-4-6`,
`anthropic/claude-haiku-4-5` (fleet-dominant, ~66% of sessions),
`qwen/qwen3.6-27b`, `deepseek/deepseek-v4-flash` (fleet over-performer),
`openai/gpt-oss-20b`/`120b`, `xiaomi/mimo-v2-flash:free` (current claude-mem
OpenRouter default; 0% observer success in fleet — benchmarking it is also a product
decision), optionally 1–2 locally-served models for the serving-stack comparison.

## 7. Constraints and assets

- **This remote environment blocks `openrouter.ai` and `huggingface.co`** (proxy 403)
  and has no Docker. Build harness + offline tests here; **all live inference — 
  including Alex's cost probe — runs on a networked machine** with the claude-mem
  worker up.
- **Reusable in-repo infra:** `swebench/` package (previous session) — standalone
  OpenRouter client with retry + real `usage.cost` capture, settings-compatible
  config, process runner, JSONL artifact pattern, mock-provider offline tests.
  Adjacent infra, proven shape.
- **Use the production surfaces, don't reimplement:** observation prompt
  (`src/sdk/prompts.ts`), parser (`src/sdk/parser.ts`), OpenRouter provider
  conventions (`src/services/worker/OpenRouterProvider.ts`), injection format
  (`/api/context/inject`).
- **Corpus source:** `~/.claude-mem/claude-mem.db` (sessions, observations, prompts —
  including the consecutive-session pairs Design B needs) + Claude Code transcripts.
  Sanitization before anything freezes.

## 8. Integrity commitments

1. Every published number reproducible from an open harness + corpus.
2. All results published, **including where Claude models lose.**
3. No silent metric changes; versioned corpus/judge/prompts.
4. OpenRouter cited.

---

### Paste-ready kickoff prompt for the new session

> Read `plans/2026-07-29-membench-openrouter-kickoff.md`. The core question is §1:
> how do different models' observation sets affect the quality of future output.
> §3 contains five candidate designs with their tapes played through plus a
> synthesis — evaluate them with fresh eyes, choose a composition and sequencing
> (you may deviate; justify), and only then diff against the older
> `plans/membench/membench-spec-v0.2.md`. First concrete deliverable: the OpenRouter
> cost estimate owed to Alex Atallah (§2), priced for your chosen design both with
> executor-through-OpenRouter and executor-on-defaults. Surface decisions needing my
> input as you hit them.
