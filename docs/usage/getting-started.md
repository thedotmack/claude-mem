# Getting Started with Claude-Mem

## Automatic Operation

Claude-Mem works automatically once installed. No manual intervention required!

### The Full Cycle

1. **Start Claude Code** - Context from last 3 sessions appears automatically
2. **Work normally** - Every tool execution is captured
3. **Stop Claude** - Summary is generated and saved
4. **Next session** - Previous work appears in context

### What Gets Captured

Every time Claude uses a tool, claude-mem captures it:

- **Read** - File reads and content access
- **Write** - New file creation
- **Edit** - File modifications
- **Bash** - Command executions
- **Glob** - File pattern searches
- **Grep** - Content searches
- And all other Claude Code tools

### What Gets Processed

The worker service processes tool observations and extracts:

- **Title** - Brief description of what happened
- **Subtitle** - Additional context
- **Narrative** - Detailed explanation
- **Facts** - Key learnings as bullet points
- **Concepts** - Relevant tags and categories
- **Type** - Classification (decision, bugfix, feature, etc.)
- **Files** - Which files were read or modified

### Session Summaries

When you stop Claude (or a session ends), a summary is generated with:

- **Request** - What you asked for
- **Investigated** - What Claude explored
- **Learned** - Key discoveries and insights
- **Completed** - What was accomplished
- **Next Steps** - What to do next

### Context Injection

When you start a new Claude Code session, the SessionStart hook:

1. Queries the database for recent sessions in your project
2. Retrieves the last 10 session summaries
3. Formats them with three-tier verbosity (most recent = most detail)
4. Injects them into Claude's initial context

This means Claude "remembers" what happened in previous sessions!

## Manual Commands (Optional)

### Worker Management

v4.0+ auto-starts the worker on first session. Manual commands below are optional.

```bash
# Start worker service (optional - auto-starts automatically)
npm run worker:start

# Stop worker service
npm run worker:stop

# Restart worker service
npm run worker:restart

# View worker logs
npm run worker:logs

# Check worker status
npm run worker:status
```

### Testing

```bash
# Run all tests
npm test

# Test context injection
npm run test:context

# Verbose context test
npm run test:context:verbose
```

### Development

```bash
# Build hooks and worker
npm run build

# Build only hooks
npm run build:hooks

# Publish to NPM (maintainers only)
npm run publish:npm
```

## Viewing Stored Context

Context is stored in SQLite database at `~/.claude-mem/claude-mem.db`.

Query the database directly:

```bash
# Open database
sqlite3 ~/.claude-mem/claude-mem.db

# View recent sessions
SELECT session_id, project, created_at, status
FROM sdk_sessions
ORDER BY created_at DESC
LIMIT 10;

# View session summaries
SELECT session_id, request, completed, learned
FROM session_summaries
ORDER BY created_at DESC
LIMIT 5;

# View observations for a session
SELECT tool_name, created_at
FROM observations
WHERE session_id = 'YOUR_SESSION_ID';
```

## Understanding Verbosity Levels

Context injection uses three-tier verbosity for efficient token usage:

### Tier 1 (Most Recent Session)
- Full summary with all details
- Request, investigated, learned, completed, next_steps, notes
- ~500-1000 tokens

### Tier 2 (Sessions 2-5)
- Medium detail
- Request, learned, completed
- ~200-400 tokens

### Tier 3 (Sessions 6-10)
- Brief summary
- Request and completed only
- ~100-200 tokens

This ensures you get maximum detail for recent work while still having context from older sessions.

## Multi-Prompt Sessions

Claude-Mem supports sessions that span multiple user prompts:

- **prompt_counter**: Tracks total prompts in a session
- **prompt_number**: Identifies specific prompt within session
- **Session continuity**: Observations and summaries link across prompts

When you use `/clear`, the session doesn't end - it continues with a new prompt number. This preserves context across conversation restarts.

## Next Steps

- [MCP Search Tools](search-tools.md) - Learn how to search your project history
- [Architecture Overview](../architecture/overview.md) - Understand how it works
- [Troubleshooting](../troubleshooting.md) - Common issues and solutions
