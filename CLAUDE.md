# Claude-Mem: AI Development Instructions

Claude-mem is a Claude Code plugin providing persistent memory across sessions. It captures tool usage, compresses observations using the Claude Agent SDK, and injects relevant context into future sessions.

**Version**: 8.5.10
**License**: AGPL-3.0
**Repository**: https://github.com/thedotmack/claude-mem

## Quick Reference

```bash
npm run build-and-sync        # Build, sync to marketplace, restart worker
npm run worker:restart        # Restart worker daemon
npm test                      # Run all tests
npm run worker:logs           # View recent logs
```

## Architecture Overview

### 5 Lifecycle Hooks
SessionStart → UserPromptSubmit → PostToolUse → Stop → SessionEnd

**Hook Flow**:
1. **SessionStart** - Injects memory context from previous sessions
2. **UserPromptSubmit** - Initializes session, starts SDK agent
3. **PostToolUse** - Saves tool observations asynchronously
4. **Stop** - Generates session summary via AI
5. **SessionEnd** - (Reserved for future use)

**Hook Implementation**: All hooks are thin HTTP clients that delegate to the worker service. No business logic in hooks - they simply call worker API endpoints.

### Core Components

**Hooks** (`src/hooks/*.ts`) → ESM executables at `plugin/scripts/*-hook.js`
- Pure HTTP clients using `fetch()` to call worker API
- No native dependencies, can run under Node.js or Bun
- Auto-restart worker on each execution
- Privacy tag stripping at edge (`<private>`, `<no-mem>`)

**Worker Service** (`src/services/worker-service.ts`) → `plugin/scripts/worker-service.cjs`
- Express HTTP API on port 37777
- Bun-managed daemon process with PID files
- Orchestrates: database, AI agents, search, infrastructure
- Single 300-line entry point (refactored from 2000-line monolith)

**Database** (`src/services/sqlite/`) → `~/.claude-mem/claude-mem.db`
- SQLite3 with `bun:sqlite` driver
- Tables: sdk_sessions, observations, session_summaries, user_prompts, pending_messages
- 20+ migrations for schema evolution
- Full-text search with FTS5

**Vector Search** (`src/services/sync/ChromaSync.ts`) → `~/.claude-mem/chroma/`
- ChromaDB for semantic search
- Auto-installs Python environment via uv
- Syncs observations to vector embeddings

**Viewer UI** (`src/ui/viewer/`) → `plugin/ui/viewer.html` + `viewer-bundle.js`
- React single-page app (246KB bundle)
- Served at http://localhost:37777
- Real-time updates via SSE
- Dark/light themes with ANSI terminal rendering

**MCP Server** (`src/servers/mcp-server.ts`) → `plugin/scripts/mcp-server.cjs`
- Thin wrapper delegating to worker HTTP API
- Provides `search` and `timeline` tools
- Stdio transport for Claude Desktop

## Directory Structure

