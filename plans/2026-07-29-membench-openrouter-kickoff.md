# MemBench × OpenRouter — What We're Benchmarking

**Purpose of this doc:** give a fresh Claude Code session everything it needs to design
and build MemBench *from a clean slate*. Written 2026-07-29.

**Important framing:** prior design drafts exist at
[`plans/membench/membench-spec-v0.2.md`](membench/membench-spec-v0.2.md) and
`membench-spec-v0.1.md`. They came out of a long, stressed design session. Treat them
as **reference material — one prior attempt at a methodology — not as the plan.**
This doc deliberately avoids prescribing protocol, phases, arms, thresholds, weights,
or build order. It defines *what we are trying to measure and why*. The methodology
should be re-derived with fresh eyes, and only then compared against the old specs to
see what they got right.

---

## 1. Partnership context (facts, not design)

- **Alex Atallah (OpenRouter co-founder) has agreed to donate OpenRouter credits**
  for the benchmark runs (X DM, Jul 26, 2026). His two asks:
  1. **Citation** — OpenRouter credited in whatever gets published.
  2. **A cost estimate** — he asked "how much do you think inference will cost?" and
     we promised a test run + numbers. **This is owed, and it's the first deliverable.**
     What it must contain: per-model cost to generate observations for a typical
     session, and a projected total for the full benchmark matrix (with the
     executor-inference question — see §5 — priced both ways).
- Strategic urgency: Stripe is reportedly exploring a ~$10B acquisition of OpenRouter
  (PYMNTS, 2026). A published, OpenRouter-powered, citable benchmark lands at the
  right moment for the relationship.
- The pitch Alex already bought, verbatim from the DM: test models for **"observation
  quality, and value for re-use as it compares to others"** — "benchmarking the actual
  value of memory and the content quality of the memory is a genuinely novel
  benchmark, and Claude-Mem is built for this."

## 2. The category MemBench sits in

Existing memory benchmarks (LongMemEval, LoCoMo, needle-in-haystack) measure
**recall**: can a system retrieve a fact someone planted. claude-mem doesn't play that
game and never did. MemBench measures the *other* side, which nobody benchmarks:

1. **Writing:** given a real working session, does a model write down the *right
   things* — accurately, in the required structure, at reasonable cost?
2. **Reading:** when those notes are injected into a *future* session, do they
   actually make the work cheaper, faster, or more successful?

Headline we're building toward: **"This Model Is Best for Memory."**
Non-goal, stated loudly: perfect recall accuracy. Not what claude-mem does.

## 3. What we are benchmarking — the measurement targets

### A. Observation production (per model, identical input transcripts)

Every candidate model sees the same session transcript(s) and the same production
observation prompt. We want to know, per model:

**A1. Structure compliance.** Does the output parse through claude-mem's real parser?
The observer must emit a specific XML schema (defined in `src/sdk/prompts.ts`:
`<observation>`, `<title>`, `<narrative>`, `<facts>/<fact>`, `<concepts>/<concept>`,
`<files_read>`, `<files_modified>`, `<outcome>`, `<next_steps>`, summary blocks) and
`src/sdk/parser.ts` accepts or rejects it. Specifics to capture:
- Parse success / invalid-output rate per model.
- **The known phenomenon to quantify:** PostHog fleet data suggests *stronger* models
  (Sonnet, Opus) are *worse* at this — they ignore the XML formatting instructions
  and produce conversational output that won't parse (fleet proxy: Haiku ~25%
  invalid, Sonnet 4.5 ~19%, Opus ~4.5%), while locally-served models show ~0% invalid
  because their runtimes enforce grammar-constrained decoding. So structure is partly
  a *serving-stack* property, not just a model property. We want this split measured
  and published: same model, API-served vs constrained-served, where possible.
- Partial-failure modes: parses but empty; parses but drops fields; wrong tag nesting.

**A2. Yield / frequency.** How much does the model observe?
- Observations per session and per turn.
- Share of sessions producing ≥1 observation (fleet medians are 0 almost everywhere —
  means ride on a long tail, so distributions matter, not just averages).
