# Architecture Overview

## System Components

Claude-Mem operates as a Claude Code plugin with four core components:

1. **Plugin Hooks** - Capture lifecycle events
2. **Worker Service** - Process observations via Claude Agent SDK
3. **Database Layer** - Store sessions and observations (SQLite + FTS5)
4. **MCP Search Server** - Query historical context

## Technology Stack

| Layer                  | Technology                                |
|------------------------|-------------------------------------------|
| **Language**           | TypeScript (ES2022, ESNext modules)       |
| **Runtime**            | Node.js 18+                               |
| **Database**           | SQLite 3 with better-sqlite3 driver       |
| **HTTP Server**        | Express.js 4.18                           |
| **AI SDK**             | @anthropic-ai/claude-agent-sdk            |
| **Build Tool**         | esbuild (bundles TypeScript)              |
| **Process Manager**    | PM2                                       |
| **Testing**            | Node.js built-in test runner              |

## Data Flow

### Memory Pipeline
```
Hook (stdin) → Database → Worker Service → SDK Processor → Database → Next Session Hook
```

1. **Input**: Claude Code sends tool execution data via stdin to hooks
2. **Storage**: Hooks write observations to SQLite database
3. **Processing**: Worker service reads observations, processes via SDK
4. **Output**: Processed summaries written back to database
5. **Retrieval**: Next session's context hook reads summaries from database

### Search Pipeline
```
Claude Request → MCP Server → SessionSearch Service → FTS5 Database → Search Results → Claude
```

1. **Query**: Claude uses MCP search tools (e.g., `search_observations`)
2. **Search**: MCP server calls SessionSearch service with query parameters
3. **FTS5**: Full-text search executes against FTS5 virtual tables
4. **Format**: Results formatted as `search_result` blocks with citations
5. **Return**: Claude receives citable search results for analysis

## Session Lifecycle

```
┌─────────────────────────────────────────────────────────────────┐
│ 1. Session Starts → Context Hook Fires                          │
│    Injects summaries from last 3 sessions into Claude's context │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│ 2. User Types Prompt → UserPromptSubmit Hook Fires              │
│    Creates SDK session in database, notifies worker service     │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│ 3. Claude Uses Tools → PostToolUse Hook Fires (100+ times)      │
│    Sends observations to worker service for processing          │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│ 4. Worker Processes → Claude Agent SDK Analyzes                 │
│    Extracts structured learnings via iterative AI processing    │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│ 5. Claude Stops → Stop Hook Fires                               │
│    Generates final summary with request, status, next steps     │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│ 6. Session Ends → Cleanup Hook Fires                            │
│    Marks session complete, ready for next session context       │
└─────────────────────────────────────────────────────────────────┘
```

## Directory Structure

```
claude-mem/
├── src/
│   ├── bin/hooks/              # Entry point scripts for 5 hooks
│   │   ├── context-hook.ts     # SessionStart
│   │   ├── new-hook.ts         # UserPromptSubmit
│   │   ├── save-hook.ts        # PostToolUse
│   │   ├── summary-hook.ts     # Stop
│   │   └── cleanup-hook.ts     # SessionEnd
│   │
│   ├── hooks/                  # Hook implementation logic
│   │   ├── context.ts
│   │   ├── new.ts
│   │   ├── save.ts
│   │   ├── summary.ts
│   │   └── cleanup.ts
│   │
│   ├── servers/                # MCP servers
│   │   └── search-server.ts    # MCP search tools server
│   │
│   ├── sdk/                    # Claude Agent SDK integration
│   │   ├── prompts.ts          # XML prompt builders
│   │   ├── parser.ts           # XML response parser
│   │   └── worker.ts           # Main SDK agent loop
│   │
│   ├── services/
│   │   ├── worker-service.ts   # Express HTTP service
│   │   └── sqlite/             # Database layer
│   │       ├── SessionStore.ts # CRUD operations
│   │       ├── SessionSearch.ts # FTS5 search service
│   │       ├── migrations.ts
│   │       └── types.ts
│   │
│   ├── shared/                 # Shared utilities
│   │   ├── config.ts
│   │   ├── paths.ts
│   │   └── storage.ts
│   │
│   └── utils/
│       ├── logger.ts
│       ├── platform.ts
│       └── port-allocator.ts
│
├── plugin/                     # Plugin distribution
│   ├── .claude-plugin/
│   │   └── plugin.json
│   ├── .mcp.json               # MCP server configuration
│   ├── hooks/
│   │   └── hooks.json
│   └── scripts/                # Built executables
│       ├── context-hook.js
│       ├── new-hook.js
│       ├── save-hook.js
│       ├── summary-hook.js
│       ├── cleanup-hook.js
│       ├── worker-service.cjs  # Background worker
│       └── search-server.js    # MCP search server
│
├── tests/                      # Test suite
├── docs/                       # Documentation
└── ecosystem.config.cjs        # PM2 configuration
```

## Component Details

### 1. Plugin Hooks
See [hooks.md](hooks.md) for detailed hook documentation.

### 2. Worker Service
See [worker-service.md](worker-service.md) for HTTP API and endpoints.

### 3. Database Layer
See [database.md](database.md) for schema and FTS5 search.

### 4. MCP Search Server
See [mcp-search.md](mcp-search.md) for search tools and examples.