```
claude-mem/
├── src/                      # TypeScript source code
│   ├── hooks/               # Hook implementations (HTTP clients)
│   │   ├── context-hook.ts          # SessionStart: inject context
│   │   ├── new-hook.ts              # UserPromptSubmit: init session
│   │   ├── save-hook.ts             # PostToolUse: save observation
│   │   ├── summary-hook.ts          # Stop: generate summary
│   │   └── user-message-hook.ts     # SessionStart: track user message
│   │
│   ├── services/            # Core business logic
│   │   ├── worker-service.ts        # Main orchestrator (300 lines)
│   │   │
│   │   ├── worker/                  # Worker business logic layer
│   │   │   ├── DatabaseManager.ts   # SQLite query orchestration
│   │   │   ├── SessionManager.ts    # Session lifecycle
│   │   │   ├── SearchManager.ts     # Search orchestration
│   │   │   ├── FormattingService.ts # Output formatting
│   │   │   ├── TimelineService.ts   # Timeline queries
│   │   │   ├── SettingsManager.ts   # Settings CRUD
│   │   │   ├── BranchManager.ts     # Git branch tracking
│   │   │   │
│   │   │   ├── agents/              # AI agent helpers
│   │   │   │   ├── ResponseProcessor.ts
│   │   │   │   ├── SessionCleanupHelper.ts
│   │   │   │   ├── ObservationBroadcaster.ts
│   │   │   │   └── FallbackErrorHandler.ts
│   │   │   │
│   │   │   ├── http/routes/         # HTTP API endpoints
│   │   │   │   ├── SessionRoutes.ts     # /api/sessions/*
│   │   │   │   ├── SearchRoutes.ts      # /api/search, /api/timeline
│   │   │   │   ├── DataRoutes.ts        # /api/observations, summaries, prompts
│   │   │   │   ├── SettingsRoutes.ts    # /api/settings
│   │   │   │   ├── ViewerRoutes.ts      # /viewer/*
│   │   │   │   └── LogsRoutes.ts        # /api/logs
│   │   │   │
│   │   │   └── search/              # Search strategies
│   │   │       ├── SearchOrchestrator.ts
│   │   │       ├── strategies/
│   │   │       │   ├── SQLiteSearchStrategy.ts
│   │   │       │   ├── ChromaSearchStrategy.ts
│   │   │       │   └── HybridSearchStrategy.ts
│   │   │       ├── ResultFormatter.ts
│   │   │       └── TimelineBuilder.ts
│   │   │
│   │   ├── sqlite/                  # Database layer
│   │   │   ├── Database.ts          # Connection management
│   │   │   ├── migrations.ts        # Schema migrations (20+)
│   │   │   ├── SessionStore.ts      # Session CRUD (72KB)
│   │   │   ├── SessionSearch.ts     # Full-text search
│   │   │   ├── Observations.ts      # Observation storage
│   │   │   ├── Summaries.ts         # Summary storage
│   │   │   ├── Prompts.ts           # User prompt tracking
│   │   │   ├── Timeline.ts          # Timeline queries
│   │   │   ├── PendingMessageStore.ts  # Queue management
│   │   │   └── transactions.ts      # Transaction helpers
│   │   │
│   │   ├── sync/                    # External integrations
│   │   │   └── ChromaSync.ts        # Vector database sync
│   │   │
│   │   ├── context/                 # Context generation
│   │   │   ├── ContextBuilder.ts
│   │   │   ├── ObservationCompiler.ts
│   │   │   ├── TokenCalculator.ts
│   │   │   ├── ContextConfigLoader.ts
│   │   │   ├── formatters/
│   │   │   │   ├── MarkdownFormatter.ts
│   │   │   │   └── ColorFormatter.ts
│   │   │   └── sections/            # Header, timeline, summary, footer
│   │   │
│   │   ├── infrastructure/          # System management
│   │   │   ├── ProcessManager.ts    # Daemon lifecycle, PID files
│   │   │   ├── HealthMonitor.ts     # Health checks, version validation
│   │   │   └── GracefulShutdown.ts  # Clean shutdown
│   │   │
│   │   └── server/                  # HTTP server
│   │       ├── Server.ts            # Express server
│   │       ├── Middleware.ts        # CORS, logging
│   │       └── ErrorHandler.ts      # Error responses
│   │
│   ├── servers/             # External servers
│   │   └── mcp-server.ts    # MCP server (600 lines, delegates to worker)
│   │
│   ├── sdk/                 # Claude Agent SDK integration
│   │   ├── parser.ts        # Parse SDK agent responses
│   │   └── prompts.ts       # Agent system prompts
│   │
│   ├── ui/viewer/           # React viewer source
│   │   ├── App.tsx          # Main app
│   │   ├── index.tsx        # Entry point
│   │   ├── types.ts         # TypeScript types
│   │   └── components/
│   │       ├── Header.tsx
│   │       ├── Feed.tsx
│   │       ├── ObservationCard.tsx
│   │       ├── SummaryCard.tsx
│   │       ├── PromptCard.tsx
│   │       ├── ContextSettingsModal.tsx  # Settings UI (22KB)
│   │       ├── LogsModal.tsx             # Log viewer (16KB)
│   │       ├── TerminalPreview.tsx       # ANSI terminal rendering
│   │       ├── ThemeToggle.tsx
│   │       ├── GitHubStarsButton.tsx
│   │       ├── ErrorBoundary.tsx
│   │       └── ScrollToTop.tsx
│   │
│   ├── shared/              # Shared utilities
│   │   ├── paths.ts         # Path configuration, ESM/CJS compat
│   │   ├── SettingsDefaultsManager.ts  # Default settings
│   │   ├── hook-constants.ts           # Hook timeouts
│   │   ├── worker-utils.ts             # Worker startup, health checks
│   │   ├── timeline-formatting.ts      # Timeline display
│   │   └── transcript-parser.ts        # JSONL transcript parsing
│   │
│   ├── utils/               # Utility functions
│   │   ├── logger.ts        # Structured logging with levels
│   │   ├── tag-stripping.ts # Privacy tag removal
│   │   ├── project-name.ts  # Git root detection
│   │   ├── cursor-utils.ts  # Cursor IDE integration
│   │   ├── error-messages.ts
│   │   └── bun-path.ts      # Bun executable resolution
│   │
│   ├── types/               # TypeScript type definitions
│   │   ├── database.ts      # SQLite query result types
│   │   └── transcript.ts    # Claude Code transcript types
│   │
│   └── bin/                 # CLI utilities
│
├── plugin/                  # Built plugin (distribution artifact)
│   ├── scripts/             # Built executables
│   │   ├── context-hook.js          # ESM, Bun shebang
│   │   ├── new-hook.js
│   │   ├── save-hook.js
│   │   ├── summary-hook.js
│   │   ├── user-message-hook.js
│   │   ├── worker-service.cjs       # CJS, Bun shebang, 1.8MB bundled
│   │   ├── mcp-server.cjs           # CJS, Node shebang, 340KB
│   │   └── context-generator.cjs    # CJS, 61KB
│   │
│   ├── ui/                  # Built React viewer
│   │   ├── viewer.html
│   │   ├── viewer-bundle.js         # 246KB
│   │   ├── assets/fonts/
│   │   └── icon-thick-*.svg
│   │
│   ├── hooks/
│   │   └── hooks.json       # Hook definitions (5 lifecycle hooks)
│   │
│   ├── modes/               # Recording mode configs (20+ languages)
│   │   └── code--*.json
│   │
│   ├── .claude-plugin/
│   │   └── plugin.json      # Plugin configuration
│   │
│   └── package.json         # Runtime dependencies (empty)
│
├── scripts/                 # Build and utility scripts
│   ├── build-hooks.js       # Main build script (bundles everything)
│   ├── build-viewer.js      # React app bundler
│   ├── sync-marketplace.cjs # Sync to ~/.claude/plugins/
│   ├── smart-install.js     # Auto-install Bun, uv
│   ├── generate-changelog.js      # Auto-generate CHANGELOG
│   ├── discord-release-notify.js  # Discord webhook
│   ├── build-worker-binary.js     # Binary builds (experimental)
│   ├── dump-transcript-readable.ts
│   ├── debug-transcript-structure.ts
│   ├── export-memories.ts
│   ├── import-memories.ts
│   ├── fix-corrupted-timestamps.ts
│   └── cleanup-duplicates.ts
│
├── tests/                   # Bun test suite
│   ├── context/             # Context generation tests
│   ├── sqlite/              # Database tests
│   ├── worker/              # Worker service tests
│   │   ├── agents/
│   │   └── search/
│   ├── server/              # HTTP server tests
│   ├── shared/              # Shared utility tests
│   ├── utils/               # Utility function tests
│   ├── integration/         # E2E tests
│   └── standards/           # Code standards validation
│
├── docs/                    # Documentation
│   ├── public/              # Mintlify docs (MDX) → docs.claude-mem.ai
│   ├── i18n/                # Translated README files (20+ languages)
│   └── context/             # Internal planning/reference docs
│
├── .claude/                 # Local Claude Code configuration
│   └── skills/version-bump/ # Version management skill
│
├── .claude-plugin/
│   └── marketplace.json     # Plugin registration
│
├── .github/workflows/       # CI/CD
│
└── cursor-hooks/            # Cursor IDE integration
```

