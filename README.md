# Claude-Mem

**Persistent memory compression system for Claude Code**

Claude-Mem seamlessly preserves context across sessions by automatically capturing tool usage observations, generating semantic summaries, and making them available to future sessions. This enables Claude to maintain continuity of knowledge about projects even after sessions end or reconnect.

[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL%203.0-blue.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-4.2.3-green.svg)](package.json)
[![Node](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen.svg)](package.json)

---

## Quick Start

Start a new Claude Code session in the terminal and enter the following commands:

```
> /plugin marketplace add thedotmack/claude-mem

> /plugin install claude-mem
```

Restart Claude Code. Context from previous sessions will automatically appear in new sessions.

**Key Features:**
- 🧠 **Persistent Memory** - Context survives across sessions
- 🔍 **7 Search Tools** - Query your project history via MCP
- 🤖 **Automatic Operation** - No manual intervention required
- 📊 **FTS5 Search** - Fast full-text search across observations
- 🔗 **Citations** - Reference past decisions with `claude-mem://` URIs

---

## Documentation

### Getting Started
- **[Installation Guide](docs/installation.md)** - Quick start & advanced installation
- **[Usage Guide](docs/usage/getting-started.md)** - How Claude-Mem works automatically
- **[MCP Search Tools](docs/usage/search-tools.md)** - Query your project history

### Architecture
- **[Overview](docs/architecture/overview.md)** - System components & data flow
- **[Hooks](docs/architecture/hooks.md)** - 5 lifecycle hooks explained
- **[Worker Service](docs/architecture/worker-service.md)** - HTTP API & PM2 management
- **[Database](docs/architecture/database.md)** - SQLite schema & FTS5 search
- **[MCP Search](docs/architecture/mcp-search.md)** - 7 search tools & examples

### Configuration & Development
- **[Configuration](docs/configuration.md)** - Environment variables & settings
- **[Development](docs/development.md)** - Building, testing, contributing
- **[Troubleshooting](docs/troubleshooting.md)** - Common issues & solutions

---

## How It Works

```
┌─────────────────────────────────────────────────────────────┐
│ Session Start → Inject context from last 10 sessions       │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│ User Prompts → Create session, save user prompts           │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│ Tool Executions → Capture observations (Read, Write, etc.)  │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│ Worker Processes → Extract learnings via Claude Agent SDK   │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│ Session Ends → Generate summary, ready for next session     │
└─────────────────────────────────────────────────────────────┘
```

**Core Components:**
1. **5 Lifecycle Hooks** - SessionStart, UserPromptSubmit, PostToolUse, Stop, SessionEnd
2. **Worker Service** - HTTP API on port 37777 managed by PM2
3. **SQLite Database** - Stores sessions, observations, summaries with FTS5 search
4. **7 MCP Search Tools** - Query historical context with citations

See [Architecture Overview](docs/architecture/overview.md) for details.

---

## MCP Search Tools

Claude-Mem provides 7 specialized search tools:

1. **search_observations** - Full-text search across observations
2. **search_sessions** - Full-text search across session summaries
3. **search_user_prompts** - Search raw user requests
4. **find_by_concept** - Find by concept tags
5. **find_by_file** - Find by file references
6. **find_by_type** - Find by type (decision, bugfix, feature, etc.)
7. **get_recent_context** - Get recent session context

**Example Queries:**
```
search_observations with query="authentication" and type="decision"
find_by_file with filePath="worker-service.ts"
search_user_prompts with query="add dark mode"
get_recent_context with limit=5
```

See [MCP Search Tools Guide](docs/usage/search-tools.md) for detailed examples.

---

## What's New in v4.2.3

**Security:**
- Fixed FTS5 injection vulnerability in search functions
- Added comprehensive test suite with 332 injection attack tests

**Fixes:**
- Fixed ESM/CJS compatibility for getDirname function
- Fixed Windows PowerShell compatibility in SessionStart hook
- Cross-platform dependency installation now works on Windows, macOS, and Linux

See [CHANGELOG.md](CHANGELOG.md) for complete version history.

---

## System Requirements

- **Node.js**: 18.0.0 or higher
- **Claude Code**: Latest version with plugin support
- **PM2**: Process manager (bundled - no global install required)
- **SQLite 3**: For persistent storage (bundled)

---

## Key Benefits

### Automatic Memory
- Context automatically injected when Claude starts
- No manual commands or configuration needed
- Works transparently in the background

### Full History Search
- Search across all sessions and observations
- FTS5 full-text search for fast queries
- Citations link back to specific observations

### Structured Observations
- AI-powered extraction of learnings
- Categorized by type (decision, bugfix, feature, etc.)
- Tagged with concepts and file references

### Multi-Prompt Sessions
- Sessions span multiple user prompts
- Context preserved across `/clear` commands
- Track entire conversation threads

---

## Configuration

**Model Selection:**
```bash
./claude-mem-settings.sh
```

**Environment Variables:**
- `CLAUDE_MEM_MODEL` - AI model for processing (default: claude-sonnet-4-5)
- `CLAUDE_MEM_WORKER_PORT` - Worker port (default: 37777)
- `CLAUDE_MEM_DATA_DIR` - Data directory override (dev only)

See [Configuration Guide](docs/configuration.md) for details.

---

## Development

```bash
# Clone and build
git clone https://github.com/thedotmack/claude-mem.git
cd claude-mem
npm install
npm run build

# Run tests
npm test

# Start worker
npm run worker:start

# View logs
npm run worker:logs
```

See [Development Guide](docs/development.md) for detailed instructions.

---

## Troubleshooting

**Common Issues:**
- Worker not starting → `npm run worker:restart`
- No context appearing → `npm run test:context`
- Database issues → `sqlite3 ~/.claude-mem/claude-mem.db "PRAGMA integrity_check;"`
- Search not working → Check FTS5 tables exist

See [Troubleshooting Guide](docs/troubleshooting.md) for complete solutions.

---

## Contributing

Contributions are welcome! Please:

1. Fork the repository
2. Create a feature branch
3. Make your changes with tests
4. Update documentation
5. Submit a Pull Request

See [Development Guide](docs/development.md) for contribution workflow.

---

## License

This project is licensed under the **GNU Affero General Public License v3.0** (AGPL-3.0).

Copyright (C) 2025 Alex Newman (@thedotmack). All rights reserved.

See the [LICENSE](LICENSE) file for full details.

**What This Means:**
- You can use, modify, and distribute this software freely
- If you modify and deploy on a network server, you must make your source code available
- Derivative works must also be licensed under AGPL-3.0
- There is NO WARRANTY for this software

---

## Support

- **Documentation**: [docs/](docs/)
- **Issues**: [GitHub Issues](https://github.com/thedotmack/claude-mem/issues)
- **Repository**: [github.com/thedotmack/claude-mem](https://github.com/thedotmack/claude-mem)
- **Author**: Alex Newman ([@thedotmack](https://github.com/thedotmack))

---

**Built with Claude Agent SDK** | **Powered by Claude Code** | **Made with TypeScript**
