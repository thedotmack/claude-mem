# Claude-Mem: Persistent Memory for Claude Code

## Overview

Claude-mem is a persistent memory compression system that preserves context across Claude Code sessions. It automatically captures tool usage observations, processes them through the Claude Agent SDK, and makes summaries available to future sessions.

**Current Version**: 5.0.1
**License**: AGPL-3.0
**Author**: Alex Newman (@thedotmack)

## What It Does

Claude-mem operates as a Claude Code plugin that:
- Captures every tool execution during your coding sessions
- Processes observations using AI-powered compression
- Generates session summaries when sessions end
- Injects relevant context into future sessions
- Provides full-text search across your entire project history

This creates a continuous memory system where Claude can learn from past sessions and maintain context across your entire project lifecycle.

## Architecture

### Hook-Based Lifecycle System

Claude-mem integrates with Claude Code through 5 lifecycle hooks:

1. **SessionStart Hook** (`context-hook`)
   - Ensures dependencies are installed (runs fast idempotent npm install)
   - Injects context from previous sessions
   - Auto-starts PM2 worker service
   - Retrieves last 10 session summaries with three-tier verbosity (v4.2.0)
   - Fixed in v4.1.0 to use proper JSON hookSpecificOutput format

2. **UserPromptSubmit Hook** (`new-hook`)
   - Creates new session records
   - Initializes session tracking
   - Saves raw user prompts for full-text search (as of v4.2.0)

3. **PostToolUse Hook** (`save-hook`)
   - Captures tool execution observations
   - Sends observations to worker service for processing

4. **Summary Hook**
   - Generates AI-powered session summaries
   - Processes accumulated observations

5. **SessionEnd Hook** (`cleanup-hook`)
   - Marks sessions as completed (graceful cleanup as of v4.1.0)
   - Skips cleanup on `/clear` commands to preserve ongoing sessions
   - Previously sent DELETE requests; now allows workers to finish naturally

### Worker Service Architecture

- **Technology**: HTTP REST API built with Express.js, managed by PM2
- **Port**: Fixed port 37777 (configurable via CLAUDE_MEM_WORKER_PORT)
- **Location**: `src/services/worker-service.ts`
- **Configurable Model**: Uses `CLAUDE_MEM_MODEL` environment variable (default: claude-sonnet-4-5)

**REST API Endpoints** (6 total):
- Session management endpoints
- Observation processing endpoints
- Worker port tracking

The worker service runs as a PM2-managed background process that handles AI processing separately from the hook execution, preventing hook timeout issues.

### Database Layer

**Technology**: SQLite 3 with better-sqlite3 native module
**Location**: `~/.claude-mem/claude-mem.db`

**Note**: SessionStore and SessionSearch use better-sqlite3 as the primary database implementation. Database.ts (which uses bun:sqlite) is legacy code.

**Core Tables**:
- `sdk_sessions` - Session tracking with prompt counters
- `session_summaries` - AI-generated session summaries (multiple per session)
- `observations` - Captured tool usage with structured fields
- `user_prompts` - Raw user prompts with FTS5 search (as of v4.2.0)

**Schema Features**:
- FTS5 (Full-Text Search) virtual tables for fast searching
- Automatic sync triggers between main tables and FTS5 tables
- Support for multi-prompt sessions (prompt_counter, prompt_number)
- Hierarchical observations (title, subtitle, facts, narrative, concepts, files_read, files_modified)
- Observation types: decision, bugfix, feature, refactor, discovery, change

**Database Classes**:
- `SessionStore` - CRUD operations for sessions, observations, summaries, user prompts
- `SessionSearch` - FTS5 full-text search with 8 search methods

### MCP Search Server

**Location**: `src/servers/search-server.ts`
**Configuration**: `plugin/.mcp.json`

Exposes 8 specialized search tools to Claude:

1. **search_observations** - Full-text search across observations
2. **search_sessions** - Full-text search across session summaries
3. **search_user_prompts** - Full-text search across raw user prompts (as of v4.2.0)
4. **find_by_concept** - Find observations tagged with specific concepts
5. **find_by_file** - Find observations referencing specific file paths
6. **find_by_type** - Find observations by type (decision/bugfix/feature/etc.)
7. **get_recent_context** - Get recent session context including summaries and observations for a project
8. **advanced_search** - Combine multiple filters with full-text search