## Privacy Tags

**Dual-Tag System** for meta-observation control:
- `<private>content</private>` - User-level privacy control (manual, prevents storage)
- `<no-mem>content</no-mem>` - System-level tag (auto-injected observations, prevents recursive storage)

**Implementation**: Tag stripping happens at hook layer (edge processing) before data reaches worker/database. See `src/utils/tag-stripping.ts` for shared utilities.

## Build System

### Build Process

**Main Build** (`scripts/build-hooks.js`):
1. Bundles 5 hooks → `plugin/scripts/*-hook.js` (ESM, Bun shebang)
2. Bundles worker service → `plugin/scripts/worker-service.cjs` (CJS, Bun shebang, 1.8MB)
3. Bundles MCP server → `plugin/scripts/mcp-server.cjs` (CJS, Node shebang, 340KB)
4. Bundles context generator → `plugin/scripts/context-generator.cjs` (CJS, 61KB)
5. Builds React viewer (calls `build-viewer.js`)
6. Generates `plugin/package.json`
7. Makes all scripts executable (chmod 755)

**Viewer Build** (`scripts/build-viewer.js`):
1. Bundles React app → `plugin/ui/viewer-bundle.js` (246KB)
2. Copies HTML template → `plugin/ui/viewer.html`
3. Copies fonts → `plugin/ui/assets/fonts/`
4. Copies SVG icons → `plugin/ui/icon-thick-*.svg`

