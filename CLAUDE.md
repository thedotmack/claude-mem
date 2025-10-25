# Claude-Mem: Persistent Memory for Claude Code

## Overview

Claude-mem is a persistent memory compression system that preserves context across Claude Code sessions. It automatically captures tool usage observations, processes them through the Claude Agent SDK, and makes summaries available to future sessions.

**Current Version**: 4.2.11
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

For detailed version history and changelog, see [CHANGELOG.md](CHANGELOG.md).

**Current Version**: 4.2.11

### Recent Highlights

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
