# MemBench × OpenRouter — Kickoff 🚀

**For:** a fresh Claude Code session building MemBench from scratch.
**Updated:** 2026-07-29 · **TL;DR version:** `plans/membench/OVERVIEW.md`

**One question:** which model writes memory that actually helps later?

---

## 1. The loop (this IS the benchmark) 🔁

> Take a transcript. All models observe it in parallel. Fork the session per
> variant. Same task in every fork. Count tokens. Check success.

```
transcript ──→ all models observe it (parallel, via OpenRouter)
                        │
                        ▼
        one fork per model's observation set
        + 3 controls: none · oracle · shuffled
                        │
                        ▼
        every fork performs the SAME task
                        │
                        ▼
        📊 tokens used  +  ✅/❌ success
```

Step by step:

1. 📜 **Transcript in** — real session, repo pinned at the commit it ended on
2. 🤖 **Parallel observe** — same transcript + production obs prompt
   (`src/sdk/prompts.ts`) → every model, concurrently → one observation set each
3. 🍴 **Fork** — fresh executor per variant, same repo state, memory injected in
   claude-mem's normal format (`/api/context/inject` shape)
4. 🏃 **Task** — identical prompt in every fork, runs to completion
5. 📏 **Measure** — tokens used (+ $) and success (pre-written pass/fail check;
   mechanical where possible, judge only where it can't be)

**Claim under test:** better observations → same task done in fewer tokens
and/or more successes. Only variable = who wrote the memory.

## 2. Controls (what makes it believable) 🧪

| Fork | Proves |
|---|---|
| 🚫 **No memory** | the floor — what memory has to beat |
| 🎯 **Oracle** (hand-written perfect notes) | the ceiling — "model X captured 71% of possible savings" |
| 🔀 **Shuffled** (notes from a *different* session) | value comes from content, not "any context primes the agent" |

Plus: **k≥3 runs per fork** (executors are stochastic) → report mean ± spread.

## 3. Metrics 📊

**Scoreboard (the story):**

| Metric | Meaning |
|---|---|
| ✅ Success rate | vs no-memory floor |
| 🪙 Tokens to done | successful runs only, vs floor + oracle |
| 🎯 % of oracle savings | `(floor − model) / (floor − oracle)` |
| 💸 Cost | real dollars via OpenRouter `usage.cost` — obs side + exec side |

**Diagnostics (recorded, never headlined):** obs count · obs tokens · parse
notes · turns · per-task splits.

⚠️ **Count ≠ value.** Count is a covariate, full stop.
⚠️ **XML adherence = plumbing.** If a model can't emit parseable XML from the
prompt, use structured-output/JSON mode so its *content* still competes — note
the accommodation per row. We benchmark what models *notice*, not tag discipline.

## 4. What ships 📦

Not a report — a **runnable artifact**. Anyone (incl. OpenRouter's team) can
re-run the whole thing and reproduce the table.

- 📦 **Corpus** — `corpus/<item-id>/` with:
  `transcript.*` (sanitized) · `repo.lock` (URL + pinned commit) · `task.md` ·
  `check.sh` / `success.md` (pass/fail, written BEFORE any model runs) ·
  provenance. Frozen + content-hashed per release.
- ⚙️ **Harness** — `membench/` package, one command = full loop →
  `results.jsonl` (one row per fork-run: item, model, run, tokens, cost,
  success, duration) + `summary.json` + scoreboard render.
- 🧾 **Audit trail** — every fork's full transcript + diff retained.
- 🏗️ Package shape mirrors `swebench/`: Bun + TS, zero runtime deps,
  mock-provider offline tests, JSONL artifacts.

## 5. Corpus sourcing 🌱

- 📜 **Transcripts:** claude-mem's own DB (`~/.claude-mem/claude-mem.db`) +
  Claude Code transcript files. Sanitize (secrets/PII) before freezing.
- 🎯 **Tasks — hindsight first:** best tasks come from what the user *actually
  did next* on that project (session N+1 defines the task). No authorship bias —
  reality wrote the task. Fallback: author it, but derive from the repo's real
  next commit/issue.
- ✅ Success check written at authoring time, before any model runs.
- 🌰 Start with **5–10 items** → shake out harness + get cost numbers → grow.

## 6. The OpenRouter deal 🤝

- **Alex Atallah (OpenRouter co-founder) is donating credits** (X DM, Jul 26)
- His asks: 1️⃣ **cite OpenRouter** in everything published · 2️⃣ **cost
  estimate** — WE OWE THIS FIRST
- 💸 Cost formula per corpus item:
  `N_models × (obs pass) + (N_models + 3 controls) × k runs × (executor pass)`
- How: run 2–3 items end-to-end → read real `usage.cost` off every call →
  extrapolate → price executor side BOTH ways (through OpenRouter vs Claude
  Code defaults) → send Alex the table
- ⏰ Timing: Stripe reportedly eyeing ~$10B OpenRouter acquisition (PYMNTS 2026)
- 🗺️ Positioning: recall benchmarks (LongMemEval, LoCoMo) = finding planted
  facts. MemBench = did the right things get *written down*, and did they make
  future work cheaper/better. Different category.

## 7. Why claude-mem is uniquely positioned 🥇

- Only system with **real session N → N+1 production data** (hindsight tasks)
- Benchmarks the **actual product pipeline**, not a toy re-implementation
- **50M+ sessions** of fleet telemetry to corroborate lab numbers

## 8. Model pool (via OpenRouter) 🤖

Pool, not locked slate:

| Model | Why |
|---|---|
| `anthropic/claude-sonnet-4-6` | frontier |
| `anthropic/claude-haiku-4-5` | fleet-dominant (~66% of sessions) |
| `qwen/qwen3.6-27b` | open-weight mid |
| `deepseek/deepseek-v4-flash` | fleet over-performer |
| `openai/gpt-oss-20b` / `120b` | open-weight |
| `xiaomi/mimo-v2-flash:free` | current claude-mem default — 0% observer success in fleet 👀 (product decision too) |
| + 1–2 local models | optional: constrained-decoding comparison |

## 9. Build with, not around 🔧

**Use production surfaces, don't reimplement:**
- Obs prompt → `src/sdk/prompts.ts`
- Parser → `src/sdk/parser.ts`
- OpenRouter conventions → `src/services/worker/OpenRouterProvider.ts`
- Injection format → `/api/context/inject`

**Steal from `swebench/`** (this branch): OpenRouter client w/ retry + real
`usage.cost` capture · config resolution · process runner · JSONL artifacts ·
mock-provider offline test pattern.

## 10. Environment gotchas ⚠️

- 🚧 **This remote env BLOCKS `openrouter.ai` + `huggingface.co`** (proxy 403),
  no Docker → build + offline-test here, **live inference on Alex's machine**
  (with claude-mem worker running)
- 📊 Telemetry corroboration (never scores): `observer_turn_rollup` = correct
  per-session source · `session_compressed` fires **per operation, NOT per
  session** (known analysis trap!) · `context_injected` has
  `tokens_saved_vs_naive`
- Telemetry caveats: ~20% field coverage on counts · ~13% `unknown` model ·
  name fragmentation needs a normalization map

## 11. Background (informed the loop, not binding) 📚

Five designs were played through end-to-end (git history of this file, commit
`743946e`; older specs in `plans/membench/` = reference from a stressed session,
not the plan). What survived, already folded in above:

- 🕰️ Hindsight task-sourcing > authored tasks
- 💰 Executor runs = the binding cost → optional cheap **memory-only probe**
  (agent gets ONLY the obs set, answers what the task needs; scored
  correct/absent/**misleading**) as a screening layer + mechanism explainer
- 🤥 **Misleading memory** (fabricated note → executor trusts it → wrong
  output) = first-class outcome worth tracking
- 🔗 Multi-session compounding chains = flagship experiment #2, AFTER the
  single-fork loop separates models

## 12. Integrity (non-negotiable) 🔒

1. Every published number reproducible from open harness + corpus
2. Publish everything — **including where Claude models lose**
3. No silent metric/corpus changes; version everything
4. OpenRouter cited

---

## Kickoff prompt (paste into new session) ▶️

> Read `plans/2026-07-29-membench-openrouter-kickoff.md`. Build the §1 loop as
> a runnable benchmark per §4: `membench/` package mirroring `swebench/`
> conventions — corpus format, parallel observation generation via OpenRouter,
> session forks with injected variants + the three controls, task execution,
> `results.jsonl` + scoreboard. Offline-test everything with mock providers
> (live inference happens on my machine, not in this environment). Start with a
> 5-item corpus sourced per §5. First deliverable after the harness dry-runs:
> the cost-estimate table for Alex Atallah (§6), priced both executor-routing
> ways. Surface decisions needing my input as you hit them.
