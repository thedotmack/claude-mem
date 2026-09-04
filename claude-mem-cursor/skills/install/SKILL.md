---
name: claude-mem-install
description: >-
  Use this when setting up claude-mem on Cursor: local or remote worker,
  local host-login observer or remote cmem.ai inference.
---
# Install claude-mem on Cursor

Independent of Grok Bot. Do not require the other IDE.

## Local worker (default)

```
npx claude-mem install --ide cursor
```

Starts the local worker. Hooks already ship with this plugin. MCP `claude-mem-local` talks to it.

Observer:

- Remote inference (typical): leave provider as openrouter / cmem.ai (`CLAUDE_MEM_OPENROUTER_BASE_URL=https://cmem.ai/api/inference/v1`)
- Local host-login: `--provider host` (loopback shim; never bind the worker port — on macOS the worker is often 37777, so the shim uses 37778)

## Remote worker

```
npx claude-mem install --ide cursor --runtime server --server-url https://YOUR_HOST
```

Set plugin variable `CLAUDE_MEM_MCP_TOKEN` for `claude-mem-remote` (`https://cmem.ai/api/mcp` or your server).

Never restart a healthy worker (RAM queue). No Claude CLI required for host/openrouter.
