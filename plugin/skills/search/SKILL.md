---
name: search
description: |
  **AUTO-INVOKE THIS SKILL** when users ask about past work, history, previous sessions, what was done before, bug fixes, features implemented, decisions made, or any question requiring context from previous interactions. This skill searches claude-mem's persistent memory across all past sessions to find relevant observations, decisions, code changes, and work history. Use it proactively whenever questions involve "what did we...", "how did we...", "did we fix...", "what bugs...", "what features...", "last session...", "yesterday...", "last week...", or any temporal/historical queries.
---

# Claude-Mem Search Skill

Access claude-mem's persistent memory through a comprehensive HTTP API. Search for past work, understand context, and learn from previous decisions.

## 🔑 Key Tools Available

1. **`claude-mem-search.cjs` wrapper script** (RECOMMENDED): Unified command-line tool that wraps all search endpoints with a single permission prompt. Eliminates repeated permission requests.

2. **Direct HTTP API**: Use curl for direct API access (requires permission for each request).

## ⚠️ CRITICAL: Reading Documentation

**When fetching API documentation or help information:**
- **ALWAYS** read the complete response without truncation
- **NEVER** use `head`, `tail`, or other truncation commands on documentation endpoints
- **ONLY** truncate actual data responses (search results) when appropriate to save tokens

Example - ✅ CORRECT:
```bash
claude-mem-search help  # Reads complete documentation
```

Example - ❌ WRONG:
```bash
curl -s "http://localhost:37777/api/search/help" | head -100  # TRUNCATES DOCS!
```

## When to Use This Skill

**Invoke this skill when users ask about:**
- Past work: "What did we do last session?"
- Bug fixes: "Did we fix this before?" or "What bugs did we fix?"
- Features: "How did we implement authentication?"
- Decisions: "Why did we choose this approach?"
- Code changes: "What files were modified in that refactor?"
- File history: "What changes to auth/login.ts?"
- Timeline context: "What was happening around that time?"
- Recent activity: "What have we been working on?"

**Do NOT invoke** for current session work or future planning (use regular tools for that).

## Quick Decision Guide

Once the skill is loaded, choose the appropriate operation:

**What are you looking for?**

- "What did we do last session?" → [operations/recent-context.md](operations/recent-context.md)
- "Did we fix this bug before?" → [operations/by-type.md](operations/by-type.md) (type=bugfix)
- "How did we implement X?" → [operations/observations.md](operations/observations.md)
- "What changes to file.ts?" → [operations/by-file.md](operations/by-file.md)
- "What was happening then?" → [operations/timeline.md](operations/timeline.md)
- "Why did we choose X?" → [operations/observations.md](operations/observations.md) (search for decisions)

## Available Operations

Choose the appropriate operation file for detailed instructions:

### Full-Text Search
1. **[Search Observations](operations/observations.md)** - Find observations by keyword (bugs, features, decisions, etc.)
2. **[Search Sessions](operations/sessions.md)** - Search session summaries to understand what was accomplished
3. **[Search Prompts](operations/prompts.md)** - Find what users have asked about in the past

### Filtered Search
4. **[Search by Type](operations/by-type.md)** - Find bugfix, feature, refactor, decision, or discovery observations
5. **[Search by Concept](operations/by-concept.md)** - Find observations tagged with specific concepts
6. **[Search by File](operations/by-file.md)** - Find all work related to a specific file path

### Context Retrieval
7. **[Get Recent Context](operations/recent-context.md)** - Get recent session summaries and observations for a project
8. **[Get Timeline](operations/timeline.md)** - Get chronological timeline around a specific point in time
9. **[Timeline by Query](operations/timeline-by-query.md)** - Search then get timeline around the best match

### Utilities
10. **[API Help](operations/help.md)** - Get API documentation

## Common Workflows

For step-by-step guides on typical user requests, see [operations/common-workflows.md](operations/common-workflows.md):
- Understanding past work
- Finding specific bug fixes
- Understanding file history
- Timeline investigation

## Response Formatting

For guidelines on how to present search results to users, see [operations/formatting.md](operations/formatting.md):
- Format=index responses (compact lists)
- Format=full responses (complete details)
- Timeline responses (chronologically grouped)

## Technical Notes

- **Wrapper Script:** `claude-mem-search.cjs` command available in `plugin/scripts/` - **USE THIS** to avoid repeated permission prompts
- **Port:** Default 37777 (configurable via `CLAUDE_MEM_WORKER_PORT`)
- **Response format:** Always JSON
- **Search type:** FTS5 full-text search + structured filters
- **Date filtering:** All search endpoints support `--from` and `--to` parameters (ISO strings or Unix timestamps)
- **All operations use HTTP GET** with query parameters

## Performance Tips

1. **USE the wrapper script** (`claude-mem-search.cjs`) instead of curl to minimize permission prompts
2. Use **format=index** first for overviews, then **format=full** for details
3. Start with **limit=5-10**, expand if needed
4. Use **project filtering** when working on one codebase
5. Use **date range filtering** (--from/--to) for temporal queries like "yesterday" or "last week"
6. Use **timeline depth** of 5-10 for focused context
7. Be specific in search queries: "authentication JWT" > "auth"

## Error Handling

If HTTP request fails:
1. Inform user the search service isn't available
2. Suggest checking if worker is running: `pm2 list`
3. Offer to help troubleshoot

For detailed error handling, see the specific operation files.
