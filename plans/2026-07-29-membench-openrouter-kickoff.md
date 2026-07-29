# MemBench × OpenRouter — Kickoff Doc

**Purpose of this doc:** everything a fresh Claude Code session needs to start executing
MemBench. Written 2026-07-29. The authoritative benchmark design is
[`plans/membench/membench-spec-v0.2.md`](membench/membench-spec-v0.2.md) (v0.1 is the
v1.0 roadmap appendix). This doc adds the OpenRouter partnership context, the immediate
deliverable, the codebase grounding, and what already exists to build on.

---

## 1. Why now (the partnership context)

- **Alex Atallah (OpenRouter co-founder) has agreed to donate OpenRouter credits** for
  the benchmark runs (X DM, Jul 26). Two asks from him:
  1. **Citation** — OpenRouter must be credited in the published benchmark/launch post.
  2. **A cost estimate** — "how much do you think inference will cost?" We promised a
     test run + numbers. **This is the first deliverable and it is owed.**
- Strategic urgency: Stripe is reportedly eyeing a ~$10B acquisition of OpenRouter
  (PYMNTS, 2026). A published, OpenRouter-powered, citable benchmark deepens the
  claude-mem ↔ OpenRouter relationship at exactly the right moment.
- The pitch Alex already bought: benchmark **observation quality and memory re-use
  value** across models — "benchmarking the actual value of memory and the content
  quality of the memory is a genuinely novel benchmark, and Claude-Mem is built for
  this." Publishable, run through OpenRouter.

## 2. What MemBench is (one paragraph)

One question: **does an agent with model X's notes redo less work than an agent
without them?** Phase 0 is a go/no-go gate (10 sessions, hand-written *oracle* memory
vs *no* memory, 60 runs, one week) that tests whether observation-memory moves the
needle at all — green light at ≥25% oracle cost-lift (gut-check this threshold before
starting; it's the one made-up number that decides anything). Phase 1 is the minimal
real benchmark: 30 sessions × 4 arms (Baseline / Oracle / Candidate-per-model) × 3
runs, pinned executor. Headline metric: **Re-work Delta**. No composite score. Gold
facts derived *backwards* from follow-up tasks. All results published including where
Claude loses. `OBSERVATION.md` ships as the interface competitors implement to get on
the board. Full details in the v0.2 spec — read it first.

## 3. Immediate deliverable: the cost estimate for Alex

Do this **before** Phase 0 — it's cheap, it's owed, and it de-risks the credit ask.

**Protocol (a few dollars, ~1 hour):**
1. Pick 3–5 real session transcripts (sanitized) of varying length.
2. For each candidate model, run the actual claude-mem observation-generation prompt
   over each transcript **via OpenRouter** with `usage: {include: true}` — the
   response's `usage.cost` field returns real credits charged (the plugin's
   `OpenRouterProvider` and the swebench harness client both already do this).
3. Record per-session: prompt tokens, completion tokens, cost. Average per model.
4. Extrapolate the full Phase 1 matrix:
   - **Observer side:** 30 sessions × N models × 1 generation pass.
   - **Executor side:** 30 sessions × (2 + N) arms × 3 runs × avg executor cost
     (only counts against OpenRouter credits if the executor also runs through
     OpenRouter — decide this; see §6 open decisions).
   - Add judge costs (task success / re-derivation / grounding audits).
5. Send Alex: per-model per-session cost, total projected spend for Phase 1, and a
   stretch number for the v1.0 matrix. Offer the citation language in the same message.

