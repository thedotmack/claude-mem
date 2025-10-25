# Claude-Mem: Persistent Memory for Claude Code

## Overview

Claude-mem is a persistent memory compression system that preserves context across Claude Code sessions. It automatically captures tool usage observations, processes them through the Claude Agent SDK, and makes summaries available to future sessions.

**Current Version**: 4.2.8
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

## Data Flow

### Memory Pipeline
```
Tool Execution → Hook Capture → Worker Processing → AI Compression → Database Storage → Future Context Injection
```

### Search Pipeline
```
Search Query → MCP Server → SessionSearch → FTS5 Query → Results with Citations
```

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
```bash
npm run build && git commit -a -m "Build and update" && git push && cd ~/.claude/plugins/marketplaces/thedotmack/ && git pull && pm2 flush claude-mem-worker && pm2 restart claude-mem-worker && pm2 logs claude-mem-worker --nostream
```

1) Compiles TypeScript and outputs hook executables to `plugin/scripts/`
2) Does all the things needed to update and test since plugin-based installs are out of the .claude/ folder

**Build Outputs**:
- Hook executables: `*-hook.js` (ESM format)
- Worker service: `worker-service.cjs` (CJS format)
- Search server: `search-server.js` (ESM format)

## Version History

### v4.2.8 (Current)
**Breaking Changes**: None (patch version)

**Critical Bugfix**:
- Fixed NOT NULL constraint violation that prevented observations and summaries from being stored
  - Root cause: `SessionStore.getSessionById()` was not selecting `claude_session_id` from database
  - Worker service received `undefined` for `claude_session_id` when initializing sessions
  - Result: Database inserts failed with "NOT NULL constraint failed: sdk_sessions.claude_session_id"
  - Fix: Added `claude_session_id` to SELECT query and return type in `getSessionById()`
  - Impact: Session ID from hooks now flows correctly: hook → database → worker → SDK agent
  - Affects: All observation and summary storage operations

**Technical Details**:
- Updated `src/services/sqlite/SessionStore.ts:711` to include `claude_session_id` in SELECT
- Updated return type signature to include `claude_session_id: string` field
- Worker service now correctly receives and uses `claude_session_id` from database
- System maintains consistency throughout entire session lifecycle

**Files Changed**:
- `src/services/sqlite/SessionStore.ts` (getSessionById method)

### v4.2.7
**Breaking Changes**: None (patch version)

**Improvements**:
- Enhanced data quality with consistent null handling
  - `extractField()` now returns null for empty/whitespace-only strings
  - Ensures database stores clean null values instead of empty strings
  - Improves query efficiency and data consistency

**Testing**:
- Added comprehensive regression test suite (49 tests)
  - Tests v4.2.5 summary validation fixes (partial summaries preserved)
  - Tests v4.2.6 observation validation fixes (partial observations preserved)
  - Tests edge cases: missing fields, empty fields, whitespace, invalid types
  - Tests data integrity: concept filtering, type validation, field preservation
- New test script: `npm run test:parser`
- All 49 tests passing with 100% coverage of critical parser edge cases

**Code Quality**:
- Removed unused `extractFileArray()` function (replaced by `extractArrayElements()`)
- Improved function documentation with clearer descriptions
- TypeScript diagnostics clean

**Technical Details**:
- Updated `src/sdk/parser.ts:163-169` extractField function
- Created `src/sdk/parser.test.ts` with comprehensive regression tests
- Added `test:parser` script to package.json
- All changes backward compatible with existing database schema

### v4.2.6
**Breaking Changes**: None (patch version)

**Critical Bugfix**:
- Fixed overly defensive observation validation that was blocking observations from being saved
  - Removed validation requiring title, subtitle, and narrative fields
  - Parser now NEVER skips observations - always saves them
  - Invalid or missing type defaults to "change" (generic catch-all type)
  - Prevents critical data loss - partial observations are better than no observations

**Impact**:
- Before: Missing title, subtitle, OR narrative caused entire observation to be discarded
- After: ALL observations preserved regardless of field completeness
- Even partial observations contain valuable data: concepts, files_read, files_modified, facts
- LLMs make mistakes - system must be resilient and save everything
- Consistent with v4.2.5 summary fix - partial data is always better than no data

**Technical Details**:
- Updated `src/sdk/parser.ts:52-67` to never skip observations
- Uses "change" as fallback type for invalid/missing types (no schema change needed)
- Updated ParsedObservation interface to allow null for title, subtitle, narrative
- Database schema already supports nullable fields
- Parser now matches database schema constraints exactly
- Affects `parseObservations()` function used by worker service

### v4.2.5
**Breaking Changes**: None (patch version)

**Critical Bugfix**:
- Fixed overly defensive summary validation that was blocking summaries from being saved
  - Removed validation check that returned null when any required fields were missing
  - Summaries are now always saved when `<summary>` tags are present, even if fields are incomplete
  - Prevents critical data loss - partial summaries are better than no summaries
  - Database schema already supports null/empty values for all fields

**Impact**:
- Before: Missing a single field (e.g., `next_steps`) would cause entire summary to be discarded
- After: All summaries are preserved, maintaining session context even when incomplete
- This fix ensures continuity of the memory compression system

