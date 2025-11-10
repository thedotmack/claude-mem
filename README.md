<h1 align="center">
  <br>
  <a href="https://github.com/thedotmack/claude-mem">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="docs/claude-mem-logo-for-dark-mode.webp">
      <source media="(prefers-color-scheme: light)" srcset="docs/claude-mem-logo-for-light-mode.webp">
      <img src="docs/claude-mem-logo-for-light-mode.webp" alt="Claude-Mem" width="400">
    </picture>
  </a>
  <br>
</h1>

<h4 align="center">Persistent memory compression system built for <a href="https://claude.com/claude-code" target="_blank">Claude Code</a>.</h4>

<p align="center">
  <a href="LICENSE">
    <img src="https://img.shields.io/badge/License-AGPL%203.0-blue.svg" alt="License">
  </a>
  <a href="package.json">
    <img src="https://img.shields.io/badge/version-5.4.0-green.svg" alt="Version">
  </a>
  <a href="package.json">
    <img src="https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen.svg" alt="Node">
  </a>
  <a href="https://github.com/thedotmack/awesome-claude-code">
    <img src="https://awesome.re/mentioned-badge.svg" alt="Mentioned in Awesome Claude Code">
  </a>
</p>

<br>

<p align="center">
  <a href="https://github.com/thedotmack/claude-mem">
    <picture>
      <img src="docs/cm-preview.gif" alt="Claude-Mem Preview" width="800">
    </picture>
  </a>
</p>

<p align="center">
  <a href="#quick-start">Quick Start</a> •
  <a href="#how-it-works">How It Works</a> •
  <a href="#mcp-search-tools">Search Tools</a> •
  <a href="#documentation">Documentation</a> •
  <a href="#configuration">Configuration</a> •
  <a href="#troubleshooting">Troubleshooting</a> •
  <a href="#license">License</a>
</p>

<p align="center">
  Claude-Mem seamlessly preserves context across sessions by automatically capturing tool usage observations, generating semantic summaries, and making them available to future sessions. This enables Claude to maintain continuity of knowledge about projects even after sessions end or reconnect.
</p>

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
- 📊 **Progressive Disclosure** - Layered memory retrieval with token cost visibility
- 🔍 **Skill-Based Search** - Query your project history with natural language (~2,250 token savings)
- 🖥️ **Web Viewer UI** - Real-time memory stream at http://localhost:37777
- 🤖 **Automatic Operation** - No manual intervention required
- 🔗 **Citations** - Reference past decisions with `claude-mem://` URIs

---

## Documentation

📚 **[View Full Documentation](docs/)** - Browse markdown docs on GitHub

💻 **Local Preview**: Run Mintlify docs locally:

```bash
cd docs
npx mintlify dev
```

### Getting Started

- **[Installation Guide](docs/installation.mdx)** - Quick start & advanced installation
- **[Usage Guide](docs/usage/getting-started.mdx)** - How Claude-Mem works automatically
- **[Search Tools](docs/usage/search-tools.mdx)** - Query your project history with natural language

### Best Practices

- **[Context Engineering](docs/context-engineering.mdx)** - AI agent context optimization principles
- **[Progressive Disclosure](docs/progressive-disclosure.mdx)** - Philosophy behind Claude-Mem's context priming strategy

### Architecture

- **[Overview](docs/architecture/overview.mdx)** - System components & data flow
- **[Architecture Evolution](docs/architecture-evolution.mdx)** - The journey from v3 to v5
- **[Hooks Architecture](docs/hooks-architecture.mdx)** - How Claude-Mem uses lifecycle hooks
- **[Hooks Reference](docs/architecture/hooks.mdx)** - 7 hook scripts explained
- **[Worker Service](docs/architecture/worker-service.mdx)** - HTTP API & PM2 management
- **[Database](docs/architecture/database.mdx)** - SQLite schema & FTS5 search
- **[MCP Search](docs/architecture/mcp-search.mdx)** - 9 search tools & examples
- **[Viewer UI](docs/VIEWER.md)** - Web-based memory stream visualization

### Configuration & Development

- **[Configuration](docs/configuration.mdx)** - Environment variables & settings
- **[Development](docs/development.mdx)** - Building, testing, contributing
- **[Troubleshooting](docs/troubleshooting.mdx)** - Common issues & solutions

---

## How It Works

