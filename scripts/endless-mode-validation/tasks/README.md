# Task benchmark: Endless Mode vs plain Claude Code on real coding exercises

The forward and backtest tools next door measure cost. This one adds the other three measures: whether the work gets
done, whether it is right, and how long it takes, all from one run.

## What a run does

- **Tasks:** the Python set of [Aider's polyglot benchmark](https://github.com/Aider-AI/polyglot-benchmark) (34 of
  Exercism's hardest Python exercises), graded by each exercise's own hidden tests.
- **One long session per run:** an opening turn sets a standing rule, then every exercise is one more turn of the same
  Claude Code session (`claude -p --resume`). The conversation grows the way a real long session does.
- **Aider's protocol:** the agent sees the instructions and the stub, never the tests. If the hidden tests fail, the
  next turn shows the last 50 lines of the failing output and asks for a fix (two tries in all).
- **Two arms, side by side, same model, same exercises in the same order:**
  - `plain`: Claude Code straight to the API (through a recording proxy only).
  - `endless`: Claude Code through this checkout's wire gateway with memory injection, the durable header and Endless
    Mode on, and a claude-mem worker whose observer writes the observations Endless Mode folds in.
- **Standing rule check:** the opening turn asks for a fixed first line in every solution file. Each graded exercise
  records whether its files still follow it. This is not part of Aider's benchmark; it checks that an early instruction
  survives the session.

## What it measures

Everything comes from the run itself:

- **Completion:** exercises whose hidden tests all pass after up to two tries, and after the first try.
- **Quality:** hidden tests passed, and the standing rule kept.
- **Time:** wall time of each turn (includes any wait the gateway adds).
- **Cost:** every request's usage as the API returned it, captured by a recording proxy (`forward/tee-proxy.ts`),
  priced at list prices (`extract.py`). The observer's requests have their own proxy, so its cost is counted in the
  Endless arm. Whole-session cost is the sum over the session (cumulative). Context size is reported per request.

The per-request cost sum matches the `total_cost_usd` Claude Code itself reports for the session.

## Run it

Needs Linux or macOS, `bash`, `bun` (`bun install` once), `python3` with `pytest`, `jq`, and Claude Code logged in.

```sh
git clone --depth 1 https://github.com/Aider-AI/polyglot-benchmark /tmp/polyglot-benchmark
EMV_BENCH=/tmp/polyglot-benchmark/python/exercises/practice \
  scripts/endless-mode-validation/tasks/run_all.sh .scratch/endless-mode-validation/tasks/run1 3 --model claude-haiku-5-5
python3 scripts/endless-mode-validation/tasks/report.py --db .scratch/endless-mode-validation/tasks/run1/results.sqlite
```

`run_all.sh <out> <runs per arm> [run_session.py options]` starts each run in its own sandbox (its own HOME, Claude
config dir and claude-mem data dir, ports from 39100 and 39200 up), runs them side by side, then extracts usage.
`--exercises a,b,c` or `--limit N` runs fewer exercises.

Long sessions and compaction:

- `--sessions N` splits the exercises across N sessions in order. Only the first is told the standing rule; each later
  one starts fresh (no `--resume`), the way you pick work up the next day, so the rule check shows whether it carried
  over through memory.
- `--compact-window T --compact-pct P` makes Claude Code compact sooner, so a short benchmark reaches a compaction.
  Claude Code refuses a window under 100,000 tokens, so set the window to 100000 and lower the percent instead
  (`--compact-window 100000 --compact-pct 35` compacts near 35K tokens). The report counts each session's compactions,
  read from Claude Code's own transcript.
- Compaction requests go through the same recording proxy, so their cost is in the agent's cost. Endless Mode stops
  folding once the agent compacts (a compaction rewrites the history it had folded).

An output dir, run directory or run id is never reused: a rerun into one would mix old turns and requests into the new
run. Every stack is stopped when `run_all.sh` ends, fails or is interrupted. Before extraction it waits until each
observer has finished what the session sent it, and the report counts any response that was cut off.

Credentials: an `ANTHROPIC_API_KEY` in your environment goes to the agent; otherwise your Claude Code login
(`EMV_CLAUDE_OAUTH_TOKEN`, the macOS keychain or `~/.claude/.credentials.json`, read only, never written) goes to the
agent as `CLAUDE_CODE_OAUTH_TOKEN` before every turn, and to the observer through its recording proxy. The observer uses
the Claude Code login only.

The agent runs with a narrow tool allowlist (file tools, `python`, `pytest`, `ls`, `cat`), not with permissions
bypassed. Its solutions are graded with a bare environment and a throwaway HOME, but not in a sandbox: run the benchmark
on a machine you would let the agent work on.

## Results file

`results.sqlite` has three tables:

- `runs`: one row per run (arm, model, exercises, Claude Code version, sessions, compaction settings).
- `turns`: one row per turn (time, Claude Code's own error flag and reported cost, tests passed and run, rule kept,
  which session, compactions so far).
- `requests`: one row per API request (source `agent` or `observer`, turn, model, input, cache write, cache read and
  output tokens, prompt size, cost at list prices, cost at Opus 5.5's flat prices).
