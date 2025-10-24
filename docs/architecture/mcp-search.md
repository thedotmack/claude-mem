# MCP Search Server

Claude-Mem includes a Model Context Protocol (MCP) server that exposes 7 specialized search tools for querying stored observations and sessions.

## Overview

- **Location**: `src/servers/search-server.ts`
- **Configuration**: `plugin/.mcp.json`
- **Transport**: stdio
- **Tools**: 7 specialized search functions
- **Citations**: All results use `claude-mem://` URI scheme

## Configuration

The MCP server is automatically registered via `plugin/.mcp.json`:

```json
{
  "mcpServers": {
    "claude-mem-search": {
      "type": "stdio",
      "command": "${CLAUDE_PLUGIN_ROOT}/scripts/search-server.js"
    }
  }
}
```

This registers the `claude-mem-search` server with Claude Code, making the 7 search tools available in all sessions. The server is automatically started when Claude Code launches and communicates via stdio transport.

## Search Tools

### 1. search_observations

Full-text search across observation titles, narratives, facts, and concepts.

**Parameters**:
- `query` (required): Search query for FTS5 full-text search
- `type`: Filter by observation type(s) (decision, bugfix, feature, refactor, discovery, change)
- `concepts`: Filter by concept tags
- `files`: Filter by file paths (partial match)
- `project`: Filter by project name
- `dateRange`: Filter by date range (`{start, end}`)
- `orderBy`: Sort order (relevance, date_desc, date_asc)
- `limit`: Maximum results (default: 20, max: 100)
- `offset`: Number of results to skip
- `format`: Output format ("index" for titles/dates only, "full" for complete details)

**Example**:
```
search_observations with query="build system" and type="decision"
```

### 2. search_sessions

Full-text search across session summaries, requests, and learnings.

**Parameters**:
- `query` (required): Search query for FTS5 full-text search
- `project`: Filter by project name
- `dateRange`: Filter by date range
- `orderBy`: Sort order (relevance, date_desc, date_asc)
- `limit`: Maximum results (default: 20, max: 100)
- `offset`: Number of results to skip
- `format`: Output format ("index" or "full")

**Example**:
```
search_sessions with query="hooks implementation"
```

### 3. search_user_prompts

Search raw user prompts with full-text search. Use this to find what the user actually said/requested across all sessions.

**Parameters**:
- `query` (required): Search query for FTS5 full-text search
- `project`: Filter by project name
- `dateRange`: Filter by date range
- `orderBy`: Sort order (relevance, date_desc, date_asc)
- `limit`: Maximum results (default: 20, max: 100)
- `offset`: Number of results to skip
- `format`: Output format ("index" for truncated prompts/dates, "full" for complete prompt text)

**Example**:
```
search_user_prompts with query="authentication feature"
```

**Benefits**:
- Full context reconstruction from user intent → Claude actions → outcomes
- Pattern detection for repeated requests
- Improved debugging by tracing from original user words to final implementation

### 4. find_by_concept

Find observations tagged with specific concepts.

**Parameters**:
- `concept` (required): Concept tag to search for
- `project`: Filter by project name
- `dateRange`: Filter by date range
- `orderBy`: Sort order (relevance, date_desc, date_asc)
- `limit`: Maximum results (default: 20, max: 100)
- `offset`: Number of results to skip
- `format`: Output format ("index" or "full")

**Example**:
```
find_by_concept with concept="architecture"
```

### 5. find_by_file

Find observations and sessions that reference specific file paths.

**Parameters**:
- `filePath` (required): File path to search for (supports partial matching)
- `project`: Filter by project name
- `dateRange`: Filter by date range
- `orderBy`: Sort order (relevance, date_desc, date_asc)
- `limit`: Maximum results (default: 20, max: 100)
- `offset`: Number of results to skip
- `format`: Output format ("index" or "full")

**Example**:
```
find_by_file with filePath="worker-service.ts"
```

### 6. find_by_type

Find observations by type (decision, bugfix, feature, refactor, discovery, change).

**Parameters**:
- `type` (required): Observation type(s) to filter by (single type or array)
- `project`: Filter by project name
- `dateRange`: Filter by date range
- `orderBy`: Sort order (relevance, date_desc, date_asc)
- `limit`: Maximum results (default: 20, max: 100)
- `offset`: Number of results to skip
- `format`: Output format ("index" or "full")

