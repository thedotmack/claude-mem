# File Read Gate eval

Proves the File Read Gate (`CLAUDE_MEM_FILE_READ_GATE_ENABLED`) in real Claude Code sessions against real claude-mem workers:

- **Gate ON** (the default): a Read of a whole code file of 32 KB or more that has observations is denied, and Claude still answers a question about the file and edits it. It gets what it needs from `smart_outline` / `smart_unfold`, `get_observations`, or a Read with `offset` and `limit`. A targeted Read also satisfies Edit's read-before-edit rule. A smaller file is read normally, with its timeline as context.
- **Gate OFF**: the same Read goes through, with the file's observation timeline added as context, and nothing is denied.
- **Savings**: on the large file, gate ON costs less per run than gate OFF.

Run from the repo root:

```bash
npm run build                                # the runner refuses a worker built without the gate, and an async Read hook
npm run eval:read-gate -- --preflight-only   # no model: the real hook against both workers
npm run eval:read-gate                       # 3 cases x 3 runs on claude-sonnet-5-5
npm run eval:read-gate -- --runs 1 --case gate-on-edits-file
```

| Flag | Default | Effect |
| --- | --- | --- |
| `--runs <n>` | `3` | Runs per case |
| `--model <id>` | `claude-sonnet-5-5` | Agent model; must be an explicit Claude model ID |
| `-j <n>` | `3` | Runs in flight at once (1-8) |
| `--max-cost-usd <usd>` | `10` | Passed to `claude plugin eval`: no new run starts once the list-price estimate reaches it |
| `--case <glob>` | all cases | Passed through as `--case`; verdicts for cases that did not run are reported as not run |
| `--preflight-only` | off | Stop after the pre-flight; no model is called |

The suite lives in `evals/read-gate/`, outside `plugin/`, because marketplace installs copy `plugin/` from git and none of them needs it. `claude plugin eval --eval-dir` only reads a directory below the plugin, so the runner copies the suite to `plugin/evals-read-gate/` (gitignored) for each run and removes it afterwards.

## Cases

| Case | Arm | File | Prompt | Graders |
| --- | --- | --- | --- | --- |
| `gate-on-large-file` | ON | large | How does `carrier-tariffs.ts` price a carrier quote? Walk me through it, and give the per-kilogram rate and minimum charge of the lithium battery surcharge | `read-blocked` (deny marker in the trace), `answer-rate`, `answer-minimum` |
| `gate-off-large-file` | OFF | large | Same question as `gate-on-large-file` | `not-blocked` (no deny marker), `read-used`, `answer-rate`, `answer-minimum` |
| `gate-on-edits-file` | ON | large | Look over the file, then change the lithium battery minimum charge from 22.40 to 24.75; nothing else | `read-blocked`, `edited` and `old-value-gone` (the file after the run) |
| `gate-on-small-file` | ON | small | How does `rate-calculator.ts` price a shipment? Walk me through it, and give the exact rate and minimum fee `calculateRemoteAreaSurcharge` applies | `not-blocked`, `read-used`, `answer-rate`, `answer-minimum` |
| `gate-off-small-file` | OFF | small | Same question as `gate-on-small-file` | `not-blocked`, `read-used`, `answer-rate`, `answer-minimum` |

The large file is `fixture-large/src/shipping/carrier-tariffs.ts`: 941 lines, 49 KB, seven carriers' tariff tables and surcharge functions, with the lithium battery surcharge in the middle. That puts it over the gate's 32 KB deny size and well under the 25,000-token limit of Claude Code's Read tool, beyond which a whole-file Read fails with no gate at all. The small file is `fixture/src/shipping/rate-calculator.ts`: 513 lines, 19 KB, under the deny size. Each lives in its own project, with its own scaffolds (`scaffold-large-gate-on.sh` / `scaffold-large-gate-off.sh` and `scaffold-gate-on.sh` / `scaffold-gate-off.sh`), so a case only ever sees one of them. The numbers each question asks for appear only inside one function. `seed-observations.json` holds six observations, four about the small file and two about the large one, whose titles and facts describe structure but never state those numbers, so a correct answer has to come from the code.

