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

## The 2 numbers that matter

1. **Tokens to done** (vs no-memory floor, vs oracle ceiling)
2. **Success rate** (pre-written pass/fail check per task)

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
- 🧾 every run auditable (full transcripts + diffs kept)

**Runnable by anyone. That's the credibility.**

---

## Why us

- 🥇 Only claude-mem has **real session N → session N+1 data** (tasks come from
  what the user *actually did next* — no made-up tasks)
- 🔌 Real production pipeline (observation prompt, parser, injection) — we
  benchmark the actual product, not a toy
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
4. Live cost probe runs on **your machine** (this remote env blocks openrouter.ai)
5. Send Alex the cost table 💸

## Don't forget ⚠️

- Publish results **even where Claude loses** — that's the credibility engine
- k≥3 runs per fork (executors are random-ish)
- Count ≠ value. Never headline count.
- Full details: `plans/2026-07-29-membench-openrouter-kickoff.md`
