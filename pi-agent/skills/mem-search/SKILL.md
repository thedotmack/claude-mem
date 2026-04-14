---
name: mem-search
description: Search pi-mem's persistent cross-session memory database. Use when user asks "did we already solve this?", "how did we do X last time?", or needs work from previous sessions.
---

# Memory Search (Pi-Mem)

Search past work across all pi-agent sessions. The `memory_recall` tool is registered automatically by the pi-mem extension.

## When to Use

Use when users ask about PREVIOUS sessions (not current conversation):

- "Did we already fix this?"
- "How did we solve X last time?"
- "What happened last week?"
- "What do you remember about the auth refactor?"

## Usage

The `memory_recall` tool is available in your tool list. Call it with a natural language query:

```text
memory_recall(query="authentication middleware refactor", limit=10)
```

**Parameters:**

- `query` (string, required) — Natural language search term
- `limit` (number, optional) — Max results, default 5

## Tips

- Search broad first, then narrow: "auth" before "JWT token rotation in middleware"
- The tool searches across ALL engines (Claude Code, OpenClaw, other pi-agents) for the same project
- Results include observation summaries, session titles, and timestamps
- If you need more detail, ask follow-up questions using specific terms from the initial results

## How It Works

The `memory_recall` tool calls the claude-mem worker's search API, which uses hybrid search:
1. **FTS5** — full-text keyword matching on observation content
2. **Chroma** — vector similarity search for semantic meaning

Results are merged and ranked by relevance.
