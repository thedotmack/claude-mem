---
name: mem-search
description: >-
  Use this when the user asks to search memory, "did we already solve this?",
  "how did we do X last time?", or wants work from previous sessions.
---
# mem-search

Layered workflow. Do not dump full observations until IDs are filtered, and do not reach for raw tool bodies until the summaries came up short.

1. `search(query)` — index with IDs
2. `timeline(anchor=ID)` — nearby context
3. `get_observations(ids=[...])` — full details for those IDs only
4. `get_tool_uses(ids=[...])` — the ORIGINAL `tool_input` / `tool_response` for specific tool calls. Last resort: these are unsummarized and can run to thousands of tokens each.

Stamp `platformSource` as `cursor` or `grok-bot` on writes for this host. When reading, do not drop the other host unless asked.

If MCP is missing, run the install skill first (`npx claude-mem install --ide <host>`).