**Technical Details**:
- Updated `src/sdk/parser.ts:137-147` to remove blocking validation
- Parser now returns ParsedSummary with whatever fields are available
- Affects `parseSummary()` function used by worker service

### v4.2.4
**Breaking Changes**: None (patch version)

**Improvements**:
- Enhanced summary prompt clarity and reliability
  - Removed optional skip_summary functionality (summaries now always generated)
  - Clarified that summaries are mid-session checkpoints, not session endings
  - Improved request field instructions to better form descriptive titles
  - Changed wording from "discovered" to "learned" for consistency

**Technical Details**:
- Updated `src/sdk/prompts.ts` to remove `WHEN NOT TO SUMMARIZE` section
- Added footer text clarifying summaries track progress within ongoing sessions
- Changed request field prompt from "Use their original sentiment" to "Form a title that reflects the actual request"
- Affects both observation and summary prompt generation

### v4.2.3
**Breaking Changes**: None (patch version)

**Security**:
- Fixed FTS5 injection vulnerability in search functions
  - Implemented proper double-quote escaping for FTS5 queries
  - Added comprehensive test suite with 332 injection attack tests
  - Affects: `search_observations`, `search_sessions`, `search_user_prompts` MCP tools

**Fixes**:
- Fixed ESM/CJS compatibility for getDirname function in src/shared/paths.ts
  - Detects context using `typeof __dirname !== 'undefined'`
  - Falls back to `fileURLToPath(import.meta.url)` for ESM modules
  - Resolves path resolution issues across hook (ESM) and worker (CJS) contexts
- Fixed Windows PowerShell compatibility issue with SessionStart hook
  - Replaced bash-specific test command `[` with cross-platform npm install command
  - Hook now runs `npm install` with quiet flags (fast and idempotent when dependencies exist)

**Technical Details**:
- SessionSearch.ts now escapes double quotes in FTS5 queries: `query.replace(/"/g, '""')`
- Updated `plugin/hooks/hooks.json` SessionStart command to use standard shell syntax
- Changed from: `[ ! -d ... ] && cd ... && npm install && node ... || node ...`
- Changed to: `cd ... && npm install --prefer-offline --no-audit --no-fund --loglevel=error && node ...`
- Dependencies are installed in marketplace folder (parent of CLAUDE_PLUGIN_ROOT) where root package.json exists
- getDirname function now properly handles both CommonJS (__dirname) and ES modules (import.meta.url)

### v4.2.0
**Breaking Changes**: None (minor version)

**Features**:
- User prompt storage with FTS5 full-text search
- New `user_prompts` table stores raw user input for every prompt
- New `search_user_prompts` MCP tool enables searching actual user requests
- Automatic FTS5 indexing of all user prompts for fast retrieval

**Benefits**:
- Full context reconstruction from user intent → Claude actions → outcomes
- Pattern detection for repeated requests (identify when Claude isn't listening)
- Improved debugging by tracing from original user words to final implementation
- Historical search: "How many times did user ask for X feature?"

**Implementation**:
- Migration 10: Creates user_prompts table with FTS5 virtual table and sync triggers
- UserPromptSubmit hook now saves prompts using claude_session_id (available immediately)
- Citations use `claude-mem://user-prompt/{id}` URI scheme

### v4.1.0
**Breaking Changes**: None (minor version)

**Features**:
- Graceful session cleanup (marks complete instead of DELETE)
- Restored MCP search server from backup
- Updated dependencies (claude-agent-sdk 0.1.23, MCP SDK 1.20.1)

**Fixes**:
- `/clear` command now skips cleanup to prevent session interruption
- Session workers can finish pending operations naturally

### v4.0.0
**Breaking Changes**:
- Data directory relocated to `${CLAUDE_PLUGIN_ROOT}/data/`
- Fresh start required (no migration from v3.x)
- Worker auto-starts in SessionStart hook

**Features**:
- MCP Search Server with 8 specialized search tools
- FTS5 full-text search across observations, sessions, and user prompts
- Citation support with `claude-mem://` URIs
- HTTP REST API architecture with PM2 management
- Plugin data directory integration

**Changes**:
- Improved session continuity
- Enhanced error handling
- Better process cleanup

### Earlier Versions (v3.x)
- v3.9.17: MCP integration, hookSpecificOutput JSON format
- v3.7.1: SQLite storage backend
- Earlier: Mintlify documentation, statusline support

## Key Design Decisions

### Graceful Cleanup (v4.1.0)
Changed from aggressive session deletion (HTTP DELETE to workers) to graceful completion (marking sessions complete and allowing workers to finish). This prevents interruption of important operations like summary generation.

### FTS5 for Search Performance
Implements SQLite FTS5 (Full-Text Search) virtual tables with automatic synchronization triggers, enabling fast full-text search across thousands of observations without performance degradation.

### Multi-Prompt Session Support
Tracks `prompt_counter` and `prompt_number` across sessions and observations, enabling context preservation across conversation restarts within the same coding session.

## Troubleshooting

### Worker Service Issues
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