The small-file cases are why the deny size exists. Before it, the gate also denied the small file, and the same question cost Sonnet 6% less with the gate on but Opus 20% more. Opus ran `smart_outline` and then read about 70% of the file through targeted Reads, so the block saved almost nothing and still cost four extra turns, each re-reading the whole context. On the large file the same block saved 35% on Sonnet and 32% on Opus. Now the small file is read normally with the gate on, and the pair checks that it costs what it costs with the gate off.

The prompts ask for a walkthrough of the file, and for a look over it before the edit, because a pointed question never needs a Read. The first version asked only for the two numbers ("What rate and minimum fee does calculateRemoteAreaSurcharge apply?", "change the minimum fee from 4.85 to 5.25"). Claude then answered in 2 to 4 turns with one Grep whose context lines showed the whole 8-line function, and no run in either arm tried a whole-file Read. Grep can't be withheld: `claude plugin eval` always grants the read-only tools (Read, Glob, Grep, Task, ...) whatever a case's `allowed_tools` lists. A question about how the whole file works is what a whole-file Read serves. So the gate-ON runs meet the deny, and the gate-OFF runs read the file normally.

## How a run is isolated

`scripts/eval-read-gate.ts` creates two data dirs under `.scratch/read-gate-eval/<timestamp>/{on,off}/data`. Each gets its own free port, a `settings.json` with the gate on or off, and a copy of one database seeded with the six observations, dated a day ago. It then starts a worker for each. Every case's scaffold (`scaffold-gate-on.sh` / `scaffold-gate-off.sh`, both calling `scaffold-workspace.sh`) copies the fixture into the run's workspace, dates it 2026-01-01 so it is older than the observations, and links the run's `~/.claude-mem` to its arm's data dir. Hooks, the MCP server and the worker of a run therefore share one data dir, as in a real install, and your own `~/.claude-mem` and default worker port are never touched. `claude plugin eval` resolves a case's `scaffold_script` inside the case directory, follows the symlink there to the script beside this README, and runs it with the run's workspace as cwd.

The workers' settings keep the eval to the gate:

- `CLAUDE_MEM_SKIP_TOOLS` lists every tool a session can call, claude-mem's MCP tools included, so no run queues observer work.
- Chroma is off, semantic injection is off, telemetry is off, and logs are at DEBUG in `data/logs/`.

The real MCP server runs (`--mocks off`). The runner grants `mcp__plugin_claude-mem_mcp-search__*`, `Edit` and `ToolSearch` with `--allow-tools`. A grant applies to every case, so the question cases can see Edit too, and with it Write and NotebookEdit, which Claude Code grants along with Edit. They are not asked to edit.

Before any model is called, the pre-flight checks four things. The first is D9's precondition as the built hook evaluates it. The tree-sitter CLI that `plugin/scripts/worker-service.cjs` resolves must exist, answer `--version`, and be the plugin's provisioned copy. A `tree-sitter` that this machine happens to have on PATH doesn't count; `npm run` puts the repo's `node_modules/.bin` there. A dormant gate then reports "tree-sitter CLI not provisioned" instead of a missing deny. The other three pipe PreToolUse Read payloads into `node plugin/scripts/bun-runner.js plugin/scripts/worker-service.cjs hook claude-code file-context` against each worker:

- Gate ON, whole file: the hook denies with the `Full-file Read blocked by claude-mem` marker and names the seeded observations.
- Gate ON, `offset: 40, limit: 20`: no decision, and the timeline arrives as context.
- Gate OFF, whole file: no decision, and the timeline arrives as context.

It records each hook call's wall time. A failed check stops the run before any model is called.

Both workers are always stopped, including on Ctrl-C. The sandboxes `--keep-temp` keeps are removed once their traces are copied into the report.

## The tree-sitter CLI (D9)

The gate only denies where `smart_outline` can parse. That takes the `tree-sitter` executable, which tree-sitter-cli's `install.js` downloads (decision D9 in `plans/2026-10-05-file-read-gate-restore.md`). `npm run build` installs the plugin's dependencies with lifecycle scripts off, so `plugin/node_modules/tree-sitter-cli` has no executable after a build. Both the built hook and the built MCP server resolve that copy first, so the gate would stay dormant and `smart_outline` could not parse.

