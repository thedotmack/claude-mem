# Claude-Mem: Persistent Memory for Claude Code

## Overview

Claude-mem is a persistent memory compression system that preserves context across Claude Code sessions. It automatically captures tool usage observations, processes them through the Claude Agent SDK, and makes summaries available to future sessions.

**Current Version**: 5.0.0
**License**: AGPL-3.0
**Author**: Alex Newman (@thedotmack)

## What It Does

Claude-mem operates as a Claude Code plugin that:
- Captures every tool execution during your coding sessions
- Processes observations using AI-powered compression
- Generates session summaries when sessions end
- Injects relevant context into future sessions
- Provides hybrid semantic + keyword search across your entire project history (v5.0.0+)
- Falls back to keyword-only search if Python unavailable

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

### Vector Database Layer (Optional)

**Technology**: ChromaDB via MCP (Model Context Protocol)
**Location**: `~/.claude-mem/vector_db/`
**Requirement**: Python 3.8+ and Chroma MCP server

**Purpose**: Semantic similarity search to complement SQLite keyword search

**ChromaSync Service** (`src/services/sync/ChromaSync.ts`):
- Automatically syncs observations, summaries, and user prompts to Chroma
- Splits large text into multiple vectors for granularity
- Maintains metadata for filtering (project, type, concepts, files)
- Document ID format: `obs_{id}_narrative`, `summary_{id}_request`, `prompt_{id}`
- Syncs 8,000+ vector documents from ~1,400 observations

**Graceful Fallback**: If Python/Chroma unavailable, system falls back to FTS5 keyword search

### MCP Search Server

**Location**: `src/servers/search-server.ts`
**Configuration**: `plugin/.mcp.json`

Exposes 9 specialized search tools to Claude:

1. **search_observations** - Hybrid semantic + keyword search across observations
2. **search_sessions** - Hybrid semantic + keyword search across session summaries
3. **search_user_prompts** - Hybrid semantic + keyword search across raw user prompts
4. **find_by_concept** - Find observations tagged with specific concepts
5. **find_by_file** - Find observations referencing specific file paths
6. **find_by_type** - Find observations by type (decision/bugfix/feature/etc.)
7. **get_recent_context** - Get recent session context for a project (temporal only)
8. **get_context_timeline** - Get timeline context around an anchor point (temporal only)
9. **get_timeline_by_query** - Natural language timeline search with auto/interactive modes

**Hybrid Search Pipeline** (when Chroma available):
```
Query → Chroma Semantic Search (top 100) → 90-day Filter → SQLite Hydration (temporal) → Results
```

**Fallback Pipeline** (when Chroma unavailable):
```
Query → SessionSearch Service → FTS5 Database → Results
```

**Citations**: All search results use the `claude-mem://` URI scheme for referencing specific observations and sessions.

## Installation

### Requirements

**Required:**
- Node.js 18+
- Claude Code plugin system

**Optional (for semantic search):**
- Python 3.8+ (for Chroma vector database)
- Chroma MCP server

**Note**: Without Python, the system falls back to SQLite FTS5 keyword search. Semantic search provides better relevance matching for natural language queries.

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

### Hybrid Search Pipeline

**With Chroma (Semantic + Temporal):**
```
Search Query → Chroma Semantic Search (top 100) → 90-day Recency Filter → SQLite Temporal Hydration → Results with Citations
```

**Without Chroma (Keyword Only):**
```
Search Query → SessionSearch → FTS5 Query → Results with Citations
```

**Key Features:**
- Semantic search prioritizes conceptual relevance over exact keyword matches
- 90-day temporal window ensures recent, relevant results
- SQLite hydration provides chronological ordering
- Graceful fallback to FTS5 when Chroma unavailable
- All search modes return results with `claude-mem://` citations

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

**Current Version**: 5.0.0

### Recent Highlights

#### v5.0.0 (2025-11-03)
**BREAKING CHANGES**: Python dependency for optimal performance (semantic search)

**Major Features**:
- **Hybrid Search Architecture**: Combines ChromaDB semantic search with SQLite temporal filtering
  - Chroma vector database for semantic similarity (top 100 matches)
  - 90-day temporal recency window for relevant results
  - Graceful fallback to FTS5 when Chroma unavailable
- **ChromaSync Service**: Automatic vector database synchronization (738 lines)
  - Syncs observations, session summaries, and user prompts to Chroma
  - Splits large text into multiple vectors for better granularity
  - Background sync via worker service
- **get_timeline_by_query Tool**: Natural language timeline search with dual modes
  - Auto mode: Automatically uses top search result as timeline anchor
  - Interactive mode: Shows top N results for manual anchor selection
- **Enhanced MCP Tools**: All 8 existing search tools now support hybrid semantic + keyword search
  - search_observations, search_sessions, search_user_prompts now use hybrid algorithm
  - find_by_concept, find_by_file, find_by_type enhanced with semantic capabilities

**Technical Details**:
- New files: src/services/sync/ChromaSync.ts (738 lines)
- Modified: src/servers/search-server.ts (+995 lines for hybrid search)
- Modified: src/services/worker-service.ts (+136 lines for ChromaSync integration)
- Modified: src/services/sqlite/SessionStore.ts (+276 lines for enhanced timeline queries)
- Validation: 1,390 observations synced to 8,279 vector documents
- Performance: Semantic search with 90-day window in <200ms

**Migration Notes**:
- No data migration required - existing SQLite data continues to work
- Optional: Install Python 3.8+ and Chroma MCP server for semantic search
- Without Python: System falls back to FTS5 keyword search (no functionality loss)

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

### Hybrid Search Architecture (v5.0.0)
Combines semantic search (ChromaDB vectors) with temporal ordering (SQLite) for relevance-first, recency-aware results:

**Design Rationale:**
- **Semantic First**: Chroma finds conceptually relevant matches regardless of keyword overlap
- **Temporal Constraint**: 90-day window filters to recent, still-relevant observations
- **Chronological Order**: SQLite provides temporal ordering for timeline coherence
- **Graceful Fallback**: System continues working without Python via FTS5 keyword search

**Architecture Trade-offs:**
- **Top 100 semantic limit**: Balances relevance with performance (<200ms queries)
- **90-day window**: Captures 2-3 months of active work without overwhelming results
- **Vector granularity**: Splits large text into multiple documents for better semantic matching
- **Dual storage**: Accepts storage overhead (vectors + SQLite) for hybrid search benefits

**ChromaSync Integration:**
- Automatic background sync via worker service
- Splits observations into narrative + facts vectors
- Splits summaries into request + learned vectors
- Indexes user prompts as single vectors
- Example: 1,390 observations → 8,279 vector documents

**Search Strategy:**
1. Text queries (e.g., "authentication bugs") → Semantic search via Chroma
2. Metadata queries (e.g., concept="gotcha") → Direct SQLite lookup
3. Hybrid queries combine both strategies

### Graceful Cleanup (v4.1.0)
Changed from aggressive session deletion (HTTP DELETE to workers) to graceful completion (marking sessions complete and allowing workers to finish). This prevents interruption of important operations like summary generation.

### FTS5 for Search Performance (v4.0.0)
Implements SQLite FTS5 (Full-Text Search) virtual tables with automatic synchronization triggers, enabling fast full-text search across thousands of observations without performance degradation. Continues to serve as fallback when Chroma unavailable.

### Multi-Prompt Session Support (v4.0.0)
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
