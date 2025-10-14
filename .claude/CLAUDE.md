# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

claude-mem is a TypeScript-based memory compression and persistence system for Claude Code. It provides automatic context capture across sessions using streaming hooks, ChromaDB for semantic search, and SQLite for metadata storage.

## Development Commands

### Installation and Testing
```bash
# Install dependencies (use bun or npm)
npm install
# or
bun install

# Test installation locally
npm link
claude-mem status

# Run tests
bun test
```

### Building
There is no explicit build script in package.json. The project distributes source TypeScript files directly via the `files` array in package.json, which includes:
- `dist/` (minified production bundle)
- `hook-templates/` (hook JavaScript files)
- `commands/` (slash command definitions)
- `src/` (TypeScript source)

### Running Commands
```bash
# Check installation status
claude-mem status

# View logs
claude-mem logs [--debug|--error] [--tail n]

# Install hooks (interactive)
claude-mem install [--user|--project|--local] [--force]

# Load context for current project
claude-mem load-context [--project name] [--count n]

# Manual memory operations
claude-mem store-memory --id <id> --project <proj> --session <sess> --date <date> --title <title> --subtitle <subtitle> --facts <json>
claude-mem store-overview --project <proj> --session <sess> --content <content>

# Run diagnostics
claude-mem doctor [--json]

# Generate changelog from memories
claude-mem changelog [--preview] [--generate version]
```

## Architecture

### Storage System (Three Layers)

1. **SQLite Database** (`~/.claude-mem/claude-mem.db`)
   - Schema versioning with migrations (src/services/sqlite/migrations.ts)
   - Stores: sessions, memories, overviews, transcript events, diagnostics
   - WAL mode enabled, optimized for performance with `pragma` settings

2. **ChromaDB** (`~/.claude-mem/chroma/`)
   - Vector database for semantic search
   - Accessed via MCP tools (15+ operations)
   - Stores compressed memories with embeddings

3. **File Archives** (`~/.claude-mem/archives/`)
   - Organized by project name
   - Contains compressed transcript backups

### Hook System

claude-mem integrates with Claude Code via streaming hooks in `hook-templates/`:

- **user-prompt-submit.js** - Captures user prompts, starts Agent SDK session for async compression
- **post-tool-use.js** - Resumes Agent SDK session to process tool responses in real-time
- **stop.js** - Generates session overview, cleans up SDK transcript, finalizes session
- **session-start.js** - Loads relevant context automatically at session start

Hooks are installed to `~/.claude-mem/hooks/` and configured with:
- 180s timeout (configurable via `--timeout`)
- JSON stdin/stdout communication
- Detached processes for non-blocking operation
- Dependencies: `@anthropic-ai/claude-agent-sdk`, `better-sqlite3` (installed via package.json in hooks dir)

### Core Services

**PathDiscovery** (src/services/path-discovery.ts)
- Singleton service for resolving all file system paths
- Handles npm global installs, local installs, and development environments
- Key methods:
  - `getDataDirectory()` - Base directory (`~/.claude-mem/`)
  - `getPackageRoot()` - Finds installed package location
  - `getClaudeConfigDirectory()` - Claude Code config (`~/.claude/`)
  - `getCurrentProjectName()` - Extracts project name from git root

**DatabaseManager** (src/services/sqlite/Database.ts)
- Singleton with migration support
- Optimized SQLite settings: WAL mode, NORMAL synchronous, foreign keys ON
- Transaction support via `withTransaction<T>(fn)`

**Store Classes** (src/services/sqlite/)
- `MemoryStore` - Memory records with semantic metadata
- `SessionStore` - Session tracking and metadata
- `StreamingSessionStore` - Real-time SDK session tracking
- `OverviewStore` - Session overviews and summaries
- `TranscriptEventStore` - Individual conversation turns
- `DiagnosticsStore` - Environment diagnostics

### CLI Architecture

**CLI Entry Point** (src/bin/cli.ts)
- Commander-based CLI with dynamic command loading
- Exports database classes for hook consumption: `DatabaseManager`, `StreamingSessionStore`, `migrations`, `initializeDatabase`, `getDatabase`
- Dynamically loads ChromaDB MCP tools from `.mcp.json`

**Command Pattern** (src/commands/)
Each command is a separate module with a single exported function that handles:
- Argument parsing
- Database initialization
- Core logic execution
- User output formatting

### Memory Flow

1. **User Prompt** → `user-prompt-submit.js`
   - Creates session record in SQLite
   - Spawns Agent SDK session (async)
   - Stores SDK session ID for later hooks

