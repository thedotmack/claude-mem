# 🧠 Claude Memory System (claude-mem)

A real-time memory system for Claude Code that captures, compresses, and retrieves conversation context across sessions using semantic search and vector embeddings.

## ⚡️ Quick Start

```bash
npm install -g claude-mem
claude-mem install
```

Restart Claude Code. Memory capture starts automatically.

## ✨ What It Does

**Real-Time Memory Capture**
- Captures every conversation turn as it happens via streaming hooks
- User prompts stored immediately in ChromaDB with atomic facts
- Tool responses compressed asynchronously via Agent SDK
- Project-based memory isolation with hierarchical metadata
- Automatic context loading at session start and `/clear`

**Semantic Search**
- Vector embeddings for intelligent retrieval via ChromaDB
- Find relevant context from past conversations
- Project-aware memory queries with temporal filtering
- Date-based search using query text (not metadata)
- 15+ MCP tools for memory operations

**Invisible Operation**
- Zero user configuration required
- Memory compression happens in background via SDK
- SDK transcripts auto-deleted from UI history
- Session overviews generated automatically
- Live memory viewer with SSE streaming

**Smart Trash™**
- Safe deletion with easy recovery
- Timestamped trash entries
- One-command restore
- Located at `~/.claude-mem/trash/`

## 🎯 Core Features

- **Streaming Hooks**: Real-time capture with minimal overhead (<50ms)
- **Agent SDK Integration**: Async compression without blocking conversation
- **MCP Server**: 15+ ChromaDB tools for memory operations
- **Project Isolation**: Memories segregated by project context
- **Zero Configuration**: Works out of the box after install
- **Embedded Databases**: ChromaDB and SQLite, no external dependencies
- **Invisible UX**: Memory operations don't pollute conversation UI
- **Live Memory Viewer**: Real-time slideshow of memories via SSE

## 🧭 Commands

```bash
# Setup & Status
claude-mem install          # Install/repair hooks and MCP integration
claude-mem status           # Check installation and memory stats
claude-mem doctor           # Run environment and pipeline diagnostics
claude-mem uninstall        # Remove all hooks

# Memory Operations
claude-mem load-context     # View current session context
claude-mem logs             # View operation logs
claude-mem changelog        # Generate CHANGELOG.md from memories

# Storage Operations (Used by hooks/SDK)
claude-mem store-memory     # Store a memory to ChromaDB + SQLite
claude-mem store-overview   # Store a session overview

# Smart Trash™
claude-mem trash            # View trash contents
claude-mem restore          # Restore from trash
claude-mem trash-empty      # Permanently delete trash

# ChromaDB Tools (15+ MCP tools available)
claude-mem chroma_*         # Direct ChromaDB operations
```

## 📁 Storage Structure

```
~/.claude-mem/
├── chroma/            # ChromaDB vector database
├── archives/          # Compressed transcript backups
├── index/             # Legacy JSONL memory indices
├── hooks/             # Hook configuration files
├── trash/             # Smart Trash™ with recovery
├── logs/              # Operation logs
└── claude-mem.db      # SQLite metadata database
```

## 🏗️ Architecture

**Storage Layers**
- **ChromaDB**: Vector database for semantic search with embeddings
- **SQLite**: Metadata index (`~/.claude-mem/claude-mem.db`) with sessions, memories, overviews
- **Archives**: Compressed transcript backups in `~/.claude-mem/archives/`

**Hook System** (`hook-templates/`)
- `user-prompt-submit.js`: Captures user prompts immediately, stores in ChromaDB
- `post-tool-use.js`: Spawns Agent SDK for async compression of tool responses
- `stop.js`: Generates session overview, cleans up SDK transcripts from UI
- `session-start.js`: Loads relevant context on startup and `/clear`
- Shared utilities: `hook-helpers.js`, `hook-prompt-renderer.js`, `config-loader.js`, `path-resolver.js`

**CLI Commands** (`src/commands/`)
- Installation, status, and diagnostics
- Memory storage and retrieval
- Changelog generation from memories
- Smart Trash™ management
- 15+ dynamic ChromaDB MCP tool wrappers

