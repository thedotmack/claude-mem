---
name: mem-search
description: >-
  Use this when the user asks to search memory, "did we already solve this?",
  "how did we do X last time?", or wants work from previous sessions.
---
# mem-search

3-layer workflow. Do not dump full observations until IDs are filtered.

1. `search(query)` — index with IDs
2. `timeline(anchor=ID)` — nearby context
3. `get_observations(ids=[...])` — full details for those IDs only

Stamp `platformSource` as `cursor` or `grok-bot` on writes for this host. When reading, do not drop the other host unless asked.

If MCP is missing, run the install skill first (`npx claude-mem install --ide <host>`).