**esbuild Configuration**:
- Minification enabled
- Bundles all dependencies except `bun:sqlite`
- React JSX automatic runtime for viewer
- Platform-specific targets (node/browser)

### Build Commands

```bash
# Development workflow
npm run build                  # Build all components
npm run build-and-sync         # Build + sync to marketplace + restart worker
npm run sync-marketplace       # Sync plugin/ to ~/.claude/plugins/marketplaces/thedotmack/
npm run sync-marketplace:force # Force sync (ignores beta branch check)

# Worker management
npm run worker:start           # Start worker daemon
npm run worker:stop            # Stop worker daemon
npm run worker:restart         # Restart worker daemon
npm run worker:status          # Check worker status
npm run worker:logs            # View recent logs (last 50 lines)
npm run worker:tail            # Tail logs in real-time

# Cursor integration
npm run cursor:install         # Install Cursor hooks
npm run cursor:uninstall       # Uninstall Cursor hooks
npm run cursor:status          # Check Cursor integration status
npm run cursor:setup           # Interactive setup wizard

# Testing
npm test                       # Run all tests
npm run test:sqlite            # Database tests
npm run test:agents            # AI agent tests
npm run test:search            # Search strategy tests
npm run test:context           # Context generation tests
npm run test:infra             # Infrastructure tests
npm run test:server            # HTTP server tests

# Queue management
npm run queue                  # Check pending queue
npm run queue:process          # Process pending messages
npm run queue:clear            # Clear failed messages

# Translation
npm run translate:tier1        # Tier 1 languages (zh, ja, pt-br, ko, es, de, fr)
npm run translate:tier2        # Tier 2 languages (he, ar, ru, pl, cs, nl, tr, uk)
npm run translate:tier3        # Tier 3 languages (vi, id, th, hi, bn, ro, sv)
npm run translate:tier4        # Tier 4 languages (it, el, hu, fi, da, no)
npm run translate:all          # All tiers in parallel

# Release management
npm run changelog:generate     # Generate CHANGELOG from GitHub releases
npm run discord:notify         # Send Discord webhook notification

# Utilities
npm run bug-report             # Generate bug report
```

## Worker Service API

**Base URL**: http://localhost:37777

### Session Management
```
POST   /api/sessions/init              # Initialize session
POST   /sessions/:id/init              # Start SDK agent
POST   /sessions/:id/continue          # Continue agent conversation
GET    /api/context/inject             # Get context for injection
```

### Search & Timeline
```
GET    /api/search                     # Search observations
       ?query=string
       &strategy=sqlite|chroma|hybrid
       &limit=number
       &offset=number

GET    /api/timeline                   # Get timeline
       ?start_date=YYYY-MM-DD
       &end_date=YYYY-MM-DD
       &project=string
       &limit=number
```

### Data Access
```
GET    /api/observations               # List observations
       ?project=string
       &limit=number
       &offset=number

GET    /api/summaries                  # List summaries
GET    /api/prompts                    # List user prompts
```

### Settings
```
GET    /api/settings                   # Get all settings
PUT    /api/settings                   # Update settings
       Body: { key: value, ... }
```

### Viewer (UI endpoints)
```
GET    /viewer/observations            # UI data feed
GET    /viewer/summaries               # UI summaries
GET    /viewer/feed                    # Combined feed
GET    /                               # Viewer HTML
```

