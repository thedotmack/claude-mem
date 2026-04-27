---
name: learn-codebase
description: Two-phase priming for new claude-mem projects. Phase 1 runs a free structural pass via smart_outline / smart_search. Phase 2 estimates cost and primes targeted observations via the worker. Use when a user just installed claude-mem, when /mem-search returns nothing in a fresh project, or when the user explicitly asks to "teach claude-mem this repo".
---

# Learn Codebase

Two-phase priming. Phase 1 is free (structural pass). Phase 2 is cost-bounded targeted compression via the worker HTTP API.

## Constants

**Code extension allowlist** (mirrors `src/services/smart-file-read/search.ts`):

```text
.js .jsx .ts .tsx .mjs .cjs
.py .pyw
.go
.rs
.rb
.java
.cs
.cpp .cc .cxx .c .h .hpp .hh
.swift
.kt .kts
.php
.vue .svelte
.ex .exs
.lua
.scala .sc
.sh .bash .zsh
.hs
.zig
.css .scss
.toml
.yml .yaml
.sql
.md .mdx
```

Skip directories: `node_modules`, `.git`, `dist`, `build`, `.next`, `__pycache__`, `.venv`, `venv`, `env`, `.env`, `target`, `vendor`, `.cache`, `.turbo`, `coverage`, `.nyc_output`, `.claude`, `.smart-file-read`. Skip files larger than 512KB.

**Model price table** (USD per 1M tokens — update when pricing changes):

| Model id | Input $/M | Output $/M |
|---|---|---|
| `claude-haiku-4-5-20251001` | 0.80 | 4.00 |
| `claude-sonnet-4-6` | 3.00 | 15.00 |
| `claude-opus-4-7` | 15.00 | 75.00 |

**Token estimate heuristic:** `tokens ≈ file_size_bytes / 3.5 + 600` (the `+600` is the per-observation output overhead).

**Throughput assumption:** ~6 files/second compression for wall-time estimates.

## Worker port and settings path

claude-mem honors env-first priority: `CLAUDE_MEM_DATA_DIR` overrides the default
data dir, and `CLAUDE_MEM_WORKER_PORT` overrides the dynamic port (`37700 + uid%100`).
Resolve once before any `curl` call and reuse:

```bash
SETTINGS_PATH="${CLAUDE_MEM_DATA_DIR:-$HOME/.claude-mem}/settings.json"
CLAUDE_MEM_PORT="${CLAUDE_MEM_WORKER_PORT:-$(jq -r '.CLAUDE_MEM_WORKER_PORT // empty' "$SETTINGS_PATH" 2>/dev/null)}"
[ -z "$CLAUDE_MEM_PORT" ] && CLAUDE_MEM_PORT=$((37700 + $(id -u) % 100))
```

Substitute `$CLAUDE_MEM_PORT` for every port reference below and `$SETTINGS_PATH`
for every settings-file reference.

## Step 1 — Discover the structure (free)

1. Enumerate every file under cwd matching the extension allowlist above. Filter out skip-dirs and oversized files. Sort by mtime descending. This is the **full candidate list** — keep it; Step 2 reuses it for tier estimates.
2. Derive a **structural sample** from the full candidate list: the first 50 files by default (user may override via `--max-files`).
3. For each file in the structural sample: call `smart_outline file_path="..."`.
4. For each top-level directory: call `smart_search query="core APIs in <dir>"` to find entrypoints.
5. Aggregate findings into a structural map. Format:

```text
# Codebase Structural Map — <project>

## <system / top-level dir>
- <file>: <one-line summary from outline>
- ...
```

6. Derive `<project>` name from `basename(cwd)`. Save the map via:

```bash
curl -s -X POST "http://localhost:$CLAUDE_MEM_PORT/api/memory/save" \
  -H 'Content-Type: application/json' \
  -d '{"title":"Codebase structural map","text":"<map>","project":"<project>"}'
```

Step 1 ends here. Even users who skip Step 2+ retain value from this map.

## Step 2 — Estimate cost

1. Read the active compression model — env first, settings file second:

```bash
printf '%s\n' "${CLAUDE_MEM_MODEL:-$(jq -r '.CLAUDE_MEM_MODEL // empty' "$SETTINGS_PATH" 2>/dev/null)}"
```

   Match the resulting id against the price table. Fall back to Haiku 4.5 pricing if the value is empty / unrecognized (warn the user).

2. For each file `f` in the **full candidate list** built in Step 1 (not the 50-file structural sample): compute
   - `tokens_in[f] = stat(f).size / 3.5`
   - `tokens_out[f] = 600`
   - `cost[f] = (tokens_in[f] * input_price + tokens_out[f] * output_price) / 1_000_000`

3. Compute three tier estimates from the full candidate list:
   - **Standard** — top 50 files (highest signal: most-recently-modified + entrypoints from `smart_search`)
   - **Deep** — top 200 files
   - **Full** — every file in the full candidate list

4. Output a table:

```text
Tier      Files   Est. cost   Est. wall-time
Standard  50      $X.XX       ~Ns
Deep      200     $Y.YY       ~Ns
Full      M       $Z.ZZ       ~Ns
```

## Step 3 — Confirm + prime

1. Ask the user to pick a tier (Standard / Deep / Full / cancel). **Do not proceed without explicit confirmation**, even on small repos.
2. For each file in the selected tier:
   - Read or `smart_outline` the file.
   - Build a synthetic tool-use payload and POST to the worker:

```bash
curl -s -X POST "http://localhost:$CLAUDE_MEM_PORT/api/sessions/observations" \
  -H 'Content-Type: application/json' \
  -d '{
    "contentSessionId":"<current session id>",
    "platformSource":"claude-code",
    "tool_name":"Read",
    "tool_input":{"file_path":"<absolute path>"},
    "tool_response":"<file contents or outline>",
    "cwd":"<project cwd>",
    "agentId":null,
    "agentType":null
  }'
```

3. Stream progress on every file: `N/M files, $X.YY spent so far`.
4. **Collect failures, do not crash mid-prime.** If a single file fails (network, parse, oversized), record it and continue. At the end, print a summary: `K succeeded, F failed`. List failed paths so the user can re-run.

## Step 4 — Resume / re-run

1. On invocation, query existing observations for the project to bucket files into "already known" vs "new":

```bash
curl -s "http://localhost:$CLAUDE_MEM_PORT/api/context/inject?projects=<project>"
```

   (Or use the `/mem-search` skill semantics.) Compare the file paths referenced in returned observations against the candidate list.

2. Show the diff in the cost estimate:

```text
Standard  50 files (37 already known, 13 new)  $X.XX
```

3. Default the tier scope to "new files only" when the project is partially primed. User may override to re-prime everything.

## Tips

- `--max-files <N>` — cap the candidate list before tier estimation (useful in monorepos).
- `--exclude-ext .md,.yaml` — drop noisy extensions for this run.
- Override the compression model just for the prime: set `CLAUDE_MEM_MODEL=claude-haiku-4-5-20251001` in the env before invoking. Settings file is unchanged; the worker reads env first.
- If the worker is down: `npx claude-mem start`, then re-run.
- If pricing is wrong: edit the price table at the top of this skill; update the comment with the date.
