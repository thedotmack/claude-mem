# claude-mem memory for Hermes Agent

A Hermes memory provider. Hermes and your other coding agents share one claude-mem
memory per project.

## What it does

| Hermes event | claude-mem call | Why |
|---|---|---|
| `on_turn_start` | `POST /api/sessions/init` | Records each user prompt, in order |
| `post_tool_call` hook | `POST /api/sessions/observations` | Records each tool call after its prompt |
| `prefetch(query)` | `POST /api/context/semantic` | Notes that match this prompt, from every agent in the project |
| `system_prompt_block()` | `GET /api/context/inject` | The project's recent work, once at session start |
| `on_memory_write` (add/replace) | `POST /api/memory/save` | Hermes's own memory notes become claude-mem notes |
| `on_session_end` / `on_session_switch` | `POST /api/sessions/summarize` | Closes the session with its last answer |

- The project is never named here: each call carries the session's working
  directory and claude-mem works out the project the same way it does for Claude
  Code, so a Hermes session and a Claude Code session in one checkout share notes.
- Writes go through one background thread, in order, so Hermes never waits on
  them. Reads wait at most 3 seconds.
- Scheduled jobs and other non-primary Hermes agents read memory but record nothing.
- When claude-mem is not running, every call fails quietly; three failures in a row
  pause calls for 30 seconds.
- With `CLAUDE_MEM_RUNTIME=server` and `CLAUDE_MEM_SERVER_URL`,
  `CLAUDE_MEM_SERVER_API_KEY` and `CLAUDE_MEM_SERVER_PROJECT_ID` set (in the
  environment or `~/.claude-mem/settings.json`), the same events go to the hosted
  server's `/v1` API instead.

## Install

```bash
npx claude-mem install --ide hermes
```

This copies the plugin to `$HERMES_HOME/plugins/claude-mem/` (default
`~/.hermes/plugins/claude-mem/`), and in `$HERMES_HOME/config.yaml` sets:

```yaml
memory:
  provider: claude-mem
mcp_servers:
  claude-mem:
    command: "/path/to/node"
    args:
      - "/path/to/claude-mem/plugin/scripts/mcp-server.cjs"
    enabled: true
```

The MCP entry gives Hermes claude-mem's search tools (`dumb_search`, `search`,
`timeline`, `get_observations`, `save_memory`). An existing `mcp_servers.claude-mem`
entry you wrote yourself is left alone.

`npx claude-mem uninstall` removes the plugin files, puts back the memory provider
you had before, and removes the MCP entry only if the installer added it and it has not been edited since.