### Logs
```
GET    /api/logs                       # Get logs
       ?level=DEBUG|INFO|WARN|ERROR
       &limit=number
```

### Health
```
GET    /health                         # Health check
```

## Configuration

### Settings File: `~/.claude-mem/settings.json`

Auto-created with defaults on first run. Editable via UI or API.

**Key Settings**:

```json
{
  // AI Provider
  "CLAUDE_MEM_PROVIDER": "claude",              // claude | gemini | openrouter
  "CLAUDE_MEM_MODEL": "claude-sonnet-4-5",
  "CLAUDE_MEM_GEMINI_API_KEY": "",
  "CLAUDE_MEM_GEMINI_MODEL": "gemini-2.5-flash-lite",
  "CLAUDE_MEM_GEMINI_RATE_LIMITING_ENABLED": "true",
  "CLAUDE_MEM_OPENROUTER_API_KEY": "",
  "CLAUDE_MEM_OPENROUTER_MODEL": "xiaomi/mimo-v2-flash:free",

  // System
  "CLAUDE_MEM_DATA_DIR": "~/.claude-mem",
  "CLAUDE_MEM_WORKER_PORT": "37777",
  "CLAUDE_MEM_LOG_LEVEL": "INFO",               // DEBUG | INFO | WARN | ERROR
  "CLAUDE_MEM_MODE": "",                        // Recording mode (e.g., "chill")

  // Context
  "CLAUDE_MEM_CONTEXT_OBSERVATIONS": "50",      // Number of observations to inject
  "CLAUDE_MEM_CONTEXT_OBSERVATION_TYPES": "",   // Filter by types (comma-separated)
  "CLAUDE_MEM_CONTEXT_OBSERVATION_CONCEPTS": "",// Filter by concepts
  "CLAUDE_MEM_SKIP_TOOLS": "ListMcpResourcesTool,SlashCommand,Skill,TodoWrite,AskUserQuestion",

  // Display
  "CLAUDE_MEM_CONTEXT_SHOW_READ_TOKENS": "true",
  "CLAUDE_MEM_CONTEXT_SHOW_WORK_TOKENS": "true",
  "CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_AMOUNT": "true",
  "CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_PERCENT": "true",

  // Vector Search
  "CLAUDE_MEM_EMBEDDING_FUNCTION": "",          // Embedding model for ChromaDB
  "CLAUDE_MEM_PYTHON_VERSION": "3.13"           // Python version for ChromaDB
}
```

**Environment Override**: Settings can be overridden with environment variables.

### Mode System

**Location**: `plugin/modes/code--<locale>.json`

**Purpose**: Customize recording behavior per language/style.

**Fields**:
- `recording_focus` - What to record (injected into agent prompts)
- `skip_guidance` - What to skip

**Languages**: 20+ languages including ar, bn, cs, da, de, el, es, fr, he, hi, hu, id, it, ja, ko, nl, no, pl, pt-br, ro, ru, sv, th, tr, uk, vi, zh

**Usage**: Set `CLAUDE_MEM_MODE=chill` to use `code--chill.json`

## File Locations

- **Source**: `/home/user/claude-mem/src/`
- **Built Plugin**: `/home/user/claude-mem/plugin/`
- **Installed Plugin**: `~/.claude/plugins/marketplaces/thedotmack/`
- **Data Directory**: `~/.claude-mem/`
- **Database**: `~/.claude-mem/claude-mem.db`
- **Vector DB**: `~/.claude-mem/chroma/`
- **Logs**: `~/.claude-mem/logs/worker-YYYY-MM-DD.log`
- **Settings**: `~/.claude-mem/settings.json`
- **PID Files**: `~/.claude-mem/worker.pid`

## Database Schema

### Tables

**sdk_sessions**:
- `content_session_id` - Claude Code session ID
- `memory_session_id` - Internal memory session ID
- `project` - Git project name
- `user_prompt` - Initial user request
- `started_at`, `completed_at`, `status`
- `worker_port`, `prompt_counter`

**observations**:
- `memory_session_id`, `project`
- `text` - Observation content
- `type` - decision | bugfix | feature | refactor | discovery | change
- `title` - Short summary
- `concept` - Key concept
- `source_files` - Related files (JSON array)
- `prompt_number` - Prompt counter in session
- `discovery_tokens` - Token count

