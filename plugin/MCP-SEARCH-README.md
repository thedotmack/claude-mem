# Optional: MCP Search Server

By default, claude-mem uses **skill-based search** with progressive disclosure, which loads only ~250 tokens at session start and the full ~2,500 tokens on-demand when you invoke the search skill.

If you prefer, you can enable the **MCP search server** which loads all 9 search tool definitions (~2,500 tokens) at every session start.

## Trade-offs

### Skill-Based Search (Default)
✅ **Pros:**
- ~2,250 token savings per session start (90% reduction)
- Progressive disclosure: full details loaded only when needed
- Same search functionality via HTTP API

❌ **Cons:**
- Tools not visible in Claude's tool list
- Must invoke via natural language ("What did we do last session?")

### MCP Search Server (Optional)
✅ **Pros:**
- All 9 search tools visible in Claude's tool list
- Direct tool invocation by Claude
- Explicit control over which tool to use

❌ **Cons:**
- ~2,500 additional tokens loaded at every session start
- No progressive disclosure benefits

## How to Enable MCP Search

To enable the MCP search server, use the viewer UI:

1. **Open the viewer** at `http://localhost:37777`
2. **Click the settings gear icon** (top-right corner)
3. **Check "Enable MCP Search Server"**
4. **Click "Save"**
5. **Restart Claude Code** for changes to take effect

The system will automatically manage the `.mcp.json` configuration file for you.

## How to Disable MCP Search

To disable the MCP search server and return to skill-based search:

1. **Open the viewer** at `http://localhost:37777`
2. **Click the settings gear icon** (top-right corner)
3. **Uncheck "Enable MCP Search Server"**
4. **Click "Save"**
5. **Restart Claude Code** for changes to take effect

## Available Search Tools

When MCP is enabled, you'll have access to these 9 tools:

1. **search_observations** - Full-text search across observations
2. **search_sessions** - Search session summaries
3. **search_user_prompts** - Search raw user prompts
4. **find_by_concept** - Find by concept tag (decision, bugfix, feature, etc.)
5. **find_by_file** - Find work related to specific file paths
6. **find_by_type** - Filter observations by type
7. **get_recent_context** - Get recent session context
8. **get_context_timeline** - Get timeline around a point in time
9. **get_timeline_by_query** - Search + timeline in one operation

All tools support:
- **Hybrid search:** Semantic (Chroma) + keyword (FTS5)
- **Format toggle:** `index` (compact) vs `full` (detailed)
- **Filters:** project, date range, limit, offset, sort order

## Questions?

For more details about the architecture and search functionality, see:
- [Search Architecture Docs](../docs/architecture/search-architecture.mdx)
- [CLAUDE.md](../CLAUDE.md) - Development guide
- [CHANGELOG.md](../CHANGELOG.md) - v5.4.0 migration notes