2. **Tool Response** → `post-tool-use.js`
   - Resumes SDK session
   - Processes tool response through Agent SDK
   - Stores transcript events

3. **Session End** → `stop.js`
   - Generates session overview via Agent SDK
   - Stores overview in SQLite and ChromaDB
   - Deletes SDK transcript file
   - Clears activity flag

4. **Next Session** → `session-start.js`
   - Loads recent memories via ChromaDB query
   - Injects context into new session

### MCP Integration

**MCP Server** (src/mcp-server.ts, not shown but referenced in README)
- Exposes 15+ ChromaDB operations as MCP tools
- Configured in `~/.claude.json` (user) or `.mcp.json` (project)
- Tools include: query, add, update, delete documents, collection management

**ChromaDB MCP Commands** (src/commands/chroma-mcp.ts)
- Dynamically loaded from `.mcp.json`
- Available as CLI commands (e.g., `claude-mem chroma-query-documents`)
- Schema-based option generation from tool definitions

## Configuration

### Environment Variables
- `CLAUDE_MEM_DATA_DIR` - Override data directory (default: `~/.claude-mem/`)
- `CLAUDE_CONFIG_DIR` - Override Claude config directory (default: `~/.claude/`)
- `CLAUDE_MEM_DEBUG` - Enable debug logging to `~/.claude-mem/logs/hooks.log`

### Installation Scopes
- **User** - Install to `~/.claude/settings.json` (default)
- **Project** - Install to `./claude_code_settings.json`
- **Local** - Install to custom directory via `--path`

### Hook Timeout
Default 180 seconds, configurable during install:
```bash
claude-mem install --timeout 300000  # 5 minutes
```

## Project Structure

```
src/
├── bin/cli.ts              # CLI entry point, exports for hooks
├── commands/               # Command implementations (install, status, load-context, etc.)
├── constants.ts            # Project-wide constants
├── lib/                    # Utility libraries (time-utils)
├── prompts/                # Hook prompt rendering system
│   ├── hook-prompt-renderer.ts      # Centralized system prompt builder
│   ├── hook-prompts.config.ts       # Hook configuration (model, tools, limits)
│   └── templates/context/           # Context loading templates
├── services/
│   ├── path-discovery.ts   # Path resolution singleton
│   └── sqlite/             # SQLite data access layer
│       ├── Database.ts     # Database manager with migrations
│       ├── migrations.ts   # Schema versioning
│       ├── types.ts        # Shared TypeScript types
│       └── *Store.ts       # Data access objects
├── shared/                 # Shared utilities
│   ├── config.ts          # Package metadata (name, version)
│   ├── logger.ts          # Logging utilities
│   ├── paths.ts           # Path resolution helpers
│   ├── settings.ts        # Settings management
│   └── storage.ts         # Storage abstractions
└── utils/
    └── platform.ts         # Platform detection

hook-templates/             # Hook source files (deployed to ~/.claude-mem/hooks/)
├── user-prompt-submit.js
├── post-tool-use.js
├── stop.js
├── session-start.js
└── shared/                # Hook shared utilities
    ├── hook-prompt-renderer.js     # Prompt builder (matches src/prompts/)
    ├── hook-helpers.js             # Database helpers for hooks
    └── path-resolver.js            # Path resolution for hooks

commands/                  # Slash command definitions for Claude Code
├── claude-mem.md         # /claude-mem handler
├── save.md              # /save shortcut
└── remember.md          # /remember shortcut

dist/                     # Minified production bundle
test/                    # Tests (structure not examined)
```

## Key Implementation Details

### Database Schema Migration Pattern
Migrations are registered in `src/services/sqlite/migrations.ts` and applied in version order. Each migration has:
- `version: number` - Sequential version number
- `up: (db) => void` - Forward migration
- `down?: (db) => void` - Optional rollback

Example:
```typescript
{
  version: 1,
  up: (db) => {
    db.exec(`CREATE TABLE foo (...)`);
  }
}
```

### Hook Communication Protocol
Hooks receive JSON on stdin and output JSON on stdout:

**Input:**
```json
{
  "prompt": "user message",
  "cwd": "/path/to/project",
  "session_id": "abc123",
  "timestamp": "2025-10-14T12:00:00.000Z"
}
```

**Output:**
```json
{
  "continue": true,
  "suppressOutput": true
}
```