**session_summaries**:
- `memory_session_id`, `project`
- `request` - What was requested
- `investigated` - What was investigated
- `learned` - What was learned
- `completed` - What was completed
- `next_steps` - Recommended next steps
- `prompt_number`, `discovery_tokens`

**user_prompts**:
- `content_session_id`
- `prompt_number` - Sequential counter
- `prompt_text` - User message

**pending_messages**:
- `session_id`, `message_type`, `message_data`
- `status` - pending | processing | completed | failed

### Migrations

**Location**: `src/services/sqlite/migrations/`

**Execution**: Auto-runs on worker startup

**Count**: 20+ migrations tracking schema evolution

## AI Agent Integration

### SDK Agent (Default)

**Implementation**: `@anthropic-ai/claude-agent-sdk`

**Features**:
- Observation extraction from tool usage
- Compression and summarization
- Multi-turn conversation support
- Structured output parsing

**Prompts**: `src/sdk/prompts.ts`

### Alternative Providers

**Gemini** (`src/services/worker/agents/GeminiAgent.ts`):
- Google Gemini API integration
- Rate limiting and billing controls
- Model: `gemini-2.5-flash-lite` (default)

**OpenRouter** (`src/services/worker/agents/OpenRouterAgent.ts`):
- Multi-model API access
- Model: `xiaomi/mimo-v2-flash:free` (default)

**Selection**: Via `CLAUDE_MEM_PROVIDER` setting

## Search Architecture

### Strategies

**SQLiteSearchStrategy** (`src/services/worker/search/strategies/SQLiteSearchStrategy.ts`):
- Full-text search in observations
- FTS5 indexing
- Fast, local, no dependencies

**ChromaSearchStrategy** (`src/services/worker/search/strategies/ChromaSearchStrategy.ts`):
- Vector embeddings for semantic search
- ChromaDB backend
- Requires Python environment (auto-installed via uv)

**HybridSearchStrategy** (`src/services/worker/search/strategies/HybridSearchStrategy.ts`):
- Combined SQLite + Chroma
- Merges and ranks results
- Best of both worlds

### Search Orchestrator

**Implementation**: `src/services/worker/search/SearchOrchestrator.ts`

**Pattern**: Strategy pattern for pluggable search backends

**Result Formatting**: `ResultFormatter.ts` - Formats search results with context

**Timeline Building**: `TimelineBuilder.ts` - Chronological timeline construction

## Testing

### Framework

**Runtime**: Bun test
**Convention**: `*.test.ts` files

### Test Organization

```
tests/
├── context/              # Context generation tests
│   ├── token-calculator.test.ts
│   ├── observation-compiler.test.ts
│   └── formatters/markdown-formatter.test.ts
│
├── sqlite/               # Database tests
│
├── worker/               # Worker service tests
│   ├── agents/           # Agent tests
│   └── search/           # Search strategy tests
│
├── server/               # HTTP server tests
│
├── shared/               # Shared utility tests
│
├── utils/                # Utility function tests
│
├── integration/          # E2E tests
│   ├── hook-execution-e2e.test.ts
│   ├── worker-api-endpoints.test.ts
│   └── chroma-vector-sync.test.ts
│
└── standards/            # Code standards validation
    ├── logger-usage-standards.test.ts
    ├── session_id_usage_validation.test.ts
    └── hook-constants.test.ts
```

### Running Tests

```bash
npm test                   # All tests
npm run test:sqlite        # Database tests
npm run test:agents        # AI agent tests
npm run test:search        # Search tests
npm run test:context       # Context tests
npm run test:infra         # Infrastructure tests
npm run test:server        # Server tests
```

## Documentation

### Public Documentation

**URL**: https://docs.claude-mem.ai
**Platform**: Mintlify
**Source**: `docs/public/` (MDX files)
**Navigation**: Edit `docs/public/docs.json`
**Deploy**: Auto-deploys from GitHub on push to main

**Local Development**:
```bash
cd docs/public
npx mintlify dev           # Local dev server
npx mintlify validate      # Validate structure
npx mintlify broken-links  # Check links
```

### Internationalization

**Location**: `docs/i18n/`

**Languages**: 20+ translated README files

