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

### Why the slash-prefixed prompt works in `-p` mode

Per [the Claude Code headless docs](https://code.claude.com/docs/en/headless.md),
slash commands are **not expanded** in `--print` mode. This runner still sends
the literal `/make-plan` and `/do` tokens because the claude-mem skills
(`plugin/skills/make-plan/SKILL.md`, `plugin/skills/do/SKILL.md`) are
description-driven: the model auto-invokes them by matching the prompt against
their `description` frontmatter, not by expanding a slash command. Naming the
skills in the prompt is an explicit hint toward that auto-invocation.

## Prerequisites

1. **Claude Code CLI** on `PATH` (`claude --version` should work) with a valid
   login or `ANTHROPIC_API_KEY`. Verified flags used by this runner:
   `--print`, `--permission-mode bypassPermissions` (camelCase), `--model`.
   Reference: [cli-reference](https://code.claude.com/docs/en/cli-reference.md),
   [headless](https://code.claude.com/docs/en/headless.md).
   > Do **not** add `--bare` — it disables plugin auto-discovery and would
   > silently deactivate claude-mem's hooks and skills.
2. **claude-mem plugin installed and enabled** in the user's Claude Code
   config. Confirm the worker is up:
   ```bash
   npm --prefix ~/.claude/plugins/marketplaces/thedotmack run worker:status
   ```
   The make-plan and do skills ship with the plugin
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
`--dataset_name SWE-bench/SWE-bench_Verified` (the canonical id after the
[2025 org rename](https://github.com/SWE-bench/SWE-bench#readme); the old
`princeton-nlp/SWE-bench_Verified` still resolves via HF aliasing but is
deprecated). Harness flag names use underscores, not hyphens. Results land
under `./logs/run_evaluation/<run_id>/` and `./evaluation_results/`.

## Prediction format

Each line of `predictions.jsonl` is:

```json
{"instance_id": "...", "model_name_or_path": "claude-mem", "model_patch": "<unified diff>"}
```

These three keys are the full schema the harness reads — see
[`swebench/harness/constants/__init__.py:66-68`](https://github.com/SWE-bench/SWE-bench/blob/main/swebench/harness/constants/__init__.py#L66-L68).
Extra keys are ignored. `model_patch` is written verbatim to a patch file and
fed to `git apply` inside the per-instance Docker container, so it must be a
plain unified diff (no `--binary` hunks).

## Notes on reproducibility

- `model_name_or_path` defaults to `claude-mem` — override with `--model-name`
  to tag runs (e.g. `claude-mem-opus-4.6`).
- claude-mem's session database (`~/.claude-mem/claude-mem.db`) accumulates
  memory across tasks. If you want clean-room tasks, wipe it between runs; if
  you want to study memory carry-over, leave it.
- Each task runs in an isolated `git clone` under `--workroot`
  (default `$TMPDIR/claude-mem-swebench`). Workdirs are deleted on success
  unless `--keep-workdirs` is passed.