Before it starts any worker, the runner provisions that copy the way a real install does. It calls `ensureTreeSitterCliBinary(plugin/)` from `src/services/smart-file-read/tree-sitter-cli-provision.ts`, the function the installer and the worker use, which runs the package's `install.js` (a download from the tree-sitter releases, so it needs network) unless the executable already answers `--version`, and installs the download only if its SHA-256 matches the digest pinned in `tree-sitter-cli-checksums.ts`. The runner stops with the reason if that fails, and records the version in `summary.json` and the summary header.

## Cost

Every grader is `regex` or `tool_used`, so no judge model is called. The spend is the agent runs: 15 by default, 5 cases x 3 runs on `claude-sonnet-5-5`. `--max-cost-usd` caps it, and the summary reports what the eval actually cost.

## Reading `reports/read-gate/<timestamp>/summary.md`

- **Verdicts**: these decide the exit status. Gate ON, large file (`gate-on-large-file` and `gate-on-edits-file`): Claude tried a whole-file Read and got the deny in at least 2/3 of runs (without this, runs that never try one would pass the other gate-ON verdicts vacuously, and so would a dormant gate); no run read the whole file; every run that tried a whole-file Read got the deny; the edit leaves `24.75` and no `22.40` in at least 2/3 of runs. Gate ON, small file: no deny marker and a successful Read in every run; the answer graders pass in at least 2/3 of runs. Gate OFF (both files): no deny marker in any run; at least one successful Read of the file per run; the small file's answer graders pass in at least 2/3 of runs. Large file: the answer graders pass in at least 2/3 of runs in each arm; gate OFF read the whole file in at least 2/3 of runs, without which the comparison measures nothing; and gate ON costs less per run than gate OFF (means; not run when `--case` leaves out an arm). Each run's Reads are counted against its own case's file. The runner also exits non-zero when `claude plugin eval` exits non-zero or stops early, or when a requested case (every case, or the ones `--case` selects) has fewer runs in the results than `--runs` asked for, or a run that ended with an error or that a mock aborted. **Problems** names each such case and why.
- **Runs**: one row per run. Whole-file Reads are shown as tried / denied / returned the file. Targeted Reads are shown as succeeded / denied; a denied targeted Read would block Edit. The row also gives calls to `smart_outline`, `smart_unfold` and `get_observations`, whether the deny marker appears, failed graders, turns, tokens (cache writes / cache reads / output, from the run's `result` event) and cost.
- **Same question, gate ON vs OFF**: for each fixture, mean turns, tokens and cost of its gate-ON and gate-OFF question cases, with gate ON's cost change against gate OFF. Informational, except that the large file's comparison is also a verdict.
- **Pre-flight and hook latency**: the D9 tree-sitter check, then the wall time of each pre-flight hook call, process start included. Gate ON: a whole-file Read of the large file is denied, a targeted Read of it gets context, and a whole-file Read of the small file gets context. Gate OFF: a whole-file Read of the large file gets context. Informational; every check had to pass for the eval to run. The header line names the tree-sitter version the plugin used.

Beside it: `summary.json` (the same data, every run included), `preflight.json`, `traces/` (each run's trace, plus the edit case's edited file), and `eval/` (`claude plugin eval`'s `aggregate-result.json` and `report.html`).

## Last run

2026-10-06, Claude Code 2.1.291, tree-sitter 0.26.9, with the 32 KB deny size. Every verdict passed on both models. Reports: `reports/read-gate/2026-10-06T09-54-38-735Z` (Sonnet) and `reports/read-gate/2026-10-06T09-56-10-038Z` (Opus).

**`claude-sonnet-5-5`, 3 runs per case, eval cost $1.20**

| Case | Runs | Whole-file Reads tried / denied / returned the file | Targeted Reads | `smart_outline` / `smart_unfold` / `get_observations` | Graders passed | Mean turns | Mean cache write / read | Mean cost |
| --- | ---: | --- | ---: | --- | --- | ---: | --- | ---: |
| `gate-on-large-file` | 3 | 3 / 3 / 0 | 2 | 3 / 8 / 0 | `answer-rate` 3/3, `answer-minimum` 3/3, `read-blocked` 3/3 | 7.3 | 14,074 / 68,025 | $0.077 |
| `gate-off-large-file` | 3 | 3 / 0 / 3 | 3 | 0 / 0 / 0 | `answer-rate` 3/3, `answer-minimum` 3/3, `not-blocked` 3/3, `read-used` 3/3 | 3.0 | 35,231 / 58,591 | $0.124 |
| `gate-on-edits-file` | 3 | 3 / 3 / 0 | 3 | 0 / 0 / 0 | `edited` 3/3, `old-value-gone` 3/3, `read-blocked` 3/3 | 5.0 | 8,868 / 59,767 | $0.052 |
| `gate-on-small-file` | 3 | 3 / 0 / 3 | 0 | 0 / 0 / 0 | `answer-rate` 3/3, `answer-minimum` 3/3, `not-blocked` 3/3, `read-used` 3/3 | 2.0 | 17,682 / 20,389 | $0.073 |
| `gate-off-small-file` | 3 | 3 / 0 / 3 | 0 | 0 / 0 / 0 | `answer-rate` 3/3, `answer-minimum` 3/3, `not-blocked` 3/3, `read-used` 3/3 | 2.7 | 17,691 / 25,242 | $0.074 |

**`claude-opus-5-5`, 2 runs per case, eval cost $1.59**

| Case | Runs | Whole-file Reads tried / denied / returned the file | Targeted Reads | `smart_outline` / `smart_unfold` / `get_observations` | Graders passed | Mean turns | Mean cache write / read | Mean cost |
| --- | ---: | --- | ---: | --- | --- | ---: | --- | ---: |
| `gate-on-large-file` | 2 | 2 / 2 / 0 | 6 | 2 / 0 / 0 | `answer-rate` 2/2, `answer-minimum` 2/2, `read-blocked` 2/2 | 7.0 | 19,212 / 67,927 | $0.171 |
| `gate-off-large-file` | 2 | 2 / 0 / 2 | 2 | 0 / 0 / 0 | `answer-rate` 2/2, `answer-minimum` 2/2, `not-blocked` 2/2, `read-used` 2/2 | 3.0 | 35,162 / 58,572 | $0.243 |
| `gate-on-edits-file` | 2 | 2 / 2 / 0 | 2 | 0 / 0 / 0 | `edited` 2/2, `old-value-gone` 2/2, `read-blocked` 2/2 | 5.0 | 8,814 / 64,618 | $0.095 |
| `gate-on-small-file` | 2 | 2 / 0 / 2 | 0 | 0 / 0 / 0 | `answer-rate` 2/2, `answer-minimum` 2/2, `not-blocked` 2/2, `read-used` 2/2 | 2.0 | 17,536 / 20,561 | $0.142 |
| `gate-off-small-file` | 2 | 2 / 0 / 2 | 0 | 0 / 0 / 0 | `answer-rate` 2/2, `answer-minimum` 2/2, `not-blocked` 2/2, `read-used` 2/2 | 2.0 | 17,549 / 20,562 | $0.142 |

**Same question, gate ON against gate OFF (mean cost per run):**

| File | `claude-sonnet-5-5` | `claude-opus-5-5` |
| --- | --- | --- |
| `carrier-tariffs.ts`, 941 lines, 49 KB | $0.077 vs $0.124 (-38%) | $0.171 vs $0.243 (-30%) |
| `rate-calculator.ts`, 513 lines, 19 KB (under the deny size) | $0.073 vs $0.074 (-1%) | $0.142 vs $0.142 (0%) |

On the large file the gate keeps about 20,000 tokens of cache writes out of the run and pays for four extra turns, each re-reading the whole context. It comes out about a third cheaper on both models. Sonnet answered from `smart_outline` and `smart_unfold`. Opus ran `smart_outline` and then read the sections it named through targeted Reads, and still saved. Under the deny size the gate stays out of the way, and the small file costs the same with it on or off. Before the deny size existed, the same small-file question cost Opus 20% more with the gate on (`reports/read-gate/2026-10-06T09-37-47-324Z`).

After the deny, every edit run on both models found the line with Grep, read the 15 lines around it, and changed line 526 only.