**Services** (`src/services/`)
- SQLite stores: Session, Memory, Overview, Diagnostics, TranscriptEvent
- Path discovery for project detection
- Rolling settings and logs

## 🔍 How Memory Search Works

**Semantic Search Best Practices**:
```typescript
// ALWAYS include project name to avoid cross-contamination
mcp__claude-mem__chroma_query_documents({
  collection_name: "claude_memories",
  query_texts: ["claude-mem authentication bug"],
  n_results: 10
})

// Include dates for temporal search (dates in query text, not metadata)
mcp__claude-mem__chroma_query_documents({
  collection_name: "claude_memories",
  query_texts: ["project-name 2025-10-02 feature implementation"],
  n_results: 5
})

// Intent-based queries work better than keyword matching
mcp__claude-mem__chroma_query_documents({
  collection_name: "claude_memories",
  query_texts: ["implementing oauth flow"],
  n_results: 10
})
```

**What Doesn't Work** (Avoid These!)
- ❌ Complex `where` filters with `$and`/`$or` - causes errors
- ❌ Timestamp comparisons (`$gte`, `$lt`) - stored as strings
- ❌ Mixing project filters in where clause - causes "Error finding id"

**Storage Collection**: `claude_memories`
- Metadata: `project`, `session_id`, `date`, `type`, `concepts`, `files`
- Embeddings: Semantic vectors for similarity search
- Documents: Atomic facts + full narrative with hierarchical structure

## ✅ Requirements

- Node.js >= 18.0.0
- Bun >= 1.0.0 (for development)
- Claude Code with MCP support
- macOS/Linux (POSIX-compliant)

## 🛠️ Development

```bash
# Development mode
bun run dev

# Build production bundle
bun run build

# Build and update hooks (RECOMMENDED for hook changes)
bun run build && bun link && claude-mem install --force

# Run tests
bun test                    # All tests
npm run test:integration    # Integration tests
bun run test:unit           # Unit tests only

# Install from source
bun run dev:install

# Live Memory Viewer
npm run memory-stream:server  # Start SSE server on :3001

# Code quality
bun run lint
bun run format
```

## 🎨 Live Memory Viewer

Real-time slideshow of memories with SSE streaming:

1. Start the server: `npm run memory-stream:server`
2. Open the viewer at `src/ui/memory-stream/`
3. Auto-connects to `~/.claude-mem/claude-mem.db`
4. New memories appear instantly as they're created

Features:
- 📡 Live SSE streaming from SQLite WAL changes
- 🎬 Auto-slideshow (5s intervals)
- ⏸️ Pause/Resume with Space bar
- ⌨️ Keyboard navigation (←/→)
- 🎨 Cyberpunk neural network aesthetic

## 🔑 Key Design Decisions

**Storage Architecture**
- Direct ChromaDB writes in `store-memory.ts` command (no async syncing)
- Each atomic fact stored as separate document + full narrative document
- Hierarchical metadata: project, session, date, type, concepts, files
- SQLite for fast metadata queries, ChromaDB for semantic search

**Hook Infrastructure**
- Streaming hooks (<50ms overhead) capture real-time events
- Shared utilities in `hook-templates/shared/` for consistency
- Force overwrite on install to ensure latest hook code deploys
- Milliseconds in `config.json`, seconds in Claude settings

**Memory Compression**
- Agent SDK spawned asynchronously for tool response compression
- User prompts stored immediately without blocking
- SDK transcripts auto-deleted to keep UI clean
- 100:1 compression ratio maintained

**Search Strategy**
- Semantic search via query text (dates embedded in queries)
- Avoid complex metadata filters (causes ChromaDB errors)
- Always include project name in queries for isolation
- Multiple query phrasings for better coverage

## 🆘 Troubleshooting

```bash
claude-mem status           # Check installation health
claude-mem doctor           # Run full diagnostics
claude-mem install --force  # Repair installation
claude-mem logs             # View recent operations
```

## 📄 License

AGPL-3.0 - See LICENSE file for details

---

**Remember more. Repeat less.** 🧠✨