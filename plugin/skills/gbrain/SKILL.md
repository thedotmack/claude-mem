---
name: gbrain
description: Connect claude-mem to gbrain so observations are stored in a gbrain brain. Use when the user says "connect gbrain", "store memories in gbrain", "gbrain sync", "set up gbrain", "gbrain connector", or wants their claude-mem observations captured into gbrain.
allowed-tools:
  - Bash
  - Read
  - AskUserQuestion
---

# gbrain Connector

The installed worker can mirror every stored observation into
[gbrain](https://github.com/garrytan/gbrain) (markdown brain repo + hybrid
search + MCP). This skill checks the gbrain CLI, writes the connector settings,
restarts the worker, and verifies an observation lands in the brain. There are
two lanes — a live trickle (`gbrain capture` per observation) and a
watermark-driven backfill (`gbrain import` + `gbrain embed --stale`) — both
handled by the worker; this skill only configures them.

**Security rule:** never print secrets or tokens from
`~/.claude-mem/settings.json`, and never log unrelated settings. Preserve every
unrelated setting and keep `~/.claude-mem/settings.json` mode `0600` (the
helper script below does both).

## 1. Check the gbrain CLI

```bash
gbrain --version
gbrain doctor
```

- Both succeed → note the version and continue.
- `gbrain` not found → offer to install it with the one-liner below, then
  re-run the checks. **The CLI is installed from GitHub via Bun. NEVER run
  `npm install gbrain` or `npm install -g gbrain` — the npm package name
  `gbrain` is held by a squatter and is not this project.**

```bash
bun install -g github:garrytan/gbrain
```

- `gbrain doctor` reports problems → show them to the user and fix the brain
  first (gbrain works keyless with its PGLite default; no Postgres or API keys
  are required). Do not enable the connector against a broken install.

If the CLI lives outside `PATH`, capture its absolute path for the
`--cli-path` flag in step 3.

## 2. Ask for optional configuration

Use AskUserQuestion for the three optional values (defaults are fine for most
users):

1. **gbrain source id** — stamped on captured pages via `--source`. Default:
   none.
2. **Slug prefix** — pages are written as `<prefix>/<project>/obs-<id>`.
   Default: `claude-mem`.
3. **Project allowlist** — comma-separated claude-mem project names to sync;
   empty means all projects. Default: all.

## 3. Write settings

Run the helper with only the flags the user provided (it merges — keys for
omitted flags are left untouched, unrelated settings are preserved, and the
file is written atomically with mode `0600`):

```bash
node "$(dirname "$SKILL_PATH")/scripts/configure-gbrain.mjs" \
  --enabled true \
  --slug-prefix claude-mem
  # optional, only when the user provided them:
  #   --cli-path /absolute/path/to/gbrain
  #   --source my-source-id
  #   --projects projA,projB
  #   --backfill true
```

If `$SKILL_PATH` is not set, use the path of this SKILL.md's directory (the
directory containing this file) to locate `scripts/configure-gbrain.mjs`.

### Settings keys reference

| Key | Meaning | Default |
|---|---|---|
| `CLAUDE_MEM_GBRAIN_ENABLED` | Master switch for the connector | `false` |
| `CLAUDE_MEM_GBRAIN_CLI_PATH` | Path to the `gbrain` binary; empty means `gbrain` from `PATH` | `''` |
| `CLAUDE_MEM_GBRAIN_SOURCE` | Optional gbrain `--source` id stamped on captures | `''` |
| `CLAUDE_MEM_GBRAIN_SLUG_PREFIX` | Slug prefix: `<prefix>/<project>/obs-<id>` | `claude-mem` |
| `CLAUDE_MEM_GBRAIN_PROJECTS` | Comma-separated project allowlist; empty means all | `''` |
| `CLAUDE_MEM_GBRAIN_BACKFILL_ENABLED` | Backfill unsynced history at worker boot | `true` |

All values are strings (`'true'`/`'false'` for booleans).

## 4. Restart the worker

Resolve the worker port and restart:

```bash
PORT="${CLAUDE_MEM_WORKER_PORT:-$(node -e "const fs=require('fs'),p=require('path'),os=require('os');const uid=(typeof process.getuid==='function'?process.getuid():77);const fallback=String(37700+(uid%100));try{const s=JSON.parse(fs.readFileSync(p.join(os.homedir(),'.claude-mem','settings.json'),'utf-8'));process.stdout.write(String(s.CLAUDE_MEM_WORKER_PORT||fallback));}catch{process.stdout.write(fallback);}" 2>/dev/null)}"
curl -s -X POST "http://127.0.0.1:${PORT}/api/admin/restart"
```

Connection refused, 404, or 503 immediately after restart → retry every three
seconds for about 30 seconds before diagnosing the worker.

## 5. Verify end-to-end

1. **Worker logs.** Check the worker log in `~/.claude-mem/logs/` for gbrain
   lines. With backfill enabled and prior observations present, the backfill
   lane runs at boot; a warning about a missing/failing `gbrain` CLI means the
   connector disabled itself for the session — fix the CLI and restart again.
2. **Live capture.** The live lane fires when the next observation is stored.
   After the user's next real observation lands (or after backfill completes),
   query the brain for it:

```bash
gbrain query "claude-mem"
```

   A synced page has a slug like `claude-mem/<project>/obs-<id>`. Both lanes
   are idempotent (deterministic slugs + gbrain content-hash dedupe), so
   re-running backfill never duplicates pages.

3. If nothing shows up, confirm `CLAUDE_MEM_GBRAIN_ENABLED` is `'true'` in
   `~/.claude-mem/settings.json` (read only that key; do not print the whole
   file), that the project is not excluded by `CLAUDE_MEM_GBRAIN_PROJECTS`,
   and that `gbrain doctor` still passes.

## 6. Report

Report the gbrain CLI version, the settings keys that were written (names
only, never dump the settings file), whether the worker restarted cleanly, and
the result of the verification query. End with this note:

> The gbrain connector writes your observation titles and narratives as
> markdown pages into your local gbrain brain repo.