```
┌─────────────────────────────────────────────────────────────┐
│ Session Start → Inject recent observations as context      │
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

1. **7 Lifecycle Hook Scripts** - smart-install, context-hook, user-message-hook, new-hook, save-hook, summary-hook, cleanup-hook
2. **Worker Service** - HTTP API on port 37777 with web viewer UI and 10 search endpoints, managed by PM2
3. **SQLite Database** - Stores sessions, observations, summaries with FTS5 full-text search
4. **Search Skill** - Natural language queries with progressive disclosure (~2,250 token savings vs MCP)
5. **Chroma Vector Database** - Hybrid semantic + keyword search for intelligent context retrieval

See [Architecture Overview](docs/architecture/overview.mdx) for details.

---

## Skill-Based Search

Claude-Mem provides intelligent search through a skill that auto-invokes when you ask about past work:

**How It Works:**
- Just ask naturally: *"What did we do last session?"* or *"Did we fix this bug before?"*
- Claude automatically invokes the search skill to find relevant context
- ~2,250 token savings per session start vs MCP approach

**Available Search Operations:**

1. **Search Observations** - Full-text search across observations
2. **Search Sessions** - Full-text search across session summaries
3. **Search Prompts** - Search raw user requests
4. **By Concept** - Find by concept tags (discovery, problem-solution, pattern, etc.)
5. **By File** - Find observations referencing specific files
6. **By Type** - Find by type (decision, bugfix, feature, refactor, discovery, change)
7. **Recent Context** - Get recent session context for a project
8. **Timeline** - Get unified timeline of context around a specific point in time
9. **Timeline by Query** - Search for observations and get timeline context around best match
10. **API Help** - Get search API documentation

**Example Natural Language Queries:**

```
"What bugs did we fix last session?"
"How did we implement authentication?"
"What changes were made to worker-service.ts?"
"Show me recent work on this project"
"What was happening when we added the viewer UI?"
```

See [Search Tools Guide](docs/usage/search-tools.mdx) for detailed examples.

---

## What's New in v5.4.0

**🔍 Skill-Based Search Architecture (v5.4.0):**

- **Token Savings**: ~2,250 tokens per session start
- **Progressive Disclosure**: Skill frontmatter (~250 tokens) vs MCP tool definitions (~2,500 tokens)
- **Natural Language**: Just ask about past work - Claude auto-invokes the search skill
- **10 HTTP API Endpoints**: Fast, efficient search operations
- **No User Action Required**: Migration is transparent

**🎨 Theme Toggle (v5.1.2):**

- Light/dark mode support in viewer UI
- System preference detection
- Persistent theme settings across sessions

**🖥️ Web-Based Viewer UI (v5.1.0):**

- Real-time memory stream visualization at http://localhost:37777
- Server-Sent Events (SSE) for instant updates
- Infinite scroll pagination with project filtering

**⚡ Smart Install Caching (v5.0.3):**

- Eliminated redundant npm installs (2-5s → 10ms)
- Caches version state, only installs when needed

**🔍 Hybrid Search Architecture (v5.0.0):**

- Chroma vector database for semantic search
- Combined with FTS5 keyword search
- 90-day recency filtering

See [CHANGELOG.md](CHANGELOG.md) for complete version history.

---

## System Requirements

- **Node.js**: 18.0.0 or higher
- **Claude Code**: Latest version with plugin support
- **PM2**: Process manager (bundled - no global install required)
- **SQLite 3**: For persistent storage (bundled)

---

## Key Benefits

### Progressive Disclosure Context

- **Layered memory retrieval** mirrors human memory patterns
- **Layer 1 (Index)**: See what observations exist with token costs at session start
- **Layer 2 (Details)**: Fetch full narratives on-demand via MCP search
- **Layer 3 (Perfect Recall)**: Access source code and original transcripts
- **Smart decision-making**: Token counts help Claude choose between fetching details or reading code
- **Type indicators**: Visual cues (🔴 critical, 🟤 decision, 🔵 informational) highlight observation importance

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

See [Configuration Guide](docs/configuration.mdx) for details.

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

See [Development Guide](docs/development.mdx) for detailed instructions.

---

## Troubleshooting

**Quick Diagnostic:**

Run the troubleshooting skill for automated diagnosis and fixes:

```
/skill troubleshoot
```

**Common Issues:**

- Worker not starting → `npm run worker:restart`
- No context appearing → `npm run test:context`
- Database issues → `sqlite3 ~/.claude-mem/claude-mem.db "PRAGMA integrity_check;"`
- Search not working → Check FTS5 tables exist

See [Troubleshooting Guide](docs/troubleshooting.mdx) for complete solutions.

---

## Contributing

Contributions are welcome! Please:

1. Fork the repository
2. Create a feature branch
3. Make your changes with tests
4. Update documentation
5. Submit a Pull Request

See [Development Guide](docs/development.mdx) for contribution workflow.

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
