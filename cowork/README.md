# CMEM Pro for the Claude app

Claude-Mem memory for the **Claude app** (mobile, web, desktop cloud sessions),
powered by CMEM Pro on cmem.ai. Install it with
`/plugin install cmem-pro@thedotmack`. It was called `claude-mem-cowork`;
existing installs move to `cmem-pro` automatically on Claude Code 2.1.193+.

Claude app sessions run in ephemeral cloud containers, so the local claude-mem
worker/SQLite model can't persist there. This plugin replaces the worker with
thin HTTPS shims: hooks capture tool use and stream raw fragments to cmem.ai,
where **Pro runs the worker and observer server-side**; compiled observations
are injected back into every new session and every spawned agent.

## What it does

| Hook | Event sent / behavior |
|---|---|
| `SessionStart` | Registers the session, pulls a compiled context block from cmem.ai and injects it — skipped on a machine with a local claude-mem install (an enabled plugin registered in `installed_plugins.json` with its hook and worker files), whose hook injects from the local db that cloud sync keeps current. A disabled plugin or an orphaned cache copy doesn't count as an install |
| `UserPromptSubmit` | `session-init` — registers the turn + prompt with the observer pipeline |
| `PostToolUse` (all tools) | `observation` — streams the raw tool-use fragment (truncated) for server-side synthesis |
| `PreToolUse` on `Task`/`Agent` | Fetches observations relevant to the agent's prompt and prepends them to it (skipped when claude-mem is installed locally, as for `SessionStart`) |
| `SubagentStop` | Marks the agent's work complete |
| `Stop` | `summarize` signal (turn boundary for the observer) |
| `SessionEnd` | Closes the session |

Plus a **mem-search** skill: progressive Index → Timeline search against
`/api/mcp memory_search`, available in any session.

## Memory tools (cmem.ai connector)

`.mcp.json` points at the cmem.ai memory server, `https://cmem.ai/api/mcp`. In
the Claude app it appears on the plugin's **Connectors** tab: connect it and
sign in with the cmem.ai account that holds your memory. Claude Code connects
to it directly. Its tools (`memory_search`, `timeline`, `get_observations`,
`get_summaries`, `list_projects`) only read; nothing is stored in this file.

## Fail-soft guarantees

- No API key configured → every hook is a silent no-op. Sessions never break.
- cmem.ai unreachable → capture events spool to `/tmp/cmem-spool.jsonl` and
  flush on later hook fires (batched to `/api/hooks/ingest`).
- `/api/hooks/*` endpoints not deployed yet → context injection falls back to
  the live `/api/mcp` `memory_search`; ingest 404s are dropped, not spooled.
- Every hook exits `0` unconditionally.

## Setup (per user — nothing is hardcoded)

Say "set up claude-mem" in any Claude app session (the **mem-setup** skill) and
paste your values from cmem.ai → Connect. Credential sources, in order:

1. Env vars: `CMEM_API_KEY`, `CMEM_USER_ID`, `CMEM_SYNC_HUB_URL`, `CMEM_API_BASE`
2. `config.json` in this plugin (`apiKey`, `userId`, `syncHubUrl`) — the
   durable option in the Claude app; repackage after editing so it survives sessions
3. `~/.claude-mem/settings.json` (`CLAUDE_MEM_CLOUD_SYNC_TOKEN` /
   `CLAUDE_MEM_CLOUD_SYNC_USER_ID` / `CLAUDE_MEM_CLOUD_SYNC_HUB_URL`) — compat
   with a local claude-mem install's cloud-sync pairing

Project naming is automatic and deliberately NOT a setting: root Claude app
sessions land on `cmem_work_root`, sessions inside a project folder get
`cmem_work_<folder>`. Optional `inject` toggles
(`sessionStart`, `agents`, `maxChars`). Verify with
`node scripts/cmem-hook.mjs status` (token stays masked).

## Server side

The ingest/context endpoints this plugin calls are specified in
`PRO-ENDPOINT-SPEC.md` (drop-in spec for claude-mem-pro). Until they ship,
retrieval works via the existing `/api/mcp`; capture is inert.

## Privacy notes

- Tool inputs/outputs are truncated to 16 KB per field before sending.
- Calls to memory tools themselves (`mcp__memory__*`, `mcp__cmem*`, and the
  Claude-Mem connector's `mcp__Claude-Mem__*`) are never captured
  (feedback-loop guard). Add more exclusions in `capture.skipTools`.
