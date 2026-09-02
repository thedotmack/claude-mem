# claude-mem store plugins

Two listings, one repo. Cursor and Grok Bot plugin stores share the Cursor catalog (`SearchPlugins` / [cursor.com/marketplace/publish](https://cursor.com/marketplace/publish)).

| Plugin | Install | Ingest | Observer |
|---|---|---|---|
| `claude-mem-cursor` | Grok Bot store or Cursor store | Cursor hooks | local host-login **or** remote cmem.ai |
| `claude-mem-grok-bot` | Grok Bot store or Cursor store | transcript watcher | local host-login **or** remote cmem.ai |

Neither listing requires the other IDE.

## Local vs remote

- **Local worker:** `npx claude-mem install --ide cursor|grok-bot` then MCP `claude-mem-local`
- **Remote worker:** plugin variable `CLAUDE_MEM_MCP_TOKEN` + MCP `claude-mem-remote` (`https://cmem.ai/api/mcp`)
- **Local observer:** `--provider host` (shim on a free port, never the worker port)
- **Remote observer:** existing openrouter / `https://cmem.ai/api/inference/v1`

## Publish

1. Land these trees in https://github.com/thedotmack/claude-mem (root `.cursor-plugin/marketplace.json` plus the two plugin dirs, or merge into `plugin/`).
2. Add `npx claude-mem mcp` (stdio MCP) and `npx claude-mem hook cursor …` if missing.
3. Submit the repo at https://cursor.com/marketplace/publish — that is the Grok Bot plugin store **and** the Cursor plugin store.
4. Optional extra: Grok **Build** CLI marketplace is a different catalog (`xai-org/plugin-marketplace`).

## XML contract

Idle: `<skip_summary reason="noise" />`. Finished unit: one `<observation>`. Prose is dropped.
