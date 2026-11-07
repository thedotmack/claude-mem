---
name: mem-search
description: >
  This skill should be used when the user asks to "search memory", "what do you
  remember about X", "check claude-mem", "mem search", "find past observations",
  "what did we do last session", or wants prior-session context about a project,
  decision, file, or task. Searches the user's Claude-Mem (cmem.ai) memory.
metadata:
  version: "0.1.0"
---

# Claude-Mem Search (Cowork)

Search the user's persistent Claude-Mem memory on cmem.ai. Memory contains
timestamped observations synthesized from past sessions across all their
agents (Claude Code, Cowork, Codex, and others).

## How to search

Run the bundled CLI (no dependencies, uses the plugin's configured API key):

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/cmem-hook.mjs" search "your query" --limit 20
```

## Progressive search method

Follow claude-mem's Index → Timeline → Transcript discipline — cheap passes
first, expensive detail only for confirmed hits:

1. **Index pass** — run 1–3 broad keyword searches (project names, file names,
   error strings, feature names). Skim titles/summaries only.
2. **Narrow pass** — re-search with the most specific terms found in step 1
   (IDs, exact phrases) and a smaller `--limit`.
3. **Answer** — synthesize from the observations returned. Quote timestamps
   when the user asks "when".

Do not dump raw search output at the user; extract the relevant observations
and answer in plain language.

## Diagnostics

If searches return nothing or error:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/cmem-hook.mjs" status
```

Report the status output plainly: a MISSING api key means the plugin needs the
user's cmem.ai key added to its configuration; a 404 on `/api/hooks/context`
just means the newer Pro endpoint isn't deployed — search still works via
`/api/mcp`.

## Notes

- Some filters (date ranges, type) may be silently ignored by the cloud API
  until MCP parity ships — prefer keyword narrowing over filter flags.
- Never write secrets into search queries; queries are sent to cmem.ai.
