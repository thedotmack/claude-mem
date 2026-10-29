# claude-mem-cowork

Claude-Mem for **Cowork** (native Claude app — mobile, web, desktop cloud sessions).

Cowork sessions run in ephemeral cloud containers, so the local claude-mem
worker/SQLite model can't persist there. This plugin replaces the worker with
thin HTTPS shims: hooks capture tool use and stream raw fragments to cmem.ai,
where **Pro runs the worker and observer server-side**; compiled observations
are injected back into every new session and every spawned agent.

## What it does

| Hook | Event sent / behavior |
|---|---|
| `SessionStart` | Registers the session, pulls a compiled context block from cmem.ai and injects it |
| `UserPromptSubmit` | `session-init` — registers the turn + prompt with the observer pipeline. Runs in the background, so a slow cmem.ai never holds up the prompt. `prompt-context` — once per session, injects memory picked with the first prompt as the query (Claude Duet, below) |
| `PostToolUse` (all tools) | `observation` — streams the raw tool-use fragment (truncated) for server-side synthesis |
| `PreToolUse` on `Task`/`Agent` | Fetches observations relevant to the agent's prompt and prepends them to it |
| `SubagentStop` | Marks the agent's work complete |
| `Stop` | `summarize` signal (turn boundary for the observer) |
| `SessionEnd` | Closes the session |

On a machine with a local claude-mem install (an enabled plugin registered in
`installed_plugins.json` with its hook and worker files) every hook above is a
no-op. The local plugin captures and injects there, and its cloud sync carries
that work to cmem.ai, so capturing here too would record every session twice.
A disabled plugin or an orphaned cache copy doesn't count as an install.

Plus a **mem-search** skill: progressive Index → Timeline search against
`/api/mcp memory_search`, available in any session.

## Fail-soft guarantees

- No API key configured → every hook is a silent no-op. Sessions never break.
- cmem.ai unreachable → capture events spool to `~/.claude-mem/cowork-spool.jsonl`
  (0600) and flush on later hook fires (batched to `/api/hooks/ingest`).
- `/api/hooks/*` endpoints not deployed yet → context injection falls back to
  the live `/api/mcp` `memory_search`; ingest 404s are dropped, not spooled.
- Every hook exits `0` unconditionally.

## Setup (per user — nothing is hardcoded)

Say "set up claude-mem" in any Cowork session (the **mem-setup** skill) and
paste your values from cmem.ai → Connect. Credential sources, in order:

1. Env vars: `CMEM_API_KEY`, `CMEM_USER_ID`, `CMEM_SYNC_HUB_URL`, `CMEM_API_BASE`
2. `config.json` in this plugin (`apiKey`, `userId`, `syncHubUrl`) — the
   durable option in Cowork; repackage after editing so it survives sessions
3. `~/.claude-mem/settings.json` (`CLAUDE_MEM_CLOUD_SYNC_TOKEN` /
   `CLAUDE_MEM_CLOUD_SYNC_USER_ID` / `CLAUDE_MEM_CLOUD_SYNC_HUB_URL`) — compat
   with a local claude-mem install's cloud-sync pairing

Project naming is automatic and deliberately NOT a setting: root Cowork
sessions land on `cmem_work_root`, sessions inside a project folder get
`cmem_work_<folder>`. Optional `inject` toggles
(`sessionStart`, `agents`, `maxChars`). Verify with
`node scripts/cmem-hook.mjs status` (token stays masked).

## Claude Duet

Duet (the Claude app's main chat, task threads, channels and routines) runs
every session in the same cloud folder, so folder naming would file them all
under `cmem_work_root`. Each Duet prompt names its channel, so a Duet session
files under `cmem_duet_<channel name>_<channel id>` instead (the id keeps
channels whose names look alike apart), and every task thread in that
channel shares it. Envelopes carry `payload.duet` (`channel_id`,
`channel_name`, `thread_id`). A session is pinned to the first channel it sees.
The channel is read only from what the host sends: the unescaped `<project>`
tag of a wake envelope, or the `Project:` line inside a real
`<session-context>` block. Text people type, tool output, assistant turns and
compaction summaries never name a channel.

- Fresh session: SessionStart can't know the channel yet, so registration and
  injection wait for the first prompt that names it, which also serves as the
  relevance query. Until then nothing is injected: the folder project is shared
  by every channel.
- Compact and resume: the channel is read from the restored transcript and
  SessionStart re-injects immediately.
- When cmem.ai can't be reached, the injected notice says so plainly instead of
  claiming notes are being saved.

Proxied containers: Node's built-in fetch ignores `HTTPS_PROXY`, so on Node
≥ 22.21 / 24.5 the hook re-runs itself once with `NODE_USE_ENV_PROXY=1`
(which honors `NO_PROXY`). The container's egress policy still has to allow
`cmem.ai`.

## Server side

The ingest/context endpoints this plugin calls are specified in
`PRO-ENDPOINT-SPEC.md` (drop-in spec for claude-mem-pro). Until they ship,
retrieval works via the existing `/api/mcp`; capture is inert.

## Privacy notes

- Tool inputs/outputs are truncated to 16 KB per field before sending.
- Calls to memory tools themselves (`mcp__memory__*`, `mcp__cmem*`) are never
  captured (feedback-loop guard). Add more exclusions in `capture.skipTools`.