### Agent SDK Integration
Hooks use `@anthropic-ai/claude-agent-sdk` for async compression:
```javascript
import { query } from '@anthropic-ai/claude-agent-sdk';

const response = query({
  prompt: systemPrompt,
  options: {
    model: 'claude-3-7-sonnet-20250219',
    allowedTools: ['claude-mem:store-memory', 'claude-mem:store-overview'],
    maxTokens: 4096,
    cwd: projectDir
  }
});

for await (const message of response) {
  if (message.type === 'system' && message.subtype === 'init') {
    sdkSessionId = message.session_id;
  }
}
```

### Project Name Resolution
Project names are determined by:
1. Git repository root basename (via `git rev-parse --show-toplevel`)
2. Fallback to current working directory basename
3. Used for memory isolation and archive organization

### Smart Trash System
Files deleted via `claude-mem trash` are moved to `~/.claude-mem/trash/` with metadata for restoration. Supports:
- Recursive directory deletion (`-r`, `-R`)
- Force mode to suppress errors (`-f`)
- Interactive restoration via `claude-mem restore`
- Permanent deletion via `claude-mem trash empty`

## Common Development Tasks

### Adding a New Command
1. Create `src/commands/my-command.ts` with exported function
2. Import and register in `src/bin/cli.ts`
3. Add CLI option parsing and action handler
4. Implement logic using store classes

### Adding a Database Migration
1. Add migration object to `src/services/sqlite/migrations.ts`
2. Increment version number sequentially
3. Register migration in `DatabaseManager.getInstance().registerMigration()`
4. Test with fresh database and existing database

### Adding a New Hook
1. Create `hook-templates/my-hook.js`
2. Add hook configuration to installer in `src/commands/install.ts`
3. Update hook templates directory validation in `path-discovery.ts`
4. Test hook integration with Claude Code settings

### Debugging Hooks
Enable debug mode:
```bash
export CLAUDE_MEM_DEBUG=true
claude-mem logs --tail 100 --follow
```

Hooks log to `~/.claude-mem/logs/hooks.log` with timestamps and structured data.

## Notable Implementation Patterns

### "Make It Work First" Philosophy
As stated in the README: Direct execution over defensive validation, natural failures instead of artificial guards. The codebase favors:
- Simple error handling (try-catch with logging)
- Minimal input validation (let failures happen naturally)
- Direct database access (no heavy ORM)

### Singleton Pattern
`DatabaseManager` and `PathDiscovery` use singleton pattern for:
- Single database connection per process
- Cached path resolution
- Consistent configuration across modules

### Transaction-Based Bulk Operations
Bulk inserts use SQLite transactions for atomic operations:
```typescript
const transaction = db.transaction((items) => {
  for (const item of items) {
    // Insert operations
  }
});
transaction(items);
```

### Detached Processes for Non-Blocking Operations
Hooks spawn detached processes for long-running tasks:
```javascript
const child = spawn('claude-mem', args, {
  stdio: 'ignore',
  detached: true
});
child.unref();
```

## Dependencies

### Runtime Dependencies
- `@anthropic-ai/claude-agent-sdk` - Agent SDK for async compression
- `better-sqlite3` - Fast SQLite bindings (requires native compilation)
- `commander` - CLI argument parsing
- `@clack/prompts` - Interactive CLI prompts
- `chalk`, `boxen`, `gradient-string` - Terminal styling
- `glob` - File pattern matching
- `handlebars` - Template rendering

### Development Dependencies
- `bun` - Preferred runtime for development (optional)
- TypeScript with ES2022 target, Node16 module resolution

## Troubleshooting

### Hook Errors: "Cannot find package '@anthropic-ai/claude-agent-sdk'"

If hooks fail with module not found errors:

1. **Check hook dependencies are installed:**
   ```bash
   cd ~/.claude-mem/hooks
   cat package.json  # Should list both @anthropic-ai/claude-agent-sdk and better-sqlite3
   npm install
   ```

2. **Reinstall claude-mem:**
   ```bash
   claude-mem install --force
   ```

3. **Verify Node version:**
   ```bash
   node --version  # Should be >= 18.0.0
   ```

The hooks directory requires its own `node_modules` because hooks run as standalone scripts outside the main package context.

### Hook Timeout Errors

If hooks timeout, increase the timeout:
```bash
claude-mem install --timeout 300000  # 5 minutes
```

### Debug Hook Execution

Enable debug logging:
```bash
export CLAUDE_MEM_DEBUG=true
claude-mem logs --tail 100 --follow
```

## Windows Support

See `README_WINDOWS.md` for Windows-specific installation notes. Windows support is currently limited due to:
- POSIX-specific path operations
- Shell script dependencies
- Native module compilation requirements