**Search Pipeline**:
```
Claude Request → MCP Server → SessionSearch Service → FTS5 Database → Results → Claude
```

**Citations**: All search results use the `claude-mem://` URI scheme for referencing specific observations and sessions.

## Installation

### Requirements
- Node.js 18+
- Claude Code plugin system

### Installation Method

**Local Marketplace Installation** (recommended as of v4.0.4+):

```bash
# 1. Clone the repository
git clone https://github.com/thedotmack/claude-mem.git
cd claude-mem

# 2. Add to Claude Code marketplace
/plugin marketplace add .claude-plugin/marketplace.json

# 3. Install the plugin
/plugin install claude-mem
```

## Configuration

### Model Selection

Configure which AI model processes your observations:

**Using the interactive script**:
```bash
./claude-mem-settings.sh
```

**Available models**:
- `claude-haiku-4-5` - Fast, cost-efficient
- `claude-sonnet-4-5` - Balanced (default)
- `claude-opus-4` - Most capable
- `claude-3-7-sonnet` - Alternative version

The script manages `CLAUDE_MEM_MODEL` in `~/.claude/settings.json`.
TODO: also have script create and manage `CLAUDE_MEM_MODEL` in `~/.claude/plugins/marketplaces/thedotmack/.env` so our worker script has access to the value (we may not even need it in our settings but only in our plugin folder since hooks shouldn't be calling queries, not sure).

### Context Display Settings

Configure how much historical context is displayed at session start via `~/.claude/settings.json`:

**Environment variable** (in the `env` section):
- `CLAUDE_MEM_CONTEXT_OBSERVATIONS` - Number of recent observations to display (default: 50, ~1.2K tokens typical)

**Example settings.json**:
```json
{
  "env": {
    "CLAUDE_MEM_MODEL": "claude-haiku-4-5",
    "CLAUDE_MEM_CONTEXT_OBSERVATIONS": "100"
  }
}
```

**Notes**:
- Higher observation counts = more context but more tokens consumed at startup
- 50 observations ≈ 4-8 hours of work ≈ 1.2K tokens
- 100 observations ≈ 1-2 days of work ≈ 2.4K tokens
- 200 observations ≈ 2-3 days of work ≈ 4.8K tokens
- Session summaries are shown when available but are not the primary timeline

## Data Flow

### Memory Pipeline
```
Tool Execution → Hook Capture → Worker Processing → AI Compression → Database Storage → Future Context Injection
```

### Search Pipeline
```
Search Query → MCP Server → SessionSearch → FTS5 Query → Results with Citations
```

### Usage Tracking

Claude-mem automatically tracks SDK usage metrics to JSONL files for cost analysis:

**Location**: `~/.claude-mem/usage-logs/usage-YYYY-MM-DD.jsonl`

**Captured Metrics**:
- Token counts (input, output, cache creation, cache read)
- Total cost in USD per API call
- Duration metrics (total time and API time)
- Number of turns per session
- Session and project attribution
- Model information

**Analysis Tools**:
```bash
# Analyze today's usage
npm run usage:today

# Analyze specific date
npm run usage:analyze 2025-11-03
```

The analysis script provides:
- Total cost and token usage
- Cache hit rates and savings
- Cost breakdowns by project
- Cost breakdowns by model
- Average cost per API call

## Development

### Directory Structure
```
claude-mem/
├── src/
│   ├── bin/hooks/          # Hook entry points
│   ├── hooks/              # Hook implementations
│   ├── services/           # Worker service
│   ├── services/sqlite/    # Database layer
│   ├── servers/            # MCP search server
│   ├── sdk/                # Claude Agent SDK integration
│   ├── shared/             # Shared utilities
│   └── utils/              # General utilities
├── plugin/                 # Built plugin files
│   ├── scripts/            # Built hook executables
│   └── .mcp.json          # MCP server configuration
└── .claude-plugin/        # Plugin metadata
    └── marketplace.json   # Marketplace definition
```

### Technology Stack
- **Language**: TypeScript
- **Database**: SQLite 3 with better-sqlite3
- **HTTP**: Express.js
- **Process Management**: PM2
- **AI SDK**: @anthropic-ai/claude-agent-sdk (v0.1.23)
- **MCP SDK**: @modelcontextprotocol/sdk (v1.20.1)
- **Schema Validation**: zod-to-json-schema (v3.24.6)

### Build Process

**Build and sync to marketplace plugin**:
```bash
npm run build
npm run sync-marketplace
```

**If you changed the worker service** (`src/services/worker-service.ts`):
```bash
npm run worker:restart
```

**What happens**:
1. `npm run build` - Compiles TypeScript and outputs hook executables to `plugin/scripts/`
2. `npm run sync-marketplace` - Syncs built files to `~/.claude/plugins/marketplaces/thedotmack/`
3. `npm run worker:restart` - (Optional) Only needed if you modified the worker service code

**Build Outputs**:
- Hook executables: `*-hook.js` (ESM format)
- Worker service: `worker-service.cjs` (CJS format)
- Search server: `search-server.js` (ESM format)

**Note**: Hook changes take effect immediately on next session. Worker changes require restart.

### Investigation Best Practices

**When investigations are failing persistently**, use Task agents for comprehensive file analysis instead of grep/search:

**❌ Don't:** Repeatedly grep and search for patterns when failing to find the issue
```bash
# Multiple failed attempts with grep, Glob, etc.
```

**✅ Do:** Deploy a Task agent to read files in full and answer specific questions
```
"Read these files in full and answer: [specific questions about the implementation]"
- Reduces token usage by delegating to a specialized agent
- Provides comprehensive analysis in one pass
- Finds issues that grep might miss due to poor query formulation
- More efficient than multiple rounds of searching
```

**Example usage:**
```
Deploy a general-purpose Task agent to:
1. Read src/hooks/context-hook.ts in full
2. Read src/servers/search-server.ts in full
3. Answer: How do these files work together? What's the current implementation state?
4. Find any bugs or inconsistencies between them
```

This approach is especially valuable when:
- You're investigating how multiple files interact
- Search queries aren't finding what you expect
- You need to understand complete implementation context
- The issue might be a subtle inconsistency between files

## Version History

For detailed version history and changelog, see [CHANGELOG.md](CHANGELOG.md).

**Current Version**: 5.0.1

### Recent Highlights

#### v5.0.1 (2025-11-04)
**Breaking Changes**: None (patch version)

**Fixes**:
- Fixed worker service stability issues (PR #47: src/services/worker-service.ts, src/shared/worker-utils.ts)
- Improved worker process management and restart reliability (src/hooks/*-hook.ts)
- Enhanced session management and logging across all hooks
- Removed error/output file redirection from PM2 ecosystem config for better debugging (ecosystem.config.cjs)

**Improvements**:
- Added GitHub Actions workflows for automated code review (PR #48)
  - Claude Code Review workflow (.github/workflows/claude-code-review.yml)
  - Claude PR Assistant workflow (.github/workflows/claude.yml)
- Better worker health checks and startup sequence
- Improved error handling and logging throughout hook lifecycle
- Cleaned up documentation files and consolidated project context

**Technical Details**:
- Modified: src/services/worker-service.ts (stability improvements)
- Modified: src/shared/worker-utils.ts (consistent formatting and readability)
- Modified: ecosystem.config.cjs (removed error/output redirection)
- Modified: src/hooks/*-hook.ts (ensure worker running before processing)
- New: .github/workflows/claude-code-review.yml
- New: .github/workflows/claude.yml
- Rebuilt: plugin/scripts/*.js (all hook executables)
- Impact: More reliable worker service with better error visibility and automated PR assistance

#### v4.3.4 (2025-11-01)
**Breaking Changes**: None (patch version)

**Fixes**:
- Fixed SessionStart hooks running on session resume (plugin/hooks/hooks.json:4)
- Added matcher configuration to only run SessionStart hooks on startup, clear, or compact events
- Prevents unnecessary hook execution and improves performance on session resume

**Technical Details**:
- Modified: plugin/hooks/hooks.json:4 (added `"matcher": "startup|clear|compact"`)
- Impact: Hooks now skip execution when resuming existing sessions

#### v4.3.3 (2025-10-27)
**Breaking Changes**: None (patch version)

**Improvements**:
- Made session display count configurable via constant (DISPLAY_SESSION_COUNT = 8) in src/hooks/context-hook.ts:11
- Added first-time setup detection with helpful user messaging in src/hooks/user-message-hook.ts:12-39
- Improved user experience: First install message clarifies why it appears under "Plugin Hook Error"

**Fixes**:
- Cleaned up profanity in code comments (src/hooks/context-hook.ts:3)
- Fixed first-time setup UX by detecting missing node_modules and showing informative message

**Technical Details**:
- Modified: src/hooks/context-hook.ts:11 (configurable DISPLAY_SESSION_COUNT constant)
- Modified: src/hooks/user-message-hook.ts:12-39 (first-time setup detection and messaging)
- Modified: plugin/scripts/context-hook.js (rebuilt)
- Modified: plugin/scripts/user-message-hook.js (rebuilt)

#### v4.3.2 (2025-10-27)
**Breaking Changes**: None (patch version)

**Improvements**:
- Added user-message-hook for displaying context to users via stderr mechanism (src/hooks/user-message-hook.ts)
- Enhanced context visibility: Hook fires simultaneously with context injection, sending duplicate message as "error" so Claude Code displays it to users
- Added comprehensive documentation (4 new MDX files covering architecture evolution, context engineering, hooks architecture, and progressive disclosure)
- Improved cross-platform path handling in context-hook (src/hooks/context-hook.ts:14)

**Technical Details**:
- New files:
  - src/hooks/user-message-hook.ts (stderr-based user-facing context display)
  - plugin/scripts/user-message-hook.js (built hook executable)
  - docs/architecture-evolution.mdx (801 lines)
  - docs/context-engineering.mdx (222 lines)
  - docs/hooks-architecture.mdx (784 lines)
  - docs/progressive-disclosure.mdx (655 lines)
- Modified:
  - plugin/hooks/hooks.json:5 (added user-message-hook configuration)
  - src/hooks/context-hook.ts:14 (improved path handling)
  - scripts/build-hooks.js:3 (build support for new hook)
- Design rationale: Error messages don't get added to context, so we intentionally duplicate context output via stderr for user visibility. This is a temporary workaround until Claude Code potentially adds ability to share messages with both user and context simultaneously.

#### v4.3.1 (2025-10-26)
**Breaking Changes**: None (patch version)

**Fixes**:
- Fixed SessionStart hook context injection by silencing npm install output (plugin/hooks/hooks.json:25)
- Changed npm loglevel from `--loglevel=error` to `--loglevel=silent` to ensure clean JSON output
- Consolidated hooks architecture by removing bin/hooks wrapper layer (src/hooks/*-hook.ts)
- Fixed double shebang issues in hook executables (esbuild now adds shebang during build)

**Technical Details**:
- Modified: plugin/hooks/hooks.json (npm install verbosity)
- Removed: src/bin/hooks/* (wrapper layer no longer needed)
- Consolidated: Hook logic moved directly into src/hooks/*-hook.ts files
- Root cause: npm install stderr/stdout was polluting hook JSON output, preventing context injection

#### v4.3.0 (2025-10-25)
- Progressive Disclosure Context: Enhanced context hook with observation timeline and token cost visibility
- Session observations now display in table format showing ID, timestamp, type indicators, title, and token counts
- Added progressive disclosure usage instructions to guide Claude on when to fetch full observation details vs. reading code
- Added Agent Skills documentation and version bump management skill
- Cross-platform path improvements: Removed hardcoded paths for project and Claude Code executable (fixes #23)

#### v4.2.11 (2025-10-25)
- Fixed cross-platform Claude executable path detection using `which`/`where` commands
- Full Windows, macOS, and Linux compatibility

#### v4.2.8 (2025-10-25)
- Fixed NOT NULL constraint violation for claude_session_id

#### v4.2.3 (2025-10-23)
- Fixed FTS5 injection vulnerability
- Fixed Windows PowerShell compatibility

#### v4.0.0 (2025-10-18)
- MCP Search Server with FTS5 full-text search
- Plugin data directory integration
- HTTP REST API architecture with PM2

## Key Design Decisions

### Graceful Cleanup (v4.1.0)
Changed from aggressive session deletion (HTTP DELETE to workers) to graceful completion (marking sessions complete and allowing workers to finish). This prevents interruption of important operations like summary generation.

### FTS5 for Search Performance
Implements SQLite FTS5 (Full-Text Search) virtual tables with automatic synchronization triggers, enabling fast full-text search across thousands of observations without performance degradation.

### Multi-Prompt Session Support
Tracks `prompt_counter` and `prompt_number` across sessions and observations, enabling context preservation across conversation restarts within the same coding session.

## Troubleshooting

### Worker Service Issues

#### Worker Service Not Found/Not Running

**Symptoms**:
```
Error: There's a problem with the worker. If you just updated, type `pm2 restart claude-mem-worker` in your terminal to continue
```

When checking PM2 status:
```bash
pm2 restart claude-mem-worker
# [PM2][ERROR] Process or Namespace claude-mem-worker not found
```

**Root Causes**:
1. **Fresh Installation**: The worker service hasn't been started initially after plugin installation
2. **PM2 Not Initialized**: PM2 process manager hasn't loaded the worker configuration
3. **Worker Crashed**: The worker process crashed and PM2 didn't auto-restart it
4. **Port Conflict**: Another process is using port 37777 (or the configured CLAUDE_MEM_WORKER_PORT)

**Solutions**:

1. **Manual Worker Start** (most common fix):
   ```bash
   # Navigate to the plugin directory
   cd ~/.claude/plugins/marketplaces/thedotmack/

   # Start the worker using PM2
   pm2 start ecosystem.config.cjs
   ```

2. **Verify Worker Status**:
   ```bash
   pm2 list
   # Should show 'claude-mem-worker' with status 'online'
   ```

3. **Check Worker Logs** (if worker keeps failing):
   ```bash
   cd ~/.claude/plugins/marketplaces/thedotmack/
   npm run worker:logs
   ```

4. **Check Port Availability** (if worker won't start):
   ```bash
   # Check if port 37777 is in use
   lsof -i :37777  # macOS/Linux
   netstat -ano | findstr :37777  # Windows
   ```

5. **Complete Worker Reset**:
   ```bash
   cd ~/.claude/plugins/marketplaces/thedotmack/
   pm2 delete claude-mem-worker  # Remove any existing worker
   pm2 start ecosystem.config.cjs  # Start fresh
   ```

**Prevention**:
- The SessionStart hook should auto-start the worker, but if you experience this issue repeatedly, consider adding the worker to PM2's startup script:
  ```bash
  pm2 startup
  pm2 save
  ```

#### Other Worker Commands
- Check PM2 status: `pm2 list`
- View logs: `npm run worker:logs`
- Restart worker: `npm run worker:restart`

### Database Issues
- Database location: `~/.claude-mem/claude-mem.db`
- Check schema: `sqlite3 <db-path> ".schema"`
- FTS5 tables are automatically synchronized via triggers

### Hook Issues
- Hooks output to Claude Code's hook execution log
- Check `plugin/scripts/` for built executables

### Model Configuration Issues
- Use `./claude-mem-settings.sh` to manage model settings
- Settings stored in `~/.claude/settings.json`
- Default fallback: `claude-sonnet-4-5`

## Citations & References

This project uses the `claude-mem://` URI scheme for citations:
- `claude-mem://observation/{id}` - References specific observations
- `claude-mem://session/{id}` - References specific sessions

All MCP search results include citations, enabling Claude to reference specific historical context.

## License

AGPL-3.0

## Repository

https://github.com/thedotmack/claude-mem