**Tiers**:
- Tier 1: zh, ja, pt-br, ko, es, de, fr
- Tier 2: he, ar, ru, pl, cs, nl, tr, uk
- Tier 3: vi, id, th, hi, bn, ro, sv
- Tier 4: it, el, hu, fi, da, no

## Pro Features Architecture

Claude-mem is designed with a clean separation between open-source core functionality and optional Pro features.

### Open-Source Core (this repository)

- All worker API endpoints on localhost:37777 remain fully open and accessible
- Pro features are headless - no proprietary UI elements in this codebase
- Pro integration points are minimal: settings for license keys, tunnel provisioning logic
- The architecture ensures Pro features extend rather than replace core functionality

### Pro Features (external, coming soon)

- Enhanced UI (Memory Stream) connects to the same localhost:37777 endpoints as the open viewer
- Additional features like advanced filtering, timeline scrubbing, and search tools
- Access gated by license validation, not by modifying core endpoints
- Users without Pro licenses continue using the full open-source viewer UI without limitation

This architecture preserves the open-source nature of the project while enabling sustainable development through optional paid features.

## Requirements

- **Bun** (all platforms) - Auto-installed if missing via `scripts/smart-install.js`
- **uv** (all platforms) - Auto-installed if missing, provides Python for ChromaDB
- **Node.js** >= 18.0.0 - For build scripts and MCP server
- **Git** - For project detection and branch tracking

## Development Workflows

### Local Development Cycle

```bash
# 1. Make changes to src/
vim src/services/worker-service.ts

# 2. Build and sync (builds, syncs to marketplace, restarts worker)
npm run build-and-sync

# 3. Test changes
npm test

# 4. Check logs
npm run worker:logs
```

### Adding a New Hook

1. Create hook file: `src/hooks/my-hook.ts`
2. Implement as HTTP client calling worker API
3. Add to `scripts/build-hooks.js` build list
4. Update `plugin/hooks/hooks.json` with hook definition
5. Build: `npm run build`
6. Test: Manually trigger hook via Claude Code

### Adding a New Worker Endpoint

1. Create route handler: `src/services/worker/http/routes/MyRoutes.ts`
2. Register routes in `src/services/worker-service.ts`
3. Add types to `src/types/`
4. Write tests: `tests/worker/http/my-routes.test.ts`
5. Update this documentation
6. Build and test: `npm run build-and-sync && npm test`

### Adding a New Search Strategy

1. Create strategy: `src/services/worker/search/strategies/MyStrategy.ts`
2. Implement `SearchStrategy` interface
3. Register in `SearchOrchestrator.ts`
4. Write tests: `tests/worker/search/my-strategy.test.ts`
5. Update settings defaults if needed
6. Test: `npm run test:search`

### Updating UI

1. Edit React components: `src/ui/viewer/components/`
2. Build viewer: `npm run build` (calls `scripts/build-viewer.js`)
3. View at http://localhost:37777 (restart worker if needed)
4. Check console for errors

### Database Migrations

1. Create migration: `src/services/sqlite/migrations/XXX-description.ts`
2. Implement `up()` function with SQL changes
3. Increment migration count in `runner.ts`
4. Test migration: `npm run worker:restart` (auto-runs migrations)
5. Verify schema: Check `~/.claude-mem/claude-mem.db`

### Release Process

**Note**: Changelog is auto-generated. Do not edit manually.

1. Use version-bump skill: `/.claude/skills/version-bump/`
2. Skill updates: `package.json`, `marketplace.json`, git tags
3. Creates GitHub release
4. Auto-generates `CHANGELOG.md` from releases
5. Optional: `npm run discord:notify` for Discord webhook

## Important Conventions

### Code Standards

1. **Always commit build artifacts** in `plugin/` - The plugin must work out of the box without requiring users to build from source

2. **Never edit CHANGELOG.md manually** - It's auto-generated from GitHub releases via `npm run changelog:generate`

3. **Privacy tags are stripped at edge** - Hooks must strip `<private>` and `<no-mem>` tags before sending to worker

4. **Hooks are thin HTTP clients** - No business logic in hooks, delegate to worker API

5. **Worker orchestrates, services implement** - `worker-service.ts` coordinates, specialized services handle logic

6. **Test before committing** - Run `npm test` to validate changes

