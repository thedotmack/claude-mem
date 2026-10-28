# Endless Mode validation

Tools to check our Endless Mode numbers on your own machine. Everything runs from this checkout's source and writes
only under `.scratch/endless-mode-validation/` (gitignored). Your real `~/.claude`, `~/.codex` and claude-mem data
dir are only read. Logins are read from your own credentials, read only, and are never printed or written.

Needs: macOS or Linux, `zsh` (forward runs), `bash`, `bun` (run `bun install` once), `python3` (3.9+), `jq`, `git`, `curl`,
`lsof`, `shasum`, plus Claude Code (and Codex for `EMV_AGENT=codex`) logged in.

## Backtest your own sessions (no agent calls, no cost)

```sh
scripts/endless-mode-validation/backtest/run.sh --top 10 --days 30 [--with-compactions]
```

Step 1 simulates your sessions as they really ran and compares that with the usage Claude Code recorded. If it does
not agree closely enough (at least 95% of requests, total cost within 2%; the reasons are in `backtest/validate.py`),
the run stops and reports no Endless Mode numbers. Output: `.scratch/endless-mode-validation/backtest/<name>/out/summary.md`
(sessions appear as s01, s02, ...; no ids, paths or content).

## Forward run (real agents; uses your plan or API quota)

```sh
EMV_CLAUDE_BIN=~/.local/bin/claude scripts/endless-mode-validation/forward/run.sh <turns> [none off timeline observation]
```

Runs the scripted session (`forward/prompts200.txt`) for `<turns>` turns in each configuration side by side, each
in its own isolated stack, then writes `results/tables.md` (numbers only) and the judges' artifacts. Continue a run
with the same `EMV_RUN_NAME` and `EMV_FIRST_TURN`. Settings are listed at the top of `forward/lib/env.sh` and
`forward/run.sh`. `EMV_MODEL_PROFILE=openrouter-deepseek-flash` runs the agent and the observer on OpenRouter's
`~deepseek/deepseek-flash-latest` (needs an OpenRouter key in `OPENROUTER_API_KEY`).

Tests: `bun test tests/scripts/endless-mode-validation.test.ts`. Typecheck: `bun run typecheck`.
