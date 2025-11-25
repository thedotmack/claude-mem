<h1 align="center">
  <br>
  <a href="https://github.com/thedotmack/claude-mem">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/thedotmack/claude-mem/main/docs/public/claude-mem-logo-for-dark-mode.webp">
      <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/thedotmack/claude-mem/main/docs/public/claude-mem-logo-for-light-mode.webp">
      <img src="https://raw.githubusercontent.com/thedotmack/claude-mem/main/docs/public/claude-mem-logo-for-light-mode.webp" alt="Claude-Mem" width="400">
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
    <img src="https://img.shields.io/badge/version-6.3.0-green.svg" alt="Version">
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
      <img src="https://raw.githubusercontent.com/thedotmack/claude-mem/main/docs/public/cm-preview.gif" alt="Claude-Mem Preview" width="800">
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
- 🔍 **Skill-Based Search** - Query your project history with mem-search skill (~2,250 token savings)
- 🖥️ **Web Viewer UI** - Real-time memory stream at http://localhost:37777
- 🤖 **Automatic Operation** - No manual intervention required
- 🔗 **Citations** - Reference past decisions with `claude-mem://` URIs
- 🧪 **Beta Channel** - Try experimental features like Endless Mode via version switching

---

## Documentation

📚 **[View Full Documentation](docs/)** - Browse markdown docs on GitHub

💻 **Local Preview**: Run Mintlify docs locally:

```bash
cd docs
npx mintlify dev
```

### Getting Started

