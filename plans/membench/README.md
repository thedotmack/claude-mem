# MemBench — TL;DR 🧠

**One question:** which model writes memory that actually helps later?

**One sentence:** same transcript → every model writes its own observations →
fork the session per variant → same task → count tokens, check success.

---

## The loop

```
transcript ──→ all models observe it (parallel, OpenRouter)
                        │
                        ▼
        one fork per model's observations
        + 3 controls: none · oracle · shuffled
                        │
                        ▼
        every fork does the SAME task
                        │
                        ▼
        📊 tokens used  +  ✅/❌ success
```

That's it. Better memory = fewer tokens, more successes.

---

## The questions we're answering ❓

| # | Question | How we answer it |
|---|---|---|
| 1 | **Which model is best at writing memory — and discerning what's most valuable?** | The scoreboard. Best memory = highest success + fewest tokens vs the no-memory floor. *Discernment* = % of oracle savings captured — a model that writes down the *right* things gets close to the hand-written ceiling; a model that writes noise doesn't. |
| 2 | **Does good memory actually reduce token usage when a new session performs the task?** | Directly measured by the fork loop: same task, same repo, only the memory differs. `tokens(model fork)` vs `tokens(no-memory fork)`, k≥3 runs, mean ± spread. |
| 3 | **Does the executor actively use mem-search? How often?** | Forks run with the claude-mem worker live and the mem-search skill available — not just static injection. We count every `search` / `timeline` / `get_observations` call per run (`mem_search_calls` in `results.jsonl`). |
| 4 | **Do some models' observations require MORE mem-searching?** | **Search burden** metric: mem-search calls per run, grouped by observer model. High burden = the injected memory wasn't sufficient or well-prioritized — the executor had to dig. Low burden + low tokens = the memory led with what mattered. |
| 5 | **Is there drift — new features or unexpected work?** | **Scope check** on every fork's diff: judge compares output against `task.md`, flags out-of-scope work (`drift_flag` + note in `results.jsonl`). Drift rate per observer model — and whether drift correlates with misleading/fabricated observations. |

---

## The 2 headline numbers

1. **Tokens to done** (vs no-memory floor, vs oracle ceiling)
2. **Success rate** (pre-written pass/fail check per task)

Supporting: 🔍 search burden (Q3/Q4) · 🌀 drift rate (Q5).
Everything else (obs count, XML parsing, tags) = diagnostics. Not the story.

## The 3 controls (why anyone will believe us)

| Control | Proves |
|---|---|
| 🚫 No memory | the floor — what memory has to beat |
| 🎯 Oracle (hand-written perfect notes) | the ceiling — "model X got 71% of the way" |
| 🔀 Shuffled (wrong session's notes) | value comes from *content*, not vibes |

---

## What we ship

- 📦 `corpus/` — transcripts + tasks + pass/fail checks (frozen, versioned)
- ⚙️ `membench/` — one command runs everything, spits out a scoreboard
- 🧾 every run auditable (full transcripts + diffs + mem-search logs kept)

**Runnable by anyone. That's the credibility.**

---

## Why us

- 🥇 Only claude-mem has **real session N → session N+1 data** (tasks come from
  what the user *actually did next* — no made-up tasks)
- 🔌 Real production pipeline (observation prompt, parser, injection,
  mem-search) — we benchmark the actual product, not a toy
- 📈 50M+ sessions of telemetry to sanity-check lab results

## The OpenRouter deal 🤝

- Alex Atallah donates credits → **we owe him a cost estimate FIRST**
  (run 2–3 items, read real `usage.cost`, extrapolate, send numbers)
- OpenRouter gets cited in everything published
- All models run through OpenRouter

---

## Do next ▶️

1. Open a fresh Claude Code session
2. Paste the kickoff prompt (bottom of
   `plans/2026-07-29-membench-openrouter-kickoff.md`)
3. It builds `membench/` + 5-item corpus, offline-tested
4. Live cost probe runs on **a local machine** (remote Claude Code envs block openrouter.ai)
5. Send Alex the cost table 💸

## Don't forget ⚠️

- Publish results **even where Claude loses** — that's the credibility engine
- k≥3 runs per fork (executors are random-ish)
- Count ≠ value. Never headline count.
- Full details: `plans/2026-07-29-membench-openrouter-kickoff.md`
