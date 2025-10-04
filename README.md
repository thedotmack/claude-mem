<div align="center">

  <img src="claude-mem-logo-lm.webp#gh-light-mode-only" alt="claude-mem logo" width="360" height="auto" />
  <img src="claude-mem-logo-dm.webp#gh-dark-mode-only" alt="claude-mem logo" width="360" height="auto" />

  <p>
    Memory compression and persistence system for Claude Code conversations
  </p>


<!-- Badges -->
<p>
  <a href="https://www.npmjs.com/package/claude-mem">
    <img src="https://img.shields.io/npm/v/claude-mem.svg" alt="npm version" />
  </a>
  <a href="https://github.com/thedotmack/claude-mem/graphs/contributors">
    <img src="https://img.shields.io/github/contributors/thedotmack/claude-mem" alt="contributors" />
  </a>
  <a href="">
    <img src="https://img.shields.io/github/last-commit/thedotmack/claude-mem" alt="last update" />
  </a>
  <a href="https://github.com/thedotmack/claude-mem/network/members">
    <img src="https://img.shields.io/github/forks/thedotmack/claude-mem" alt="forks" />
  </a>
  <a href="https://github.com/thedotmack/claude-mem/stargazers">
    <img src="https://img.shields.io/github/stars/thedotmack/claude-mem" alt="stars" />
  </a>
  <a href="https://github.com/thedotmack/claude-mem/issues/">
    <img src="https://img.shields.io/github/issues/thedotmack/claude-mem" alt="open issues" />
  </a>
  <a href="https://github.com/thedotmack/claude-mem/blob/main/LICENSE">
    <img src="https://img.shields.io/badge/license-AGPL--3.0-blue.svg" alt="license" />
  </a>
  <a href="https://nodejs.org/">
    <img src="https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen.svg" alt="node version" />
  </a>
  <a href="https://modelcontextprotocol.io">
    <img src="https://img.shields.io/badge/MCP-compatible-purple.svg" alt="MCP compatible" />
  </a>
  <a href="https://claude.com/claude-code">
    <img src="https://img.shields.io/badge/Claude%20Code-enabled-orange.svg" alt="Claude Code enabled" />
  </a>
</p>

<h4>
    <a href="https://github.com/thedotmack/claude-mem">Documentation</a>
  <span> · </span>
    <a href="https://github.com/thedotmack/claude-mem/issues/">Report Bug</a>
  <span> · </span>
    <a href="https://github.com/thedotmack/claude-mem/issues/">Request Feature</a>
  </h4>
</div>

<br />

<!-- Table of Contents -->
# :notebook_with_decorative_cover: Table of Contents

