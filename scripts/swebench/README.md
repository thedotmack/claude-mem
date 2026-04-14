# SWE-bench Verified runner (Claude Code + claude-mem)

Runs the [SWE-bench Verified](https://www.swebench.com/) benchmark against
Claude Code with the claude-mem plugin active. Each task is solved by a
headless `claude --print` invocation whose prompt is prefixed with the custom
instruction:

```
use the /make-plan and /do skill to <problem_statement>
```

The runner only **generates predictions** (`predictions.jsonl` in SWE-bench
format). Scoring is done by the official SWE-bench harness via the companion
`evaluate.sh` wrapper.

## Prerequisites

1. **Claude Code CLI** on `PATH` (`claude --version` should work) with a valid
   login or `ANTHROPIC_API_KEY`.
2. **claude-mem plugin installed and enabled** in the user's Claude Code
   config. Confirm the worker is up:
   ```bash
   npm --prefix ~/.claude/plugins/marketplaces/thedotmack run worker:status
   ```
   The `/make-plan` and `/do` skills ship with the plugin
   (`plugin/skills/make-plan/SKILL.md`, `plugin/skills/do/SKILL.md`).
3. **Python 3.10+** with `datasets` installed (for dataset loading):
   ```bash
   uv pip install datasets          # or: pip install datasets
   ```
4. **Docker** (only needed for `evaluate.sh`, not for generating predictions).

## Generate predictions

```bash
python scripts/swebench/run.py \
  --split test \
  --predictions scripts/swebench/out/predictions.jsonl \
  --concurrency 4
```

Useful flags:

| flag | purpose |
|------|---------|
| `--instance-id <id>` | run a single task (repeatable) |
| `--max-tasks N`      | smoke-test the first N tasks |
| `--concurrency N`    | run N Claude Code sessions in parallel |
| `--per-task-timeout` | wall-clock cap per task (default 45m) |
| `--model`            | pass through to `claude --model` |
| `--permission-mode`  | `bypassPermissions` (default) for unattended runs |
| `--keep-workdirs`    | retain per-task clones for debugging |
| `--no-resume`        | overwrite instead of appending |

The script resumes by default: on restart it skips any `instance_id` already
present in the predictions file.

## Evaluate

```bash
scripts/swebench/evaluate.sh scripts/swebench/out/predictions.jsonl
```

This shells out to `python -m swebench.harness.run_evaluation` with
`--dataset_name princeton-nlp/SWE-bench_Verified`. Results land under
`./logs/run_evaluation/<run_id>/` and `./evaluation_results/`.

## Prediction format

Each line of `predictions.jsonl` is:

```json
{"instance_id": "...", "model_name_or_path": "claude-mem", "model_patch": "<unified diff>"}
```

This is the canonical SWE-bench predictions schema; it can be fed to any
SWE-bench-compatible evaluator.

## Notes on reproducibility

- `model_name_or_path` defaults to `claude-mem` — override with `--model-name`
  to tag runs (e.g. `claude-mem-opus-4.6`).
- claude-mem's session database (`~/.claude-mem/claude-mem.db`) accumulates
  memory across tasks. If you want clean-room tasks, wipe it between runs; if
  you want to study memory carry-over, leave it.
- Each task runs in an isolated `git clone` under `--workroot`
  (default `$TMPDIR/claude-mem-swebench`). Workdirs are deleted on success
  unless `--keep-workdirs` is passed.
