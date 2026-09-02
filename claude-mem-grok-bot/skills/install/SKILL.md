---
name: claude-mem-install
description: >-
  Use this when setting up claude-mem on Grok Bot: local worker plus host-login
  observer, or remote cmem.ai. No Cursor required.
---
# Install claude-mem on Grok Bot

Independent of Cursor. Grok Bot has no session-start / file-read / tool-use hooks.

## Local worker + host-login observer (default)

```
npx claude-mem install --ide grok-bot --provider host
```

- Worker on `127.0.0.1:<port>` (default `37700 + uid%100`). Do not restart if healthy.
- Transcript watcher on `agent-transcripts/*/*.jsonl`, `platformSource=grok-bot`
- Observer shim on a **free** loopback port (not the worker port). Idle replies are `<skip_summary />`; finished units are one `<observation>`.
- MCP `session_start_context` at the start of a real task
- This Grok login fulfills inbox jobs (skill host-observer)

## Remote worker / remote observer

Set plugin variable `CLAUDE_MEM_MCP_TOKEN` and use MCP `claude-mem-remote`.

```
npx claude-mem install --ide grok-bot --runtime server --server-url https://cmem.ai
```

No xAI key. No Claude CLI.