- **[Installation Guide](https://docs.claude-mem.ai/installation)** - Quick start & advanced installation
- **[Usage Guide](https://docs.claude-mem.ai/usage/getting-started)** - How Claude-Mem works automatically
- **[Search Tools](https://docs.claude-mem.ai/usage/search-tools)** - Query your project history with natural language
- **[Beta Features](https://docs.claude-mem.ai/beta-features)** - Try experimental features like Endless Mode

### Best Practices

- **[Context Engineering](https://docs.claude-mem.ai/context-engineering)** - AI agent context optimization principles
- **[Progressive Disclosure](https://docs.claude-mem.ai/progressive-disclosure)** - Philosophy behind Claude-Mem's context priming strategy

### Architecture

- **[Overview](https://docs.claude-mem.ai/architecture/overview)** - System components & data flow
- **[Architecture Evolution](https://docs.claude-mem.ai/architecture-evolution)** - The journey from v3 to v5
- **[Hooks Architecture](https://docs.claude-mem.ai/hooks-architecture)** - How Claude-Mem uses lifecycle hooks
- **[Hooks Reference](https://docs.claude-mem.ai/architecture/hooks)** - 7 hook scripts explained
- **[Worker Service](https://docs.claude-mem.ai/architecture/worker-service)** - HTTP API & PM2 management
- **[Database](https://docs.claude-mem.ai/architecture/database)** - SQLite schema & FTS5 search
- **[Search Architecture](https://docs.claude-mem.ai/architecture/search-architecture)** - Hybrid search with Chroma vector database

### Configuration & Development

- **[Configuration](https://docs.claude-mem.ai/configuration)** - Environment variables & settings
- **[Development](https://docs.claude-mem.ai/development)** - Building, testing, contributing
- **[Troubleshooting](https://docs.claude-mem.ai/troubleshooting)** - Common issues & solutions

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

1. **6 Lifecycle Hooks** - context-hook, user-message-hook, new-hook, save-hook, summary-hook, cleanup-hook
2. **Smart Install** - Cached dependency checker (pre-hook script, not a lifecycle hook)
3. **Worker Service** - HTTP API on port 37777 with web viewer UI and 10 search endpoints, managed by PM2
4. **SQLite Database** - Stores sessions, observations, summaries with FTS5 full-text search
5. **mem-search Skill** - Natural language queries with progressive disclosure (~2,250 token savings vs MCP)
6. **Chroma Vector Database** - Hybrid semantic + keyword search for intelligent context retrieval

See [Architecture Overview](https://docs.claude-mem.ai/architecture/overview) for details.

---

## mem-search Skill

Claude-Mem provides intelligent search through the mem-search skill that auto-invokes when you ask about past work:

**How It Works:**
- Just ask naturally: *"What did we do last session?"* or *"Did we fix this bug before?"*
- Claude automatically invokes the mem-search skill to find relevant context
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

See [Search Tools Guide](https://docs.claude-mem.ai/usage/search-tools) for detailed examples.

---

## Beta Features & Endless Mode

Claude-Mem offers a **beta channel** with experimental features. Switch between stable and beta versions directly from the web viewer UI.

### How to Try Beta

1. Open http://localhost:37777
2. Click Settings (gear icon)
3. In **Version Channel**, click "Try Beta (Endless Mode)"
4. Wait for the worker to restart

Your memory data is preserved when switching versions.

### Endless Mode (Beta)

The flagship beta feature is **Endless Mode** - a biomimetic memory architecture that dramatically extends session length:

**The Problem**: Standard Claude Code sessions hit context limits after ~50 tool uses. Each tool adds 1-10k+ tokens, and Claude re-synthesizes all previous outputs on every response (O(N²) complexity).

**The Solution**: Endless Mode compresses tool outputs into ~500-token observations and transforms the transcript in real-time:

```
Working Memory (Context):     Compressed observations (~500 tokens each)
Archive Memory (Disk):        Full tool outputs preserved for recall
```

**Expected Results**:
- ~95% token reduction in context window
- ~20x more tool uses before context exhaustion
- Linear O(N) scaling instead of quadratic O(N²)
- Full transcripts preserved for perfect recall

**Caveats**: Adds latency (60-90s per tool for observation generation), still experimental.

See [Beta Features Documentation](https://docs.claude-mem.ai/beta-features) for details.

---

## What's New in v6.0.0

**🚀 Major Session Management & Transcript Processing Improvements:**

- **Enhanced Session Initialization**: Accept userPrompt and promptNumber for better context tracking
- **Live UserPrompt Updates**: Multi-turn conversation support with real-time prompt tracking
- **Improved SessionManager**: Better context handling and observation processing
- **Comprehensive Transcript Processing**: New scripts and utilities for analyzing Claude Code transcripts
- **Rich Context Extraction**: Advanced parsing utilities for extracting meaningful context from sessions
- **Refactored Architecture**: Improved hooks and SDKAgent for more reliable observation handling
- **Silent Debug Logging**: Better debugging capabilities without cluttering output
- **Enhanced Error Handling**: More robust error recovery and debugging tools

**Breaking Changes**: Significant architectural changes in session management and observation handling. Existing sessions continue to work, but internal APIs have evolved.

**Previous Highlights:**

- **v5.5.0**: mem-search skill enhancement with 100% effectiveness rate
- **v5.4.0**: Skill-based search architecture (~2,250 tokens saved per session)
- **v5.1.2**: Theme toggle for light/dark mode in viewer UI
- **v5.1.0**: Web-based viewer UI with real-time updates
- **v5.0.3**: Smart install caching (2-5s → 10ms)
- **v5.0.0**: Hybrid search with Chroma vector database

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

See [Configuration Guide](https://docs.claude-mem.ai/configuration) for details.

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

See [Development Guide](https://docs.claude-mem.ai/development) for detailed instructions.

---

## Troubleshooting

**Quick Diagnostic:**

If you're experiencing issues, describe the problem to Claude and the troubleshoot skill will automatically activate to diagnose and provide fixes.

**Common Issues:**

- Worker not starting → `npm run worker:restart`
- No context appearing → `npm run test:context`
- Database issues → `sqlite3 ~/.claude-mem/claude-mem.db "PRAGMA integrity_check;"`
- Search not working → Check FTS5 tables exist

See [Troubleshooting Guide](https://docs.claude-mem.ai/troubleshooting) for complete solutions.

---

## Contributing

Contributions are welcome! Please:

1. Fork the repository
2. Create a feature branch
3. Make your changes with tests
4. Update documentation
5. Submit a Pull Request

See [Development Guide](https://docs.claude-mem.ai/development) for contribution workflow.

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
