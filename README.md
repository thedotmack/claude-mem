# Claude-Mem

**Persistent memory compression system for Claude Code**

Claude-Mem seamlessly preserves context across sessions by automatically capturing tool usage observations, generating semantic summaries, and making them available to future sessions. This enables Claude to maintain continuity of knowledge about projects even after sessions end or reconnect.

[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL%203.0-blue.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-3.9.17-green.svg)](package.json)
[![Node](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen.svg)](package.json)

---

## Table of Contents

- [Overview](#overview)
- [How It Works](#how-it-works)
- [Installation](#installation)
- [Usage](#usage)
- [Architecture](#architecture)
- [Configuration](#configuration)
- [Development](#development)
- [Troubleshooting](#troubleshooting)
- [License](#license)

---

## Overview

### What is Claude-Mem?

Claude-Mem is a **Claude Code plugin** that provides persistent memory across sessions. When you work with Claude Code on a project, claude-mem:

1. **Captures** every tool execution (Read, Write, Bash, Edit, etc.)
2. **Processes** observations through Claude Agent SDK to extract learnings
3. **Summarizes** what was accomplished, learned, and what's next
4. **Restores** context automatically when you start new sessions

### Key Features

- **Session Continuity**: Knowledge persists across Claude Code sessions
- **Automatic Context Injection**: Recent session summaries appear when Claude starts
- **Structured Observations**: XML-formatted extraction of learnings
- **Smart Filtering**: Skips low-value tool observations
- **Multi-Prompt Sessions**: Tracks multiple prompts within a single session
- **HTTP API**: Modern REST interface for hook communication
- **Process Management**: PM2-managed long-running service
- **Graceful Degradation**: Doesn't block Claude even if worker is down

### System Requirements

- **Node.js**: 18.0.0 or higher
- **Claude Code**: Latest version with plugin support
- **PM2**: Process manager (installed as dev dependency)
- **SQLite 3**: For persistent storage (bundled)

---

## How It Works

### The Full Lifecycle

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

### Core Components

#### 1. Plugin Hooks (5 Lifecycle Hooks)

- **SessionStart Hook** (`context-hook.js`): Queries database for last 3 sessions and injects context
- **UserPromptSubmit Hook** (`new-hook.js`): Creates/reuses SDK session, sends init signal
- **PostToolUse Hook** (`save-hook.js`): Sends tool observations to worker service
- **Stop Hook** (`summary-hook.js`): Triggers final summary generation
- **SessionEnd Hook** (`cleanup-hook.js`): Marks session as completed/failed

#### 2. Worker Service

Long-running HTTP service (managed by PM2) that:

- Listens on dynamic port 37000-37999
- Provides REST API for hook communication
- Maintains active session state in memory
- Routes observations to Claude Agent SDK
- Writes processed summaries back to database

**Endpoints:**
- `POST /sessions/:id/init` - Initialize session
- `POST /sessions/:id/observations` - Queue tool observations
- `POST /sessions/:id/summarize` - Generate summary
- `GET /sessions/:id/status` - Check status
- `DELETE /sessions/:id` - Clean up session
- `GET /health` - Health check

#### 3. SDK Memory Processor

Uses Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) to:

- Build specialized XML-structured prompts
- Feed observations through iterative cycles
- Parse Claude's XML responses for structured data
- Accumulate learnings about modifications, discoveries, decisions
- Generate final summaries with lessons learned and next steps

#### 4. Database Layer

SQLite database (`~/.claude-mem/claude-mem.db`) with tables:

- **sdk_sessions**: Active/completed session tracking
- **observations**: Individual tool executions
- **session_summaries**: Processed semantic summaries
- **sessions**, **memories**, **overviews**: Legacy tables

---

## Installation

### Prerequisites

```bash
# Ensure Node.js 18+ is installed
node --version  # Should be >= 18.0.0
```

### Method 1: Clone and Build (Recommended for Development)

```bash
# Clone the repository
git clone https://github.com/thedotmack/claude-mem.git
cd claude-mem

# Install dependencies
npm install

# Build hooks and worker service
npm run build

# Start the worker service
npm run worker:start

# Verify worker is running
npm run worker:status
```

### Method 2: NPM Package (Coming Soon)

```bash
# Install from NPM (when published)
npm install -g claude-mem

# Worker service auto-starts on first hook execution
```

### Post-Installation

1. **Verify Plugin Installation**

   Check that hooks are configured in Claude Code:
   ```bash
   cat plugin/hooks/hooks.json
   ```

2. **Set Environment Variable (Optional)**

   To customize data directory:
   ```bash
   export CLAUDE_MEM_DATA_DIR=/custom/path
   ```

   Default: `~/.claude-mem/`

3. **Check Worker Logs**

   ```bash
   npm run worker:logs
   ```

4. **Test Context Retrieval**

   ```bash
   npm run test:context
   ```

---

## Usage

### Automatic Operation

Claude-Mem works automatically once installed. No manual intervention required!

1. **Start Claude Code** - Context from last 3 sessions appears automatically
2. **Work normally** - Every tool execution is captured
3. **Stop Claude** - Summary is generated and saved
4. **Next session** - Previous work appears in context

### Manual Commands

#### Worker Management

```bash
# Start worker service
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

#### Testing

```bash
# Run all tests
npm test

# Test context injection
npm run test:context

# Verbose context test
npm run test:context:verbose
```

#### Development

```bash
# Build hooks and worker
npm run build

# Build only hooks
npm run build:hooks

# Publish to NPM (maintainers only)
npm run publish:npm
```

### Viewing Stored Context

Context is stored in SQLite database at `~/.claude-mem/claude-mem.db`. You can query it directly:

```bash
sqlite3 ~/.claude-mem/claude-mem.db

# View recent sessions
SELECT session_id, project, created_at, status FROM sdk_sessions ORDER BY created_at DESC LIMIT 10;

# View session summaries
SELECT session_id, request, completed, learned FROM session_summaries ORDER BY created_at DESC LIMIT 5;

# View observations for a session
SELECT tool_name, created_at FROM observations WHERE session_id = 'YOUR_SESSION_ID';
```

---

## Architecture

### Technology Stack

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

### Directory Structure

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
│   ├── sdk/                    # Claude Agent SDK integration
│   │   ├── prompts.ts          # XML prompt builders
│   │   ├── parser.ts           # XML response parser
│   │   └── worker.ts           # Main SDK agent loop
│   │
│   ├── services/
│   │   ├── worker-service.ts   # Express HTTP service
│   │   └── sqlite/             # Database layer
│   │       ├── Database.ts
│   │       ├── HooksDatabase.ts
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
│   ├── hooks/
│   │   └── hooks.json
│   └── scripts/                # Built hook executables
│
├── dist/                       # Built output
│   └── worker-service.cjs
│
├── tests/                      # Test suite
├── context/                    # Architecture docs
└── ecosystem.config.cjs        # PM2 configuration
```

### Data Flow

```
Hook (stdin) → Database → Worker Service → SDK Processor → Database → Next Session Hook
```

1. **Input**: Claude Code sends tool execution data via stdin to hooks
2. **Storage**: Hooks write observations to SQLite database
3. **Processing**: Worker service reads observations, processes via SDK
4. **Output**: Processed summaries written back to database
5. **Retrieval**: Next session's context hook reads summaries from database

---

## Configuration

### Environment Variables

| Variable                | Default              | Description                           |
|-------------------------|----------------------|---------------------------------------|
| `CLAUDE_MEM_DATA_DIR`   | `~/.claude-mem/`     | Data directory for DB and logs        |
| `CLAUDE_MEM_WORKER_PORT`| `0` (dynamic)        | Worker service port (37000-37999)     |
| `NODE_ENV`              | `production`         | Environment mode                      |
| `FORCE_COLOR`           | `1`                  | Enable colored logs                   |

### Files and Directories

```
~/.claude-mem/
├── claude-mem.db           # SQLite database
├── worker.port             # Current worker port file
└── logs/
    ├── worker-out.log      # Worker stdout logs
    └── worker-error.log    # Worker stderr logs
```

### Plugin Configuration

Hooks are configured in `plugin/hooks/hooks.json`:

```json
{
  "SessionStart": {
    "command": "${CLAUDE_PLUGIN_ROOT}/scripts/context-hook.js",
    "timeout": 180000
  },
  "UserPromptSubmit": {
    "command": "${CLAUDE_PLUGIN_ROOT}/scripts/new-hook.js",
    "timeout": 60000
  },
  "PostToolUse": {
    "command": "${CLAUDE_PLUGIN_ROOT}/scripts/save-hook.js",
    "timeout": 180000
  },
  "Stop": {
    "command": "${CLAUDE_PLUGIN_ROOT}/scripts/summary-hook.js",
    "timeout": 60000
  },
  "SessionEnd": {
    "command": "${CLAUDE_PLUGIN_ROOT}/scripts/cleanup-hook.js",
    "timeout": 60000
  }
}
```

---

## Development

### Building from Source

```bash
# Clone repository
git clone https://github.com/thedotmack/claude-mem.git
cd claude-mem

# Install dependencies
npm install

# Build all components
npm run build
```

The build process:
1. Compiles TypeScript to JavaScript using esbuild
2. Creates standalone executables for each hook in `plugin/scripts/`
3. Bundles worker service to `dist/worker-service.cjs`

### Running Tests

```bash
# Run all tests
npm test

# Run specific test file
node --test tests/session-lifecycle.test.ts
```

### Development Workflow

1. Make changes to TypeScript source files
2. Run `npm run build` to compile
3. Test with `npm run test:context` or start Claude Code
4. Check worker logs with `npm run worker:logs`

### Adding New Features

#### Adding a New Hook

1. Create hook implementation in `src/hooks/your-hook.ts`
2. Create entry point in `src/bin/hooks/your-hook.ts`
3. Add to `plugin/hooks/hooks.json`
4. Rebuild with `npm run build`

#### Modifying Database Schema

1. Add migration to `src/services/sqlite/migrations.ts`
2. Update types in `src/services/sqlite/types.ts`
3. Update database methods in `src/services/sqlite/HooksDatabase.ts`

#### Extending SDK Prompts

1. Modify prompts in `src/sdk/prompts.ts`
2. Update parser in `src/sdk/parser.ts` to handle new XML structure
3. Test with `npm test`

---

## Troubleshooting

### Worker Service Issues

**Problem**: Worker service not starting

```bash
# Check if PM2 is running
pm2 status

# Check worker logs
npm run worker:logs

# Restart worker
npm run worker:restart

# Full reset
pm2 delete claude-mem-worker
npm run worker:start
```

**Problem**: Port allocation failed

```bash
# Check if port file exists
cat ~/.claude-mem/worker.port

# Manually specify port
CLAUDE_MEM_WORKER_PORT=37500 npm run worker:start
```

### Hook Issues

**Problem**: Hooks not firing

```bash
# Test context hook manually
echo '{"session_id":"test-123","cwd":"'$(pwd)'","source":"startup"}' | node plugin/scripts/context-hook.js

# Check hook permissions
ls -la plugin/scripts/*.js

# Verify hooks.json is valid
cat plugin/hooks/hooks.json | jq .
```

**Problem**: Context not appearing

```bash
# Check if summaries exist
sqlite3 ~/.claude-mem/claude-mem.db "SELECT COUNT(*) FROM session_summaries;"

# View recent sessions
npm run test:context:verbose

# Check database integrity
sqlite3 ~/.claude-mem/claude-mem.db "PRAGMA integrity_check;"
```

### Database Issues

**Problem**: Database locked

```bash
# Close all connections
pm2 stop claude-mem-worker

# Check for stale locks
lsof ~/.claude-mem/claude-mem.db

# Backup and recreate (nuclear option)
cp ~/.claude-mem/claude-mem.db ~/.claude-mem/claude-mem.db.backup
rm ~/.claude-mem/claude-mem.db
npm run worker:start  # Will recreate schema
```

### Debugging

Enable verbose logging:

```bash
# Set debug mode
export DEBUG=claude-mem:*

# View all logs
npm run worker:logs
```

Check correlation IDs to trace observations through the pipeline:

```bash
sqlite3 ~/.claude-mem/claude-mem.db "SELECT correlation_id, tool_name, created_at FROM observations WHERE session_id = 'YOUR_SESSION_ID' ORDER BY created_at;"
```

---

## Contributing

Contributions are welcome! Please:

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

### Code Style

- Use TypeScript strict mode
- Follow existing code formatting
- Add tests for new features
- Update documentation as needed

---

## License

This project is licensed under the **GNU Affero General Public License v3.0** (AGPL-3.0).

Copyright (C) 2025 Alex Newman (@thedotmack). All rights reserved.

See the [LICENSE](LICENSE) file for full details.

### What This Means

- You can use, modify, and distribute this software freely
- If you modify and deploy this software on a network server, you must make your source code available
- Any derivative works must also be licensed under AGPL-3.0
- There is NO WARRANTY for this software

For more information about AGPL-3.0, see: https://www.gnu.org/licenses/agpl-3.0.html

---

## Support

- **Issues**: [GitHub Issues](https://github.com/thedotmack/claude-mem/issues)
- **Repository**: [github.com/thedotmack/claude-mem](https://github.com/thedotmack/claude-mem)
- **Author**: Alex Newman ([@thedotmack](https://github.com/thedotmack))

---

## Changelog

### v3.9.17 (Current)

- Refactored summary and context handling in hooks
- Implemented structured logging across the application
- Fixed race condition in summary generation
- Added missing process.exit(0) calls in hook entry points
- Improved error handling and graceful degradation

---

**Built with Claude Agent SDK** | **Powered by Claude Code** | **Made with TypeScript**