- [About the Project](#star2-about-the-project)
  * [Tech Stack](#space_invader-tech-stack)
  * [Features](#dart-features)
- [Getting Started](#toolbox-getting-started)
  * [Prerequisites](#bangbang-prerequisites)
  * [Installation](#gear-installation)
  * [Running Tests](#test_tube-running-tests)
- [Usage](#eyes-usage)
  * [Basic Commands](#basic-commands)
  * [Hook System](#hook-system)
  * [Memory Operations](#memory-operations)
  * [ChromaDB MCP Tools](#chromadb-mcp-tools)
  * [Advanced Usage](#advanced-usage)
- [Architecture](#building_construction-architecture)
- [Configuration](#wrench-configuration)
- [Roadmap](#compass-roadmap)
- [Contributing](#wave-contributing)
- [License](#warning-license)
- [Contact](#handshake-contact)
- [Acknowledgements](#gem-acknowledgements)



<!-- About the Project -->
## :star2: About the Project

claude-mem automatically captures, compresses, and retrieves context across Claude Code sessions, enabling true long-term memory through semantic search and intelligent compression.

Perfect for developers who want their AI assistant to remember project context, past decisions, and conversation history across sessions without manual context management.

<!-- TechStack -->
### :space_invader: Tech Stack

<details>
  <summary>Core Technologies</summary>
  <ul>
    <li><a href="https://www.typescriptlang.org/">TypeScript</a></li>
    <li><a href="https://nodejs.org/">Node.js</a></li>
    <li><a href="https://bun.sh/">Bun</a></li>
  </ul>
</details>

<details>
  <summary>Storage & Memory</summary>
  <ul>
    <li><a href="https://www.trychroma.com/">ChromaDB</a> - Vector database for semantic search</li>
    <li><a href="https://www.sqlite.org/">SQLite</a> - Metadata and session tracking</li>
    <li><a href="https://github.com/WiseLibs/better-sqlite3">better-sqlite3</a> - Fast SQLite bindings</li>
  </ul>
</details>

<details>
<summary>AI & Integration</summary>
  <ul>
    <li><a href="https://github.com/anthropics/anthropic-sdk-typescript">Anthropic Agent SDK</a> - Async compression</li>
    <li><a href="https://modelcontextprotocol.io">Model Context Protocol (MCP)</a> - Tool integration</li>
    <li><a href="https://claude.com/claude-code">Claude Code</a> - Streaming hooks</li>
  </ul>
</details>

<!-- Features -->
### :dart: Features

- :brain: **Automatic Memory Compression** - Real-time conversation capture and intelligent summarization
- :mag: **Semantic Search** - ChromaDB-powered vector search for intelligent context retrieval
- :package: **Project Isolation** - Memories segregated by project with multi-project support
- :arrows_counterclockwise: **Session Persistence** - Context loads automatically at session start and `/clear` command
- :dart: **MCP Integration** - 15+ ChromaDB tools via Model Context Protocol
- :floppy_disk: **SQLite Storage** - Fast metadata and session tracking with embedded database
- :wastebasket: **Smart Trash** - Safe file deletion with recovery capabilities
- :zap: **Streaming Hooks** - Sub-50ms overhead for real-time event capture
- :robot: **Agent SDK Compression** - Async transcript processing without blocking conversations
- :bar_chart: **Session Overviews** - Automatic session summaries with temporal context

<!-- Getting Started -->
## :toolbox: Getting Started

<!-- Prerequisites -->
### :bangbang: Prerequisites

This project requires Node.js and works best with Claude Code

- Node.js >= 18.0.0
- Claude Code with MCP support
- macOS/Linux (POSIX-compliant system)
- Bun >= 1.0.0 (optional, for development)

<!-- Installation -->
### :gear: Installation

Install claude-mem globally via npm

```bash
npm install -g claude-mem
claude-mem install
```

The interactive installer will guide you through three installation scopes:

- **User** - Install for current user (default, recommended)
- **Project** - Install for current project only
- **Local** - Install to custom directory

<!-- Running Tests -->
### :test_tube: Running Tests

To run tests, use the following commands

```bash
# Run all tests
bun test

# Run integration tests
npm run test:integration

# Run with coverage
npm run test:coverage
```

<!-- Usage -->
## :eyes: Usage

### Basic Commands

```bash
# Check installation status
claude-mem status

# View operation logs
claude-mem logs

# Load context for current project
claude-mem load-context --project my-project

# View compressed memories (interactive)
claude-mem restore

# Manage trash bin
claude-mem trash view
claude-mem restore
claude-mem trash empty
```

### Hook System

claude-mem integrates with Claude Code via streaming hooks that capture conversation events:

- **user-prompt-submit** - Captures user prompts in real-time
- **post-tool-use** - Spawns Agent SDK for async compression
- **stop-streaming** - Generates session overview and cleanup
- **session-start** - Loads relevant context automatically

Hooks are configured during installation with a 180-second timeout and run transparently in the background.

### Memory Operations

#### Manual Compression

```bash
claude-mem compress
```

Compress Claude Code transcripts into searchable memories with semantic embeddings.

#### Context Loading

```bash
# Load last 10 memories for current project
claude-mem load-context

# Load specific number of memories
claude-mem load-context --count 20

# Filter by project
claude-mem load-context --project my-app

# Output raw JSON
claude-mem load-context --raw
```

#### Trash Management

claude-mem includes Smart Trash for safe file operations:

```bash
# Move files to trash
claude-mem trash file.txt
claude-mem trash -r directory/

# View trash contents
claude-mem trash view

# Restore files interactively
claude-mem restore

# Empty trash permanently
claude-mem trash empty
```

### ChromaDB MCP Tools

claude-mem exposes 15+ ChromaDB operations via MCP:

```bash
# List collections
claude-mem chroma-list-collections

# Create collection
claude-mem chroma-create-collection --collection-name memories

# Query documents semantically
claude-mem chroma-query-documents \
  --collection-name memories \
  --query-texts '["authentication implementation"]' \
  --n-results 5

# Add documents
claude-mem chroma-add-documents \
  --collection-name memories \
  --documents '["content here"]' \
  --ids '["mem-001"]'

# Get documents by ID
claude-mem chroma-get-documents \
  --collection-name memories \
  --ids '["mem-001"]'

# Update documents
claude-mem chroma-update-documents \
  --collection-name memories \
  --ids '["mem-001"]' \
  --documents '["updated content"]'

# Delete documents
claude-mem chroma-delete-documents \
  --collection-name memories \
  --ids '["mem-001"]'
```

See all available Chroma MCP commands with `claude-mem --help`.

### Advanced Usage

#### Session Title Generation

```bash
# Generate title and subtitle from prompt
claude-mem generate-title "implemented authentication with OAuth"

# Output as JSON
claude-mem generate-title "fixed bug in checkout" --json

# Save to database
claude-mem generate-title "added feature" --session-id abc123 --save
```

#### Diagnostics

```bash
# Run environment diagnostics
claude-mem doctor

# Output as JSON
claude-mem doctor --json
```

#### Changelog Generation

```bash
# Generate changelog from memories
claude-mem changelog

# Preview without saving
claude-mem changelog --preview

# Generate for specific version
claude-mem changelog --generate 3.9.0

# Search historical versions
claude-mem changelog --historical 5
```

## :building_construction: Architecture

### Storage Structure

```
~/.claude-mem/
├── archives/           # Compressed transcript backups
├── chroma/            # ChromaDB vector database
├── trash/             # Smart Trash with recovery
├── hooks/             # Hook configurations
├── logs/              # Operation logs
└── claude-mem.db      # SQLite metadata database
```

### Memory System

**Rolling Memory** - Real-time conversation turn capture via hooks with immediate ChromaDB storage

**TranscriptCompressor** - Intelligent chunking and compression of large conversations

**MCP Server** - 15+ ChromaDB tools for memory operations and semantic search

**SQLite Backend** - Session tracking, metadata management, and diagnostics storage

### Hook Integration

Hooks communicate via JSON stdin/stdout and run with minimal overhead:

1. **user-prompt-submit** - Stores user prompt immediately in ChromaDB
2. **post-tool-use** - Spawns Agent SDK subprocess for async compression
3. **stop-streaming** - Generates session overview, deletes SDK transcript
4. **session-start** - Loads project-specific context invisibly

### Project Structure

```
src/
├── bin/           # CLI entry point
├── commands/      # Command implementations
├── core/          # Core compression logic
├── services/      # SQLite, ChromaDB, path discovery
├── shared/        # Configuration and utilities
└── mcp-server.ts  # MCP server implementation

hook-templates/    # Hook source files
dist/              # Minified production bundle
test/              # Unit and integration tests
```

## :wrench: Configuration

### Hook Timeout

Default hook timeout is 180 seconds. Configure during installation:

```bash
claude-mem install --timeout 300000  # 5 minutes
```

### MCP Server

Skip MCP server installation if needed:

```bash
claude-mem install --skip-mcp
```

### Force Reinstall

```bash
claude-mem install --force
```

<!-- Roadmap -->
## :compass: Roadmap

* [x] Real-time conversation capture with streaming hooks
* [x] ChromaDB vector storage for semantic search
* [x] SQLite metadata and session tracking
* [x] MCP server with 15+ ChromaDB tools
* [x] Smart Trash for safe file deletion
* [x] Automatic session overviews
* [ ] Web UI for memory visualization
* [ ] Cross-platform Windows support
* [ ] Memory analytics and insights

<!-- Contributing -->
## :wave: Contributing

<a href="https://github.com/thedotmack/claude-mem/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=thedotmack/claude-mem" />
</a>

Contributions are always welcome!

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/AmazingFeature`)
3. Commit your changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to the branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request

<!-- License -->
## :warning: License

Distributed under the AGPL-3.0 License. See [LICENSE](LICENSE) for more information.

<!-- Contact -->
## :handshake: Contact

Alex Newman - [@thedotmack](https://github.com/thedotmack)

Project Link: [https://github.com/thedotmack/claude-mem](https://github.com/thedotmack/claude-mem)

NPM Package: [https://www.npmjs.com/package/claude-mem](https://www.npmjs.com/package/claude-mem)

<!-- Acknowledgments -->
## :gem: Acknowledgements

 - [ChromaDB](https://www.trychroma.com/) - Vector database for AI applications
 - [Anthropic](https://www.anthropic.com/) - Claude AI and Agent SDK
 - [Model Context Protocol](https://modelcontextprotocol.io) - Standardized AI tool integration
 - [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) - Fast SQLite bindings
 - [Shields.io](https://shields.io/) - Beautiful README badges
 - [Awesome README Template](https://github.com/Louis3797/awesome-readme-template) - Template inspiration

---

**Philosophy**: claude-mem follows the **Make It Work First** approach - direct execution over defensive validation, natural failures instead of artificial guards, and memory as a living, evolving system. Context improves with use through semantic search, project isolation, and temporal relevance.

**Built with TypeScript, ChromaDB, SQLite, and the Anthropic Agent SDK**