7. **Use structured logging** - Import `logger` from `src/utils/logger.ts`, use `logger.info()`, `logger.error()`, etc.

8. **Session IDs are critical** - Always use `memory_session_id` for internal tracking, `content_session_id` for Claude Code sessions

9. **ESM for hooks, CJS for worker** - Hooks are ESM modules, worker is CJS for better compatibility

10. **Platform multipliers for timeouts** - Windows gets 2x timeout multipliers (see `src/shared/hook-constants.ts`)

### File Naming

- Hooks: `*-hook.ts` → `*-hook.js`
- Tests: `*.test.ts`
- Routes: `*Routes.ts`
- Stores: `*Store.ts`
- Services: `*Service.ts`, `*Manager.ts`

### Import Conventions

```typescript
// Prefer named imports
import { logger } from '../utils/logger.js'
import { SessionStore } from '../services/sqlite/SessionStore.js'

// ESM requires .js extension in imports (even for .ts files)
import { foo } from './bar.js'  // Correct
import { foo } from './bar'     // Wrong
```

### Error Handling

```typescript
// Use logger for errors
import { logger } from '../utils/logger.js'

try {
  // ...
} catch (error) {
  logger.error('Operation failed', { error, context })
  throw error  // Re-throw if caller should handle
}
```

### API Response Format

```typescript
// Success
res.json({
  success: true,
  data: result
})

// Error
res.status(500).json({
  success: false,
  error: 'Error message',
  details: errorDetails
})
```

## Common Issues & Debugging

### Worker won't start

```bash
# Check if already running
npm run worker:status

# Check logs
npm run worker:logs

# Force stop and restart
npm run worker:stop
npm run worker:start

# Check port
lsof -i :37777  # Unix
netstat -ano | findstr :37777  # Windows
```

### Hooks timing out

- Check `src/shared/hook-constants.ts` for timeout values
- Windows platforms get 2x multiplier
- Increase timeout in `plugin/hooks/hooks.json` if needed

### Database locked

- Ensure only one worker instance running
- Check for zombie processes: `ps aux | grep worker-service`
- Stop worker: `npm run worker:stop`

### Context not injecting

- Check `~/.claude-mem/settings.json` for `CLAUDE_MEM_CONTEXT_OBSERVATIONS`
- Verify database has observations: Check `~/.claude-mem/claude-mem.db`
- Check logs: `npm run worker:logs`
- Ensure worker is running: `npm run worker:status`

### Search not working

- SQLite strategy: Check database integrity
- Chroma strategy: Ensure Python environment installed
- Check settings: `CLAUDE_MEM_EMBEDDING_FUNCTION`
- View logs: `~/.claude-mem/logs/worker-YYYY-MM-DD.log`

### Build failures

```bash
# Clean build
rm -rf plugin/scripts plugin/ui

# Rebuild
npm run build

# Check for TypeScript errors
npx tsc --noEmit
```

## TypeScript Configuration

```json
{
  "compilerOptions": {
    "jsx": "react",
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "node",
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "types": ["node"]
  }
}
```

## Performance Considerations

- **Hook execution**: Hooks must complete within timeout (60-300s depending on hook type)
- **Database queries**: Use indexes for frequent queries, see migrations
- **Vector search**: ChromaDB initialization can be slow on first run (Python setup)
- **Context injection**: Limited by `CLAUDE_MEM_CONTEXT_OBSERVATIONS` setting (default: 50)
- **Bundle sizes**: Worker service is 1.8MB, viewer is 246KB
- **Memory usage**: SQLite uses minimal memory, ChromaDB uses ~100-500MB

## Security Considerations

- **Privacy tags**: Always strip `<private>` and `<no-mem>` tags before storage
- **API keys**: Store in `~/.claude-mem/settings.json`, never commit to git
- **Local-only**: Worker API only binds to localhost:37777, not exposed externally
- **CORS**: Restricted to localhost origins
- **File access**: All file operations scoped to `~/.claude-mem/`

## Additional Resources

- **GitHub**: https://github.com/thedotmack/claude-mem
- **Documentation**: https://docs.claude-mem.ai
- **Issues**: https://github.com/thedotmack/claude-mem/issues
- **License**: AGPL-3.0

---

**Version**: 8.5.10
**Last Updated**: 2026-01-10