- Over- vs under-observing: noise/duplicate rate at the high end (fleet flag:
  gemini-2.5-flash-lite at ~4 obs/session looked like over-emission, not diligence).

**A3. Grounding / fabrication.** Is each observation supported by what actually
happened in the transcript? Rate of unsupported or partially-supported claims.
This is the trust axis — a memory system that confabulates is worse than none.
(Fleet proxy exists: `fabrication_count`; fleet data hints expensive models
confabulate *more* — Opus ~10/1K obs vs ~0 for locals — verify, don't assume.)

**A4. Classification quality.** claude-mem observations carry a type
(`bugfix, feature, decision, discovery, change`) plus tags and file references:
- Type fidelity: is a bugfix actually labeled bugfix?
- Laziness: share dumped into catch-all/"other" (fleet: qwen3-8b ~47% vs
  qwen3.5-27b ~26%).
- Tag usefulness and file-reference accuracy (`files_read`/`files_modified`
  matching reality).

**A5. Content quality.** The judged, softer axes:
- Atomicity (one claim per observation vs run-on blobs).
- Salience (would a senior engineer have written this down?).
- Compression density: transcript tokens in → observation tokens out (fleet:
  Claude models compress 128–322x vs 9–44x for locals — the one axis where
  frontier models clearly won in fleet data).

**A6. Cost.** Tokens and dollars per session processed and per *valid* observation
produced (OpenRouter's `usage.cost` gives real dollars). This feeds both the
leaderboard (value-per-dollar) and the estimate owed to Alex.

### B. Memory re-use value (the part that makes this novel)

Given observations written by model X from session 1, injected into a future session
working a related follow-up task on the same repo — versus the same task with no
memory — we want to know:

**B1. Re-work.** How much does the agent re-derive from scratch (re-reading files,
re-running commands, re-discovering constraints) that was *already in the notes*?
This is the metric with a headline sentence attached: *"With model X's memory, the
agent redid N% less work."*

**B2. Efficiency.** Tokens and turns to complete the follow-up task, with vs without
memory. (Production proxy that should corroborate: `context_injected` carries
`tokens_saved_vs_naive`.)

**B3. Outcomes.** Task success rate delta — does memory ever make the difference
between finishing and failing, not just cheaper?

**B4. The ceiling.** How does model-X memory compare not just to *nothing* but to
*perfect* memory (hand-written ideal notes)? This bounds every other number: if even
perfect memory doesn't help, observer ranking is meaningless — and that itself is a
finding that redirects claude-mem (toward injection/retrieval rather than observation
quality). Every model's lift should be expressible as a % of the oracle ceiling.

**B5. Failure attribution.** When memory didn't help, which failure was it?
- The observer never wrote the needed fact (writing failure), vs.
- The fact was written but the executor ignored it (reading/trust failure).
These need to be separable, because they indict different parts of the system.

**B6. Interaction effects (acknowledged, even if deferred).** Re-use value is a
property of the observer × executor *pair* — an executor may distrust or
under-read injected context regardless of note quality. Any absolute claim needs
this caveat; whether to rotate executors is a methodology decision for fresh eyes.

### C. The comparisons we want to publish

- **Which model is best for memory** — overall and per axis (no pre-committed
  composite; the old spec's weights were admitted fiction).
- **Value per dollar** — best memory per credit spent (the OpenRouter-native angle).
- **Open-weight vs frontier** — fleet data suggests locals/open models beat frontier
  on structure and grounding while frontier wins compression and salience; the
  benchmark should confirm or kill this, and *published-where-Claude-loses* is the
  credibility engine.
- **API-served vs grammar-constrained serving** — same model, different serving,
  structure outcomes.
- **Does observer capability correlate with downstream value?** The open question
  underneath everything: fleet yield correlates with model strength, but nobody knows
  if *value* does.

### D. Fleet corroboration (production telemetry as the reality check)

Production data never scores the benchmark but should corroborate it. Sources and
their known caveats (publish caveats verbatim):
- `observer_turn_rollup` — fires once per session end; `observations_created`,
  `top_model`, outcome (ok/invalid/error), fabrication counts. The correct
  per-session source.
- `session_compressed` — fires **per pipeline operation, not per session** (this
  mistake was already made once in analysis; documented so it isn't repeated);
  carries `tokens_input/output`, `cost_usd`, `compression_ratio`.
- `context_injected` — `tokens_saved_vs_naive` and injection-depth stats.
- Caveats: ~20% field coverage on count fields; ~13% of sessions attribute to
  `unknown` model; model-name fragmentation (`haiku` / `claude-haiku-4-5` /
  `claude-haiku-4-5-20251001`) needs a normalization map before any public chart.

## 4. Candidate model pool (through OpenRouter, per the deal)

Not a locked slate — a pool the methodology can draw from, chosen for story coverage:
- `anthropic/claude-sonnet-4-6` and `anthropic/claude-haiku-4-5` — frontier vs the
  fleet-dominant default (~66% of production sessions run Haiku).
- `qwen/qwen3.6-27b` — open-weight mid, best in-the-wild local record.
- `deepseek/deepseek-v4-flash` — fleet's surprise over-performer (~6 obs/session, low
  fabrication).
- `openai/gpt-oss-20b` / `gpt-oss-120b` — open-weight with structure pedigree.
- `xiaomi/mimo-v2-flash:free` — claude-mem's current OpenRouter *default*, showing 0%
  observer success in fleet data. Benchmarking it is also a product decision about
  our own default.
- Optionally 1–2 locally-served models to instantiate the serving-stack comparison
  (§3-A1, §3-C).

## 5. Constraints and assets (facts the design must respect)

- **This remote Claude Code environment blocks `openrouter.ai` and `huggingface.co`**
  (proxy 403) and has no Docker daemon. Harness code and offline tests can be built
  here; **any live inference — including Alex's cost probe — runs on a networked
  machine** (e.g. Alex Newman's local machine with the claude-mem worker up).
- **Reusable infra already in this repo** (built last session, tested offline):
  `swebench/` — Bun/TS eval harness with a standalone OpenRouter tool-calling client
  incl. retry + real `usage.cost` capture (`swebench/src/openrouter.ts`),
  settings-compatible config resolution, process runner, JSONL artifact pattern, and
  a mock-provider offline test pattern. It's adjacent infra (SWE-bench correctness
  eval), not MemBench — but the package shape is proven here.
- **Production pieces to reuse rather than reimplement:** the observation prompt
  (`src/sdk/prompts.ts`), the parser (`src/sdk/parser.ts`), the OpenRouter provider
  conventions (`src/services/worker/OpenRouterProvider.ts`), context-injection format
  (`/api/context/inject`). The benchmark should exercise claude-mem's *real* pipeline
  surfaces, not a parallel reimplementation of them.
- **Corpus source:** claude-mem's own DB (`~/.claude-mem/claude-mem.db`) and Claude
  Code transcripts. Anything frozen into a corpus needs secrets/PII sanitization
  first.
- **Executor-inference question** (affects Alex's number materially): the follow-up
  task executor can run through OpenRouter (burns donated credits, single-vendor
  cost accounting) or on Claude Code defaults (matches production reality). Price
  both; decide with fresh eyes.

## 6. Integrity commitments (carried forward — these aren't methodology)

1. Every published number reproducible from an open harness + corpus.
2. All results published, **including where Claude models lose** — fleet data says
   they will on some axes, and that's what makes the benchmark believable.
3. No silent metric changes; versioned corpus/judge/prompts.
4. OpenRouter cited.

---

### Paste-ready kickoff prompt for the new session

> Read `plans/2026-07-29-membench-openrouter-kickoff.md` — it defines WHAT MemBench
> measures and the constraints, deliberately not the methodology. Design the
> methodology fresh: propose how you'd measure the §3 targets, in what order, and at
> what cost — then (and only then) compare your design against the prior attempt in
> `plans/membench/membench-spec-v0.2.md` and note where you differ and why. First
> concrete deliverable: the OpenRouter cost estimate owed to Alex Atallah (§1),
> priced both ways per §5. Surface any decision that needs my input as you hit it.
