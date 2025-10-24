# MCP Search Tools Usage

Once claude-mem is installed as a plugin, 7 search tools become available in your Claude Code sessions for querying project history.

## Quick Reference

| Tool                    | Purpose                                      |
|-------------------------|----------------------------------------------|
| search_observations     | Full-text search across observations         |
| search_sessions         | Full-text search across session summaries    |
| search_user_prompts     | Full-text search across raw user prompts     |
| find_by_concept         | Find observations tagged with concepts       |
| find_by_file            | Find observations referencing files          |
| find_by_type            | Find observations by type                    |
| get_recent_context      | Get recent session context                   |

## Example Queries

### search_observations

Find all decisions about the build system:
```
Use search_observations to find all decisions about the build system
```

Find bugs related to authentication:
```
search_observations with query="authentication" and type="bugfix"
```

Search for refactoring work:
```
search_observations with query="refactor database" and type="refactor"
```

### search_sessions

Find what we learned about hooks:
```
Use search_sessions to find what we learned about hooks
```

Search for completed work on the API:
```
search_sessions with query="API implementation"
```

### search_user_prompts

Find when user asked about authentication:
```
search_user_prompts with query="authentication feature"
```

Trace user requests for a specific feature:
```
search_user_prompts with query="dark mode"
```

**Benefits**:
- See exactly what the user asked for (vs what was implemented)
- Detect patterns in repeated requests
- Debug miscommunications between user intent and implementation

### find_by_file

Show everything related to worker-service.ts:
```
Use find_by_file to show me everything related to worker-service.ts
```

Find all work on the database migration file:
```
find_by_file with filePath="migrations.ts"
```

### find_by_concept

Show observations tagged with 'architecture':
```
Use find_by_concept to show observations tagged with 'architecture'
```

Find all 'security' related observations:
```
find_by_concept with concept="security"
```

### find_by_type

Find all feature implementations:
```
find_by_type with type="feature"
```

Find all decisions and discoveries:
```
find_by_type with type=["decision", "discovery"]
```

### get_recent_context

Get the last 5 sessions for context:
```
get_recent_context with limit=5
```

Get recent context for debugging:
```
Use get_recent_context to show me what we've been working on
```

## Search Strategy

### 1. Start with Index Format

**Always use index format first** to get an overview:

```
search_observations with query="authentication" and format="index"
```

**Why?**
- Index format uses ~10x fewer tokens than full format
- See titles, dates, and sources to identify relevant results
- Avoid hitting MCP token limits

### 2. Review Results

Look at the index results to identify items of interest:

```
1. [decision] Implement JWT authentication
   Date: 2025-10-21 14:23:45
   Source: claude-mem://observation/123

2. [feature] Add user authentication endpoints
   Date: 2025-10-21 13:15:22
   Source: claude-mem://observation/124

3. [bugfix] Fix authentication token expiry
   Date: 2025-10-20 16:45:30
   Source: claude-mem://observation/125
```

### 3. Deep Dive with Full Format

Only use full format for specific items:

```
search_observations with query="JWT authentication" and format="full" and limit=3
```

### 4. Use Filters to Narrow Results

Combine filters for precise searches:

```
search_observations with query="authentication" and type="decision" and dateRange={start: "2025-10-20", end: "2025-10-21"}
```

## Advanced Filtering

### Date Ranges

Search within specific time periods:

```json
{
  "dateRange": {
    "start": "2025-10-01",
    "end": "2025-10-31"
  }
}
```

Or use epoch timestamps:

```json
{
  "dateRange": {
    "start": 1729449600,
    "end": 1732128000
  }
}
```

### Multiple Types

Search across multiple observation types:

```
find_by_type with type=["decision", "feature", "refactor"]
```

### Multiple Concepts

Search observations with specific concepts:

```
search_observations with query="database" and concepts=["architecture", "performance"]
```

### File Filtering

Search observations that touched specific files:

```
search_observations with query="refactor" and files="worker-service.ts"
```

### Project Filtering

Search within specific projects:

```
search_observations with query="authentication" and project="my-app"
```

## FTS5 Query Syntax

The `query` parameter supports SQLite FTS5 full-text search syntax:

### Simple Queries
```
"authentication"           # Single word
"error handling"           # Multiple words (OR)
```

