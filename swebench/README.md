# cmem-swebench — SWE-bench harness for claude-mem

An evaluation harness that runs [SWE-bench](https://www.swebench.com/) with an
**OpenRouter**-driven agent that is primed with **`/learn-codebase`** and recalls
prior work through claude-mem's **mem-search**. Grading uses the **official
SWE-bench harness** so scores are comparable to the leaderboard.

The requested workflow, wired end to end:

1. **Prime** the target repository with `/learn-codebase` (front-load the code).
2. **Recall** with mem-search — the agent is instructed to call
   `mem_search → mem_timeline → mem_get_observations` before writing a patch, so
   it reuses how similar issues were solved in earlier sessions.
3. **Solve** via an OpenRouter model in a bash tool loop, producing a diff.
4. **Grade** each diff with the official containerized SWE-bench harness.

This package is self-contained (Bun + TypeScript, no runtime npm deps) and lives
alongside the plugin so it reads the same `~/.claude-mem/settings.json` and talks
to the same local worker the plugin writes memory into.

## Methodology

- **Dataset:** SWE-bench **Verified** by default (the 500 human-validated
  instances leaderboard submissions report against). `lite` and `full` are also
  selectable, as is any raw Hugging Face dataset id.
- **Agent scaffold:** a minimal bash-only loop in the spirit of
  `mini-swe-agent` — the model gets a `bash` tool, a `submit` tool, and the
  three `mem_*` recall tools. No hand-tuned per-repo logic.
- **Priming:** `/learn-codebase` is reproduced as a deterministic pass that
  reads repo source files in full (paging large files, exactly as the skill
  says) into a bounded codebase map injected into the system prompt. Coverage
  that a byte/file budget drops is reported, never silently truncated.
- **Grading:** `swebench.harness.run_evaluation` applies each `model_patch`
  plus the gold test patch inside the instance's Docker image and runs
  `FAIL_TO_PASS` / `PASS_TO_PASS`. We do not reimplement grading.
- **Output:** `predictions.jsonl` in the exact
  `{instance_id, model_name_or_path, model_patch}` schema the grader expects.

## Prerequisites

- **Bun** ≥ 1.1 (the repo already requires it).
- **git** (clone/checkout each instance repo).
- **OpenRouter API key** for `run` — `CLAUDE_MEM_OPENROUTER_API_KEY` or
  `OPENROUTER_API_KEY`.
- A running **claude-mem worker** for mem-search to return hits (the plugin
  starts it; the harness auto-discovers its port).
- **Docker** + **Python** + the `swebench` pip package for `grade`.

```bash
cd swebench
bun install          # dev deps only (types + tsc); the harness has no runtime deps
```

## Workflow

### 0. Prime memory (so mem-search has something to recall)

mem-search reads claude-mem's cross-session memory. For the agent to get real
hits, populate memory for the target repos first — either by having worked in
them before, or by running the real skill in a Claude Code session in each repo:

```
/learn-codebase   # (optionally: "…and store what you learn so mem-search can recall it")
```

The harness *also* injects a fresh `/learn-codebase` codebase map into every
solve (step 2 below); that priming needs no worker. The worker-backed memory is
what makes `mem_search` return prior fixes across runs.

### 1. Check the environment

```bash
bun run src/cli.ts preflight
```

Reports the resolved OpenRouter model/key, the worker URL and whether it's
reachable, and Docker/Python/swebench availability.

### 2. Get the dataset

```bash
bun run src/cli.ts fetch --dataset verified          # → data/verified.jsonl
# …or bring your own JSONL and pass it with --data below.
```

### 3. Run the agent (primes + mem-search → predictions)

```bash
bun run src/cli.ts run \
  --dataset verified \
  --count 20 \
  --model anthropic/claude-sonnet-4.5 \
  --run-id cmem-sonnet45-verified
# artifacts land in runs/<run-id>/: predictions.jsonl, results.jsonl, summary.json
```

Useful flags: `--data <file.jsonl>` (skip download), `--ids a,b,c`,
`--offset N`, `--no-mem` (ablate mem-search), `--no-prime` (ablate
`/learn-codebase`), `--max-turns 40`, `--local-repo <dir>` (reuse a checkout
offline).

`results.jsonl` records per-instance `memSearchCalls`, tool counts, turns, and
token/cost — so you can compare `run` vs `run --no-mem` to measure what
mem-search recall actually buys.

### 4. Grade with the official harness

```bash
bun run src/cli.ts grade \
  --predictions runs/cmem-sonnet45-verified/predictions.jsonl \
  --dataset verified \
  --run-id cmem-sonnet45-verified \
  --install            # provisions the swebench pip package if missing
```

Prints `resolved / total` and the path to the official report JSON.

## Configuration

Resolved with the same precedence claude-mem uses (env var → `~/.claude-mem/settings.json` → default):

| Setting | Purpose | Default |
|---|---|---|
| `CLAUDE_MEM_OPENROUTER_API_KEY` / `OPENROUTER_API_KEY` | OpenRouter auth | — (required for `run`) |
| `SWEBENCH_MODEL` / `CLAUDE_MEM_OPENROUTER_MODEL` | Solver model id | `anthropic/claude-sonnet-4.5` |
| `CLAUDE_MEM_OPENROUTER_BASE_URL` / `OPENROUTER_BASE_URL` | Custom OpenAI-compatible gateway | OpenRouter |
| `SWEBENCH_TEMPERATURE`, `SWEBENCH_MAX_TOKENS` | Sampling | `0.0`, `8192` |
| `CLAUDE_MEM_WORKER_HOST` / `CLAUDE_MEM_WORKER_PORT` | mem-search target | `127.0.0.1` : `37700 + (uid % 100)` |
| `SWEBENCH_MEM_PROJECT` | Scope mem-search to a project | unset (all projects) |

## Layout

```
src/
  config.ts       Env/settings resolution (OpenRouter + worker), shared with the plugin's conventions
  dataset.ts      Load local JSONL / download via HF datasets-server; select & slice
  openrouter.ts   OpenAI-compatible chat client with tool-calling, retry, usage/cost
  mem-tools.ts    mem_search / mem_timeline / mem_get_observations → claude-mem worker HTTP
  learn.ts        /learn-codebase priming (read source files → codebase map)
  prompt.ts       System/user prompt: workflow + priming + mem-search instructions
  agent-tools.ts  bash + submit tools
  solver.ts       The agentic loop: prime → recall → fix → submit → extract patch
  repo.ts         Clone/checkout at base_commit; extract git diff as model_patch
  runner.ts       Orchestrate instances → predictions.jsonl / results.jsonl / summary.json
  grade.ts        Official swebench harness (Docker) + report parsing
  cli.ts          preflight | fetch | learn | run | grade
test/             Unit tests + an offline end-to-end solver test (mock provider, real git repo)
```

## Testing

```bash
bun test          # 49 tests: dataset, provider, mem-tools, learn, config, and a full offline solve
bun run typecheck # tsc --noEmit
```

The solver test scripts a mock model through `mem_search → bash-fix → submit`
against a real temporary git repo and asserts the extracted patch — so the whole
pipeline is verified without any network or API key.

## Note on restricted networks

Some execution environments block `openrouter.ai` and `huggingface.co`. There,
`learn`, `preflight`, `typecheck`, and `bun test` all run, but `fetch`, `run`
(model calls), and `grade` (Docker image pulls) need outbound access to those
hosts and to a running claude-mem worker. Run those steps where the network
policy allows them.
