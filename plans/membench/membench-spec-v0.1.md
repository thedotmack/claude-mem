# MemBench — Specification v0.1 (draft)

**A benchmark for observation-centric agent memory.**
Working headline: *"Which Model Is Best for Memory?"*

Status: draft for build · Owner: Alex · Last updated: 2026-07-17

---

## 1. Purpose & Positioning

### 1.1 The category claim

MemBench measures a question no existing memory benchmark asks: **does a model write down the right things while an agent works, and do those notes make future work cheaper and better?**

Existing long-term-memory benchmarks (LongMemEval, LoCoMo, needle-in-haystack variants) measure *archival recall*: a fact is planted, and the system is scored on retrieving it verbatim later. That is the right test for a search index. It is the wrong test for a working-memory system, which must decide *what is worth remembering at all* under compression, and whose output is consumed by an agent as injected context, not returned to a user as an answer.

MemBench therefore scores the full loop that recall benchmarks skip:

```
observe → classify → compress → store → inject → reuse
```

The unit of measurement is the **observation**: a typed, tagged, compressed record of something that happened in an agent session.

### 1.2 Non-goals (state these loudly in the launch post)

- MemBench does **not** measure perfect-recall accuracy. A system can score 100% on needle retrieval and 0 on MemBench, and vice versa. This is a feature of the category definition, not a bug.
- MemBench does **not** rank memory *systems* in v0.1. It ranks **observer models** running inside one fixed pipeline (Claude-Mem). Ranking systems requires observation parity, which no other system currently has — say this plainly rather than letting critics discover it.
- MemBench is not a chat-memory benchmark. The domain is coding-agent sessions.

### 1.3 Integrity stance (the credibility IS the marketing)

Lesson already learned internally (the gross-vs-net token-savings correction): a benchmarking-literate audience will find the one conflated number and discredit the rest. Therefore, hard rules:

1. Every published number is reproducible from the open harness + public corpus split.
2. Judge prompts, rubrics, gold labels (public split), and scoring code are released.
3. **All** model results are published, including ones where Claude models lose. (They will — fleet data already shows locals beating Opus on yield and grounding. Publish it. It's the best proof the benchmark is real.)
4. No metric is removed or reweighted between versions without a changelog entry explaining why.
5. Never conflate gross with net anywhere: every token/cost figure states its denominator.

---

## 2. Architecture Overview

Two tracks, one score:

| Track | What it is | What it's for |
|---|---|---|
| **Offline (Lab)** | Frozen corpus of real session transcripts replayed deterministically through each observer model; judged against gold labels | The leaderboard. Reproducible, versioned, citable |
| **Live (Fleet)** | The same metric family computed from production telemetry (PostHog) across all Claude-Mem installs | Validation at scale: "the lab number holds across N million real sessions" |

The composite **MemBench Score** comes from the Offline track only. Live-track numbers are reported alongside as corroboration, never averaged in (they aren't controlled).

---

## 3. The Corpus

### 3.1 Composition (v0.1 target: 60 sessions; v1.0: 150)

Real Claude Code session transcripts (turns, tool calls, diffs, hook events), stratified by session archetype:

| Archetype | v0.1 count | Why it's in |
|---|---|---|
| Bug hunt → root cause → fix | 20 | Richest in `bugfix` + `discovery` moments |
| Feature build (greenfield) | 15 | `decision`-heavy; tests salience judgment |
| Refactor | 10 | `refactor` type precision; long-horizon constraints |
| Debugging rabbit hole (incl. dead ends) | 10 | Tests noise resistance: dead ends mostly should NOT become durable observations |
| Config / infra / environment | 5 | High-value, low-frequency facts (versions, flags, footguns) |

Session length mix: ~40% short (<15 turns), ~40% medium (15–50), ~20% long (50+).

### 3.2 Sanitization pipeline (blocking requirement before any release)

- Strip secrets/credentials (automated scan + manual pass), PII, private repo identifiers, employer-identifying paths.
- Contributor sessions require an explicit license grant; keep a provenance record per session.
- Each corpus version is content-hashed and frozen: `membench-corpus-2026.07` etc.

### 3.3 Public / held-out split

- **70% public** — released with gold labels for reproduction.
- **30% held-out** — same distribution, labels private, refreshed quarterly. Leaderboard submissions are scored on public + held-out; a large public/held-out gap is flagged as probable overfitting.

### 3.4 Gold annotation protocol

For each session, two annotators independently mark:

1. **Gold moments** — spans where a durable observation *should* be produced. Each gold moment gets: type (`discovery` / `decision` / `bugfix` / `refactor` / `other`), gold tag set, a one-line canonical statement of the fact, and an importance grade (P1 must-catch / P2 should-catch).
2. **Negative moments** — spans that look observable but should NOT produce durable observations (dead ends later reverted, transient state, restated boilerplate).
3. Disagreements resolved by adjudication; report inter-annotator agreement (target Cohen's κ ≥ 0.7 on moment identification, ≥ 0.75 on type).

Rule of thumb from annotation dry-run: expect ~3–8 gold moments per medium session. If a session yields <2, replace it.

---

## 4. Pillar 1 — Quality (weight: 30)

*What got written: is it true, well-typed, and dense?*

All quality metrics are computed over the observations each model actually emitted during replay.

### 4.1 Structure Gate (not scored — eligibility)

`valid_rate` = structurally valid observations / attempts. Models with `valid_rate < 0.98` appear on the leaderboard with an asterisk and their score computed over valid outputs only. Rationale: constrained decoding makes structure trivially perfect for local runtimes, so scoring it would just measure the serving stack; but API-served models *can* fail it, and the audience should see that. (Fleet data: local models 0.0% invalid; Haiku 4.5 ~25% invalid on the unconstrained path.)

### 4.2 Grounding (G) — weight 40% of pillar

Judge labels each observation against the transcript: **supported / partially supported / unsupported**.

```
G = (supported + 0.5 × partial) / total
fabrication_rate = unsupported / total   (reported separately; the scary number)
```

### 4.3 Type Fidelity (T) — weight 25%

For observations matched to gold moments: **macro-F1** of predicted `observation_type` vs gold type. Macro (not micro) so dumping everything into `other` is punished rather than hidden. Report the confusion matrix; `%-typed-other` is published as a diagnostic ("laziness index").

### 4.4 Tag Fidelity (Tg) — weight 15%

Mean Jaccard similarity between predicted tag set and gold tag set on matched observations. Tags are scored leniently in v0.1 (synonym map maintained in the harness) — tighten in v1.0.

### 4.5 Atomicity (A) — weight 10%

Judge binary per observation: does it assert exactly one durable claim? `A = atomic / total`. Multi-claim blobs compress badly and retrieve badly; this is the metric that catches "wrote a paragraph instead of a fact."

### 4.6 Salience (S) — weight 10%

Judge rubric 1–5 per observation: *"Would a senior engineer joining this project tomorrow want this in the project notes?"* (5 = definitely, 1 = noise). `S = (mean − 1) / 4`.

**Quality = 0.40·G + 0.25·T + 0.15·Tg + 0.10·A + 0.10·S**

Diagnostics reported but unscored in v0.1: tokens per grounded observation (density), compression ratio.

---

## 5. Pillar 2 — Coverage (weight: 30)

*What got caught: did the model notice the right moments and ignore the wrong ones?*

### 5.1 Moment Recall (R) — weight 45%

```
R = gold moments captured / gold moments        (P1 moments double-weighted)
```
A gold moment is "captured" if ≥1 emitted observation is judged to express its canonical fact (semantic match, not string match).

### 5.2 Precision / Noise (P) — weight 35%

```
P = observations attributable to a gold moment or judged salient-novel / total observations
noise_rate = 1 − P
```
Plus **negative-set violation rate**: share of negative moments that wrongly produced observations. Violations subtract directly: `P_adj = P − 0.5 × violation_rate` (floored at 0).

### 5.3 Duplicate Rate (D) — weight 20%

Share of observations that are semantic duplicates of an earlier observation in the same session (embedding similarity above threshold + judge confirm). Scored as `(1 − dup_rate)`.

**Coverage = 0.45·R + 0.35·P_adj + 0.20·(1 − dup_rate)**

Report **obs/turn** as the fleet-comparable diagnostic (unscored — raw yield is not a virtue; calibrated yield is, and R/P capture that).

---

## 6. Pillar 3 — Value (weight: 40)

*Did the notes matter: paired follow-up sessions with memory on vs off.*

This is the headline pillar and the one nobody else can run.

### 6.1 Paired-session protocol

For each corpus session, annotators author a **follow-up task** on the same repo that genuinely requires ≥3 gold facts from the original session (e.g., "extend the fix from last session to the async path" — impossible to do efficiently without remembering the root cause, the constraint, and the decision).

Each follow-up task runs in four arms, N=3 runs per arm (report mean ± CI):

| Arm | Memory injected |
|---|---|
| **Candidate** | Observations written by the model under test |
| **Baseline** | None |
| **Oracle** | The gold canonical facts, hand-written (ceiling) |
| **Frontier ref** | Observations from the current best model (anchor across versions) |

Runner: Claude Code headless with a **fixed executor model** for all arms (executor ≠ observer under test, pinned per benchmark version), so the only variable is the memory.

### 6.2 Reuse Lift (L) — weight 50%

Cost = tokens consumed + α·turns (α published; v0.1: α = 500 tokens/turn). Success = task rubric pass (judged, rubric per task, written at annotation time).

```
lift_raw     = (cost_baseline − cost_candidate) / cost_baseline      [success-gated: failed runs get lift 0]
L            = lift_raw / lift_oracle                                 [normalized to oracle ceiling, clipped 0–1]
```
Reporting "X% of oracle" kills the gross-vs-net ambiguity by construction.

### 6.3 Re-discovery Rate (RD) — weight 30%

For each follow-up run, the judge counts how many of the required gold facts the executor **re-derived from scratch** (re-read the file, re-ran the experiment, re-asked) despite memory being present.

```
RD = re-derived facts / required facts        Value component = (1 − RD)
```
This is the metric with the headline gravity: *"With model X's memory, the agent re-learned 61% less."*

### 6.4 Success Delta (SD) — weight 20%

`SD = success_rate_candidate − success_rate_baseline`, rescaled 0–1 against oracle delta. Catches the case where memory doesn't just save tokens but changes whether the task lands at all.

**Value = 0.50·L + 0.30·(1 − RD) + 0.20·SD**

---

## 7. Scoring & Reporting

```
MemBench Score = 100 × (0.40 × Value + 0.30 × Quality + 0.30 × Coverage)
```

Leaderboard row (all fields mandatory — no metric hiding):

```
model | MemBench | Value | Quality | Coverage | valid_rate | fabrication_rate | noise_rate | RD | $/1k obs | ms/turn
```

Headline formats: "MemBench 2026.07: <model> — 84.2", per-pillar winners ("Best Grounding", "Best Reuse"), and the cost-efficiency frontier chart (MemBench Score vs $/1k observations — where local models will visibly shine).

Versioning: `MemBench-YYYY.MM`. Corpus, judge, executor, weights all pinned per version. Score comparisons across versions are labeled as such.

---

## 8. Judge Design

### 8.1 Judged tasks

Grounding (3-way), type match, tag match, atomicity (binary), salience (1–5), moment capture (semantic match), duplicate confirm, re-derivation count, task success rubric.

### 8.2 Rubric skeleton (grounding — the pattern for all)

```
You are auditing an observation written by a coding-session observer.
TRANSCRIPT (session excerpt): {window}
OBSERVATION: {obs}

Label exactly one:
- SUPPORTED: every factual claim in the observation is directly evidenced in the transcript.
- PARTIAL: the core claim is evidenced but details (names, values, causality) are embellished or unverifiable.
- UNSUPPORTED: the central claim does not appear in, or contradicts, the transcript.
Return: {"label": ..., "evidence_quote": ..., "reason": ...}   (≤40-word reason)
```

### 8.3 Calibration protocol

- 300-observation calibration set, dual human annotation; report human–human κ per task.
- Judge is accepted for a task iff judge–human agreement ≥ (human–human agreement − 5 pts).
- **Judge conflict-of-interest rule:** the primary judge must not be a model family under test with an unmanaged conflict — v0.1 runs **dual judges** (one Claude, one non-Anthropic frontier model), publishes both, and scores on their consensus; disagreements >5% on any metric trigger human adjudication of the disputed subset. This pre-empts the "Claude judging Claude" objection in writing.
- Judge model + prompt hash pinned per benchmark version.

---

## 9. Live Track — Fleet Metric Definitions (PostHog)

Prerequisite task: **model-name normalization map** (`haiku` / `claude-haiku-4-5` / `claude-haiku-4-5-20251001` → one key; ollama tags and GGUF filenames → canonical model IDs). Ship this before publishing any fleet chart.

| Metric | Source | Definition |
|---|---|---|
| Yield/turn | `observer_turn_rollup` | `sum(observations_created) / sum(count)` by `top_model` |
| Grounding proxy | `observer_turn_rollup` | `1 − sum(fabrication_count)/sum(observations_created)` |
| Structure | `observer_turn_rollup` | `outcomes_invalid_output / Σ outcomes_*` |
| Laziness index | `observer_turn_rollup` | `obs_type_other / Σ obs_type_*` |
| Compression | `session_compressed` | mean `compression_ratio` by `model` |
| Reuse proxy | `context_injected` | `tokens_saved_vs_naive`, cohorted by each install's dominant observer model (attribution caveat: per-`distinct_id` dominant model, not per-session — state it) |
| Reliability | `observer_turn_rollup` | `outcomes_error + outcomes_aborted` share (report separately for API vs local serving; local errors mostly reflect user hardware) |

Known data-quality caveats to state in any publication: ~20% field coverage on `session_compressed` count fields (client-version dependent); `unknown` model attribution (~13% of sessions); telemetry began <date of instrumentation>.

---

## 10. Model Matrix (v0.1 run)

API: claude-opus-4-7, claude-sonnet-4-6, claude-sonnet-4-5, claude-haiku-4-5, deepseek-v4-flash, gemini-2.5-flash-lite, gpt-5.4-mini.
Local (MLX/Ollama, pinned quants): qwen3.6-27b (Q4), qwen3.6-35B-A3B (4-bit), qwen3.5-9b, llama-3.1-8b-instruct, gpt-oss-20b (MXFP4), gemma-4 small.
Serving config (runtime, quant, constrained-decoding on/off) is part of the row identity — a model at two quants is two rows.

---

## 11. Build Plan

| Week | Milestone |
|---|---|
| 1–2 | Replay harness: deterministic transcript feed → observer → captured observations; arm runner for paired sessions |
| 2–3 | Corpus assembly + sanitization; annotate 20 sessions (dry-run), lock annotation guide |
| 3–4 | Annotate remaining 40; author follow-up tasks + success rubrics |
| 4–5 | Judge implementation + calibration set + agreement report |
| 5–6 | Full matrix run (offline), fleet normalization map + live-track queries |
| 6 | v0.1 leaderboard, launch post ("lab + 56M-session fleet validation"), repo public |

## 12. Open Questions (decide before v1.0)

1. Should Coverage recall use P1-only for the headline and P1+P2 for the full score? (Leaning yes.)
2. Executor model rotation policy — one pinned executor biases toward observers that "write for" that executor. v1.0: score under 2 executors, report mean + spread.
3. Multi-session value: v0.1 pairs are 1-hop (session → follow-up). Real memory compounds over weeks — design a 5-hop track for v1.0.
4. Community submissions: accept external observer configs? Requires held-out scoring service.
5. Tag taxonomy freeze: current tag vocabulary is organic; freeze a v1 vocabulary before Tag Fidelity graduates from lenient scoring.