**Example**:
```
find_by_type with type=["decision", "feature"]
```

### 7. get_recent_context

Get recent session context including summaries and observations for a project.

**Parameters**:
- `project`: Project name (defaults to current working directory basename)
- `limit`: Number of recent sessions to retrieve (default: 3, max: 10)

**Example**:
```
get_recent_context with limit=5
```

## Output Formats

All search tools support two output formats:

### Index Format (Default)

Returns titles, dates, and source URIs only. Uses ~10x fewer tokens than full format.

**Always use index format first** to get an overview and identify relevant results.

**Example Output**:
```
1. [decision] Implement graceful session cleanup
   Date: 2025-10-21 14:23:45
   Source: claude-mem://observation/123

2. [feature] Add FTS5 full-text search
   Date: 2025-10-21 13:15:22
   Source: claude-mem://observation/124
```

### Full Format

Returns complete observation/summary details including narrative, facts, concepts, files, etc.

**Only use after reviewing index results** to dive deep into specific items of interest.

## Search Strategy

**Recommended Workflow**:

1. **Initial search**: Use default (index) format to see titles, dates, and sources
2. **Review results**: Identify which items are most relevant to your needs
3. **Deep dive**: Only then use `format: "full"` on specific items of interest
4. **Narrow down**: Use filters (type, dateRange, concepts, files) to refine results

**Token Efficiency**:
- Index format: ~50-100 tokens per result
- Full format: ~500-1000 tokens per result
- Start with 3-5 results to avoid MCP token limits

## Citations

All search results use the `claude-mem://` URI scheme for citations:

- `claude-mem://observation/{id}` - References specific observations
- `claude-mem://session/{id}` - References specific sessions
- `claude-mem://user-prompt/{id}` - References specific user prompts

These citations allow Claude to reference specific historical context in responses.

## FTS5 Query Syntax

The `query` parameter supports SQLite FTS5 full-text search syntax:

- **Simple**: `"error handling"`
- **AND**: `"error" AND "handling"`
- **OR**: `"bug" OR "fix"`
- **NOT**: `"bug" NOT "feature"`
- **Phrase**: `"'exact phrase'"`
- **Column**: `title:"authentication"`

## Security

As of v4.2.3, all FTS5 queries are properly escaped to prevent SQL injection attacks:
- Double quotes are escaped: `query.replace(/"/g, '""')`
- Comprehensive test suite with 332 injection attack tests
- Affects: `search_observations`, `search_sessions`, `search_user_prompts`

## Example Queries

```
# Find all decisions about build system
search_observations with query="build system" and type="decision"

# Show everything related to worker-service.ts
find_by_file with filePath="worker-service.ts"

# Search what we learned about hooks
search_sessions with query="hooks"

# Show observations tagged with 'architecture'
find_by_concept with concept="architecture"

# Find what user asked about authentication
search_user_prompts with query="authentication"

# Get recent context for debugging
get_recent_context with limit=5
```

## Implementation

The MCP search server is implemented using:
- `@modelcontextprotocol/sdk` (v1.20.1)
- `SessionSearch` service for FTS5 queries
- `SessionStore` for database access
- `zod-to-json-schema` for parameter validation

**Source Code**: `src/servers/search-server.ts`

## Troubleshooting

### Tool Not Available

If search tools are not available in Claude Code sessions:

1. Check MCP configuration:
   ```bash
   cat plugin/.mcp.json
   ```

2. Verify search server is built:
   ```bash
   ls -l plugin/scripts/search-server.js
   ```

3. Rebuild if needed:
   ```bash
   npm run build
   ```

### Search Returns No Results

1. Check database has data:
   ```bash
   sqlite3 ~/.claude-mem/claude-mem.db "SELECT COUNT(*) FROM observations;"
   ```

2. Verify FTS5 tables exist:
   ```bash
   sqlite3 ~/.claude-mem/claude-mem.db "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%_fts';"
   ```

3. Test query syntax:
   ```bash
   # Simple query should work
   search_observations with query="test"
   ```

### Token Limit Errors

If you hit MCP token limits:

1. Use `format: "index"` instead of `format: "full"`
2. Reduce `limit` parameter (try 3-5 instead of 20)
3. Use more specific filters to narrow results
4. Use `offset` to paginate through results