**Model slate for the OpenRouter run** (adapted from spec §3 — the spec's slate mixes
local models; for the credits-funded track everything routes through OpenRouter):
- `anthropic/claude-sonnet-4-6` (frontier)
- `anthropic/claude-haiku-4-5` (the fleet-dominant default, 66% of sessions)
- `qwen/qwen3.6-27b` (open-weight mid)
- `deepseek/deepseek-v4-flash` (the fleet's surprise over-performer: 6.08 obs/session)
- `openai/gpt-oss-20b` or `openai/gpt-oss-120b` (open-weight, structure pedigree)
- Keep `xiaomi/mimo-v2-flash:free` in mind — it's claude-mem's current OpenRouter
  default and shows 0% observer success in fleet data; benchmarking it is a product
  decision, not just a leaderboard row.
- Local-vs-API constrained-decoding asymmetry (local = 0% invalid via grammar
  enforcement) stays a *published finding*, but the OpenRouter track measures the
  serving reality users actually get through the API path.

## 4. Codebase grounding (verified in-repo, don't re-derive)

**Observation format & parsing:**
- XML schema the observer must emit: `src/sdk/prompts.ts` — tags include
  `<observation>`, `<title>`, `<narrative>`, `<facts>/<fact>`,
  `<concepts>/<concept>`, `<files_read>`, `<files_modified>`, `<outcome>`,
  `<next_steps>`, `<summary>`, etc.
- Parser: `src/sdk/parser.ts` — regex-extracts `<observation>...</observation>`
  blocks, returns `{valid, observations, summary}`. **Parse validity here = the
  Structure Gate** from the spec. The "smart models ignore XML" finding from PostHog
  is measurable directly with this parser.
- Observation types (`obs_type`): bugfix, feature, decision, discovery, change
  (see mem-search skill / SearchRoutes).

**Provider plumbing (reuse, don't rebuild):**
- `src/services/worker/OpenRouterProvider.ts` — the production observation path via
  OpenRouter: chat-completions, `usage.include` cost accounting, error taxonomy
  (quota/rate-limit/auth/transient), `CLAUDE_MEM_OPENROUTER_*` settings.
- `swebench/` package (this branch, previous session) — a self-contained Bun/TS eval
  harness with directly reusable parts: standalone OpenRouter tool-calling client with
  retry + real cost capture (`swebench/src/openrouter.ts`), settings-compatible config
  resolution (`config.ts`), process runner (`exec.ts`), per-instance orchestration →
  JSONL artifacts pattern (`runner.ts`), offline mock-provider test pattern
  (`test/solver.test.ts`). A `membench/` sibling package following the same shape is
  the fastest path. Note: swebench/ (SWE-bench correctness eval) is **not** MemBench —
  it's adjacent infra and a possible future "memory helps SWE-bench" arm.

**Telemetry (the Fleet Track — corroborates, never scores):**
- `observer_turn_rollup` — fires at session end; `observations_created`, `top_model`,
  outcome (ok/invalid/error), fabrication counts. This is the source of the fleet
  numbers already computed (Haiku 25% invalid; Opus 5.2 obs/session; deepseek 6.1;
  locals 0% invalid).
- `session_compressed` — per pipeline op; `tokens_input/output`, `cost_usd`,
  `compression_ratio`. **Do not** use it as per-session (that was the earlier
  analysis mistake — it fires per operation).
- `context_injected` — carries `tokens_saved_vs_naive` (the production reuse-value
  proxy) plus depth/economics stats.
- Known data caveats to publish verbatim: ~20% field coverage on count fields, ~13%
  `unknown` model attribution, model-name fragmentation (haiku /
  claude-haiku-4-5 / claude-haiku-4-5-20251001 need a normalization map first).

**Transcript access for the corpus:** claude-mem's own DB (`~/.claude-mem/claude-mem.db`,
sessions + observations + prompts) and Claude Code transcripts are the corpus source;
sanitization pipeline per spec §2 (v0.2) before anything is frozen.

## 5. Environment constraints (learned the hard way)

- **This remote Claude Code environment blocks `openrouter.ai` and `huggingface.co`**
  (proxy 403) and has no Docker daemon. All spec/harness/test development works here
  (the swebench package's offline tests prove the pattern); **live OpenRouter calls —
  including the cost test run — must run on a machine with network access** (Alex
  Newman's local machine with the worker running, or an env with an open network policy).
- Harness style: Bun + TypeScript, zero runtime deps, offline-testable with mock
  providers — same as `swebench/`. All pure logic must be verifiable without network.

## 6. Open decisions (decide early, cheap to change now)

1. **Phase 0 green-light threshold** — spec says 25% oracle cost-lift; Alex (Newman)
   must gut-check what "memory is working" means to him before week 1.
2. **Executor routing** — does the executor (the agent doing follow-up tasks) also run
   through OpenRouter (burns credits, single-vendor story, easier cost accounting) or
   stay on Claude Code defaults (matches production reality)? Affects the cost
   estimate materially — present both numbers to Alex.
3. **Judge model + conflict rule** — pinned judge per spec §5; if judging Claude rows
   with a Claude judge, spot-check at 30% per the spec.
4. **Where MemBench lives** — recommendation: `membench/` package in this repo
   (mirroring `swebench/`), specs stay in `plans/membench/`, harness goes public with
   the corpus at launch per integrity rule #1.

## 7. Build order for the new session

1. Read `plans/membench/membench-spec-v0.2.md` in full. Skim v0.1 only as roadmap.
2. Scaffold `membench/` (copy the `swebench/` package shape).
3. **Cost-probe command first** (`membench cost-probe`): run the real observation
   prompt (`src/sdk/prompts.ts`) over N local transcripts × M OpenRouter models,
   capture `usage.cost`, emit the extrapolation table for Alex. Offline-test it with
   the mock-provider pattern; live run happens on a networked machine.
4. Draft the message to Alex with the numbers + citation language.
5. Phase 0 harness: transcript replay, oracle-injection format (reuse
   `/api/context/inject` output shape), run logger (tokens/turns/success per arm).
6. Then follow the spec's week 2–4 plan.

### Paste-ready kickoff prompt for the new session

> Read `plans/2026-07-29-membench-openrouter-kickoff.md` and
> `plans/membench/membench-spec-v0.2.md`, then start executing the build order in
> kickoff §7. First deliverable is the OpenRouter cost probe (§3): scaffold the
> `membench/` package mirroring `swebench/`'s conventions, implement `cost-probe`
> with offline tests, and prepare the cost-estimate table + message draft for Alex
> Atallah. Flag the §6 open decisions that need my input as you hit them.
