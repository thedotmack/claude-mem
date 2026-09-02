---
name: claude-mem-install
description: >-
  Use this when setting up claude-mem on Grok Bot: local worker plus CMEM Pro
  observer (default), optional host-login observer, or remote cmem.ai. No Cursor
  required.
---
# Install claude-mem on Grok Bot

Independent of Cursor. Grok Bot has no session-start / file-read / tool-use hooks.

## Local worker + CMEM Pro observer (default)

```
npx claude-mem install --ide grok-bot
```

Do **not** pass `--provider host` unless you want the loopback shim. With no `--provider`, this is the CMEM Pro path:

- Worker on `127.0.0.1:<port>` (default `37700 + uid%100`). Do not restart if healthy.
- Transcript watcher per Grok Bot agent (`platformSource=grok-bot`)
- Observer via CMEM Pro: `CLAUDE_MEM_PROVIDER=openrouter`, `CLAUDE_MEM_OPENROUTER_BASE_URL=https://cmem.ai/api/inference/v1`, `CLAUDE_MEM_OPENROUTER_MODEL=cmem-observer`, API key from installer OAuth (`cm_pro` memory key)
- Interactive installer pre-selects CMEM Pro
- MCP `session_start_context` at the start of a real task

No xAI key. No Claude CLI.

## Optional: local host-login observer

Explicit opt-in only. Not the user default.

```
npx claude-mem install --ide grok-bot --provider host
```

Loopback OpenAI-compatible shim on a **free** loopback port (not the worker port). Idle replies are `<skip_summary />`; finished units are one `<observation>`. This Grok login fulfills inbox jobs (skill host-observer).

## Remote worker / remote observer

Set plugin variable `CLAUDE_MEM_MCP_TOKEN` and use MCP `claude-mem-remote`.

```
npx claude-mem install --ide grok-bot --runtime server --server-url https://cmem.ai
```