### Boolean Operators
```
"error" AND "handling"     # Both terms required
"bug" OR "fix"             # Either term
"bug" NOT "feature"        # First term, not second
```

### Phrase Searches
```
"'exact phrase'"           # Exact phrase match
```

### Column Searches
```
title:"authentication"     # Search specific column
narrative:"bug fix"        # Search narrative field
```

## Result Metadata

All results include rich metadata:

```
## JWT authentication decision

**Type**: decision
**Date**: 2025-10-21 14:23:45
**Concepts**: authentication, security, architecture
**Files Read**: src/auth/middleware.ts, src/utils/jwt.ts
**Files Modified**: src/auth/jwt-strategy.ts

**Narrative**:
Decided to implement JWT-based authentication instead of session-based
authentication for better scalability and stateless design...

**Facts**:
• JWT tokens expire after 1 hour
• Refresh tokens stored in httpOnly cookies
• Token signing uses RS256 algorithm
• Public keys rotated every 30 days
```

## Citations

All search results include citations using the `claude-mem://` URI scheme:

- `claude-mem://observation/123` - Specific observation
- `claude-mem://session/abc-456` - Specific session
- `claude-mem://user-prompt/789` - Specific user prompt

These citations enable referencing specific historical context in your work.

## Token Management

### Token Efficiency Tips

1. **Start with index format**: ~50-100 tokens per result
2. **Use small limits**: Start with 3-5 results
3. **Apply filters**: Narrow results before searching
4. **Paginate**: Use offset to browse results in batches

### Token Estimates

| Format | Tokens per Result |
|--------|-------------------|
| Index  | 50-100            |
| Full   | 500-1000          |

**Example**:
- 20 results in index format: ~1,000-2,000 tokens
- 20 results in full format: ~10,000-20,000 tokens

## Common Use Cases

### 1. Debugging Issues

Find what went wrong:
```
search_observations with query="error database connection" and type="bugfix"
```

### 2. Understanding Decisions

Review architectural choices:
```
find_by_type with type="decision" and format="index"
```

Then deep dive on specific decisions:
```
search_observations with query="[DECISION TITLE]" and format="full"
```

### 3. Code Archaeology

Find when a file was modified:
```
find_by_file with filePath="worker-service.ts"
```

### 4. Feature History

Track feature development:
```
search_sessions with query="authentication feature"
search_user_prompts with query="add authentication"
```

### 5. Learning from Past Work

Review refactoring patterns:
```
find_by_type with type="refactor" and limit=10
```

### 6. Context Recovery

Restore context after time away:
```
get_recent_context with limit=5
search_sessions with query="[YOUR PROJECT NAME]" and orderBy="date_desc"
```

## Best Practices

1. **Index first, full later**: Always start with index format
2. **Small limits**: Start with 3-5 results to avoid token limits
3. **Use filters**: Narrow results before searching
4. **Specific queries**: More specific = better results
5. **Review citations**: Use citations to reference past decisions
6. **Date filtering**: Use date ranges for time-based searches
7. **Type filtering**: Use types to categorize searches
8. **Concept tags**: Use concepts for thematic searches

## Troubleshooting

### No Results Found

1. Check database has data:
   ```bash
   sqlite3 ~/.claude-mem/claude-mem.db "SELECT COUNT(*) FROM observations;"
   ```

2. Try broader query:
   ```
   search_observations with query="authentication"  # Good
   vs
   search_observations with query="'exact JWT authentication implementation'"  # Too specific
   ```

3. Remove filters:
   ```
   # Start broad
   search_observations with query="auth"

   # Then add filters
   search_observations with query="auth" and type="decision"
   ```

### Token Limit Errors

1. Use index format:
   ```
   search_observations with query="..." and format="index"
   ```

2. Reduce limit:
   ```
   search_observations with query="..." and limit=3
   ```

3. Use pagination:
   ```
   # First page
   search_observations with query="..." and limit=5 and offset=0

   # Second page
   search_observations with query="..." and limit=5 and offset=5
   ```

### Search Too Slow

1. Use more specific queries
2. Add date range filters
3. Add type/concept filters
4. Reduce result limit

## Next Steps

- [MCP Search Architecture](../architecture/mcp-search.md) - Technical details
- [Database Schema](../architecture/database.md) - Understanding the data
- [Getting Started](getting-started.md) - Automatic operation
