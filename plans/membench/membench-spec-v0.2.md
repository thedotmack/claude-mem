# MemBench — Specification v0.2

**One question: does an agent with model X's notes redo less work than an agent without them?**

Everything in this spec is either that number or infrastructure that number earns.
Supersedes v0.1 (kept as the roadmap appendix — most of it was v1.0 wearing a v0.1 name tag).

Status: build-ready · Owner: Alex · Last updated: 2026-07-17

---

## Phase 0 — The Existential Experiment (Week 1) 🚦

Before ranking observers, test whether observation-memory moves the needle at all. This is claude-mem's core premise run as a controlled experiment, and it gates everything else.

**Protocol:**
- 10 real session transcripts (any mix; don't over-curate yet — 5 bugfix, 5 feature is fine).
- For each, write ONE follow-up task on the same repo that a returning engineer would plausibly do next.
- Two arms only:
  - **Oracle** — you hand-write the 3–6 facts from session 1 that a perfect memory would carry, injected in claude-mem's normal format.
  - **Baseline** — no memory.
- Fixed executor (pin current Claude Code default). 3 runs per arm. Record tokens, turns, task success (you judge it yourself for now — 60 runs, one afternoon).

**Decision gate:**
- Oracle lift ≥ 25% on cost (tokens + 500/turn) or a visible success-rate gap → **green light**, proceed to Phase 1 with the ceiling number in hand.
- Oracle lift < 10% → **stop and think.** The benchmark would be ranking observers on a value that doesn't exist; the finding redirects claude-mem itself (maybe value lives in injection strategy or retrieval, not observation quality). That's a cheap, important discovery — a week, not six.
- In between → inspect which task types show lift; Phase 1 corpus over-samples those.

The oracle number is also the launch post's most credible stat: *"perfect memory saves N% — here's how close each model gets."*

---

## Phase 1 — MemBench v0.1: The Minimal Real Benchmark (Weeks 2–4)

### 1. Design fixes carried in from the critique

| v0.1 flaw | v0.2 fix |
|---|---|
| Gold labels circular (annotate moments → write tasks around them → score agreement with own imagination) | **Task-first, facts derived backwards.** Author the follow-up task first; the gold facts are, by definition, whatever session 1 contained that the task needs. "Worth remembering" = "the future needed it." No moment annotation pass at all. |
| Coverage and Value measured the same assumption twice | **Coverage pillar deleted.** Catching the right moments is now measured *through* outcome: if the observer missed the fact, the lift shows it. Yield/precision demoted to diagnostics. |
| Composite score = confident fiction inviting weight-litigation | **No composite in v0.1.** Report per-metric results and pillar winners only. A composite ships in v1.0 only alongside a rank-stability analysis under weight perturbation. |
| RD partly measures executor trust, not observer quality | Renamed **Re-work Delta** and reported as a *system-level* metric (observer × executor pair), stated plainly. Rankings valid under the pinned executor; absolute number attributed to the pair. Executor rotation graduates to v1.0. |
| Moat framing ("nobody can run this") = unverifiable-by-design | **Adoption framing.** Ship `OBSERVATION.md` — the minimal interface spec (schema, types, tags, injection format) any memory system can implement to enter the leaderboard. The win condition is a competitor adopting your ontology to compete; exclusion is the fallback, not the pitch. |

### 2. Corpus

- **30 sessions** (grow later; 30 × 4 arms × 3 runs = 360 runs, still one weekend of compute).
- Stratify only on what Phase 0 said matters. Default: 12 bugfix / 10 feature / 8 refactor-or-infra.
- Sanitization rules unchanged from v0.1 (secrets/PII scan + manual pass, provenance per session, content-hashed freeze: `membench-corpus-2026.08`).
- No public/held-out split yet — that's leaderboard-service machinery for when external submissions exist.

### 3. Arms

Per session: **Baseline · Oracle · Candidate(model)** for each model under test. Pinned executor, 3 runs per arm, mean ± CI.

**v0.1 model slate (3 + 2):** claude-sonnet-4-6, claude-haiku-4-5, qwen3.6-27b (Q4, local) — the story is "frontier vs default vs local."
Stretch: gpt-oss-20b (MXFP4), deepseek-v4-flash. Serving config is part of row identity.

### 4. Metrics (all reported, none composited)

**Headline — Re-work Delta (RwD):** share of task-required facts the executor re-derived from scratch (re-read, re-ran, re-asked) despite memory present, vs baseline.
> "With ___'s memory, the agent redid ___% less work."

**Reuse Lift (L):** `(cost_baseline − cost_candidate) / cost_baseline`, success-gated, reported alongside `% of oracle` so every number carries its ceiling. Gross-vs-net rule: every token figure states its denominator.

**Success Delta:** candidate vs baseline task pass rate.

**Fact Coverage (diagnostic):** of the task-required facts, how many exist anywhere in the candidate's observations (regardless of whether the executor used them). Splits "observer never wrote it" from "executor ignored it" — the two failure modes the headline conflates.

**Grounding (diagnostic):** judge audit of candidate observations against transcript (supported / partial / unsupported). Kept from v0.1 because fabrication is the one quality axis with direct trust consequences; the fleet already tracks its proxy (`fabrication_count`).

Everything else from v0.1's Quality pillar (type fidelity, tags, atomicity, salience, density) → **diagnostics backlog**, computed when a ranking question needs explaining, scored never (in v0.1).

### 5. Judging

- **Single judge** (pinned model + prompt hash) for: task success, re-derivation count, grounding, fact coverage.
- **Human spot-check instead of full calibration:** you hand-label a random 15% of judge calls; publish the agreement number. If < 85%, fix the rubric before publishing anything. Full dual-judge + κ protocol graduates to v1.0 with the leaderboard.
- Judge conflict rule stays: if the judge model family is also under test, run the 15% spot-check on that family's rows at 30% instead and say so.

### 6. Integrity rules (unchanged, non-negotiable)

1. Every published number reproducible from the open harness + corpus.
2. All results published, including where Claude loses (fleet data says it will on some axes — that's the credibility engine).
3. No metric removed/reweighted without changelog.
4. Versioned everything: corpus, judge, executor, prompts. `MemBench-2026.08`.

---

## Fleet Track (unchanged scope, demoted role)

Production telemetry corroborates, never scores. Prerequisite: **model-name normalization map** before any public chart. Metric mapping as in v0.1 §9 (`observer_turn_rollup` yield/grounding-proxy/laziness, `session_compressed` compression, `context_injected` tokens_saved_vs_naive with the dominant-model attribution caveat, error rates split API vs local). Publish known caveats verbatim: ~20% field coverage on count fields, ~13% `unknown` attribution.

---

## Launch narrative (v0.1)

1. **The ceiling:** perfect memory saves N% (Phase 0 oracle number).
2. **The ranking:** which observer gets closest — RwD + Lift-as-%-of-oracle, five models, error bars.
3. **The surprise:** wherever the local model beats a Claude model, lead with it.
4. **The invitation:** `OBSERVATION.md` — "implement this interface and get on the board." Category creation = others adopting the ontology, not others being locked out.
5. **The receipts:** harness repo, corpus, judge prompts, fleet corroboration.

---

## Build plan

| Week | Milestone | Gate |
|---|---|---|
| 1 | Phase 0: 10 sessions, oracle vs baseline, 60 runs | Oracle lift ≥ threshold → continue |
| 2 | Harness hardening; corpus → 30 sessions + follow-up tasks; sanitization | |
| 3 | Judge + 15% spot-check; full 5-model × 4-arm run | Judge agreement ≥ 85% |
| 4 | Results write-up, `OBSERVATION.md`, repo public, launch post | |

Number in hand by end of week 1. Publishable by end of week 4.

---

## Appendix — v1.0 Roadmap (the v0.1 spec, correctly labeled)

Graduates when v0.1 has shipped and external interest exists: composite score + weight-stability analysis · dual-judge κ protocol · executor rotation (2 executors, mean + spread) · held-out split + submission service · 150-session corpus · multi-hop (5-session) value track · type/tag fidelity scoring with frozen taxonomy · P1/P2 moment grading — *only if* diagnostic demand proves moment-level labels earn their annotation cost.
