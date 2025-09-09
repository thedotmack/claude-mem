# Claude Memory System (claude-mem)

**Truth + Context = Clarity**

A revolutionary memory system that transforms your Claude Code conversations into a persistent, intelligent knowledge base. Never lose valuable insights, code patterns, or debugging solutions again. Your AI assistant finally has a memory that spans across all your projects and sessions.

## 🚀 Why Claude-Mem?

### The Problem We Solve
- **Lost Context**: Starting every Claude Code session from scratch
- **Repeated Explanations**: Re-describing your codebase and architecture repeatedly  
- **Fragmented Knowledge**: Valuable insights scattered across hundreds of conversations
- **Context Switching**: Losing progress when switching between projects or devices
- **Knowledge Decay**: Brilliant solutions forgotten and re-discovered multiple times

### The Claude-Mem Solution
Transform your Claude Code experience from forgetful to persistent, from isolated sessions to connected knowledge, from starting over to building upon previous insights.

## ✨ Key Features

### 🧠 **Intelligent Memory Compression**
- Automatically extracts key learnings from your Claude Code conversations
- Identifies patterns, architectural decisions, and breakthrough moments
- Compresses hours of conversation into searchable, actionable knowledge
- Uses advanced AI analysis to understand context and significance

### 🔄 **Seamless Integration**
- **One-command setup**: `claude-mem install` and you're ready
- **Zero friction**: Works invisibly in the background
- **Automatic triggers**: Memory compression on `/compact` and `/clear`
- **Instant context loading**: New sessions start with relevant memories

### 🎯 **Smart Context Loading**
- Loads relevant memories when starting new sessions
- Project-aware context selection
- Semantic search finds related knowledge across all sessions
- Prevents re-explaining the same concepts repeatedly

### 📚 **Comprehensive Knowledge Base**
- Stores technical implementations, bug fixes, and solutions
- Captures design patterns and architectural decisions
- Remembers tool configurations and setup procedures
- Archives complete conversation transcripts for detailed reference

### 🔍 **Powerful Search & Retrieval**
- Vector-based semantic search finds related concepts
- Keyword search for specific terms and technologies
- Project filtering to focus on relevant memories
- Time-based filtering to find recent insights

## 🛠 Installation & Setup

### Prerequisites
- Node.js 18+ 
- Claude Code CLI installed
- uv (Python package manager) - automatically installed if missing

### Quick Install
```bash
# Install globally
npm install -g claude-mem

# Set up Claude Code integration (installs uv if needed)
claude-mem install

# Restart Claude Code to activate
```

### Alternative Installation
```bash
# Use without installing globally
npx claude-mem install
```

The `claude-mem install` command will automatically install [uv](https://docs.astral.sh/uv/) if it's not already present on your system. uv is required for the Chroma MCP server that powers the memory system.

### Verification
```bash
# Check installation status
claude-mem status
```

## 💻 How It Works

### The Memory Lifecycle

1. **🎬 Session Start**: Claude-mem loads relevant context from your knowledge base
2. **💬 Active Session**: You work normally in Claude Code - no changes needed
3. **🗜️ Memory Compression**: Use `/compact` or `/clear` to trigger intelligent compression
4. **🧠 Knowledge Extraction**: AI analysis extracts key learnings and patterns
5. **💾 Persistent Storage**: Memories stored in searchable vector database
6. **🔄 Context Ready**: Next session starts with relevant memories loaded

### Technical Architecture

- **Vector Database**: ChromaDB for semantic search and storage
- **MCP Integration**: Model Context Protocol for Claude Code communication
- **AI Analysis**: Advanced prompt engineering for knowledge extraction
- **Local Storage**: All data stored locally in `~/.claude-mem/`

## 📋 Commands Reference

### Core Commands
```bash
claude-mem install          # Set up Claude Code integration
claude-mem status           # Check system status and configuration
claude-mem load-context     # View and search stored memories
claude-mem logs             # View system logs and debug information
claude-mem uninstall       # Remove Claude Code hooks
```

### Advanced Usage
```bash
claude-mem compress <file>  # Manually compress a transcript file
claude-mem restore          # Restore from backups
claude-mem trash-view       # View deleted files (Smart Trash feature)
```

## 📁 Storage Structure

Your claude-mem data is organized in `~/.claude-mem/`:

```
~/.claude-mem/
├── index/           # ChromaDB vector database
├── archives/        # Original conversation transcripts  
├── hooks/           # Claude Code integration scripts
├── trash/           # Smart Trash (deleted files)
└── logs/            # System logs and debug information
```

## 🌟 Real-World Benefits

### For Individual Developers
- **Faster Problem Solving**: Find solutions you've used before instantly
- **Knowledge Accumulation**: Build expertise that persists across projects
- **Context Continuity**: Pick up where you left off, even weeks later
- **Pattern Recognition**: See how you've solved similar problems before

### For Teams (Coming Soon)
- **Shared Knowledge**: Team-wide memory accessible to all members
- **Onboarding Acceleration**: New team members access collective knowledge
- **Best Practices**: Capture and share proven solutions
- **Institutional Memory**: Prevent knowledge loss when team members leave

## 🚀 Coming Soon: Cloud Sync

### Individual Plan ($9.95/month)
- **Multi-device sync**: Access your memories on any device
- **Cloud backup**: Never lose your knowledge base
- **Enhanced search**: Advanced filtering and semantic search
- **API access**: Integrate with your own tools and workflows

### Team Plan ($29.95/month, 3+ seats)
- **Shared memories**: Team-wide knowledge base
- **Role-based access**: Control what memories are shared
- **Admin dashboard**: Manage team members and usage
- **Priority support**: Direct access to our engineering team

[**Join the waitlist**](https://claude-mem.ai) for early access to cloud features.

## 🛡️ Privacy & Security

- **Local-first**: All data stored locally by default
- **No tracking**: We don't collect or transmit your conversations
- **Your data**: You own and control your knowledge base
- **Open architecture**: ChromaDB and MCP are open standards

## 🆘 Troubleshooting

### Common Issues

**Hook not triggering?**
```bash
claude-mem status    # Check installation
claude-mem install --force   # Reinstall hooks
```

**Context not loading?**
```bash
claude-mem load-context   # Verify memories exist
claude-mem logs           # Check for errors
```

**Performance issues?**
```bash
# ChromaDB maintenance (if needed)
claude-mem status    # Check memory usage
```

## 🔧 Requirements

- **Node.js**: 18.0 or higher
- **Claude Code**: Latest version recommended
- **Storage**: ~100MB for typical usage
- **Memory**: 2GB RAM minimum for large knowledge bases

## 📞 Support & Community

- **Documentation**: Complete guides at [claude-mem.ai/docs](https://claude-mem.ai/docs)
- **Issues**: Report bugs at [GitHub Issues](https://github.com/thedotmack/claude-mem/issues)
- **Feature Requests**: [GitHub Discussions](https://github.com/thedotmack/claude-mem/discussions)
- **Community**: Join our [Discord](https://discord.gg/claude-mem) for tips and discussions

## 📄 License

This software is free to use but is NOT open source. See [LICENSE](LICENSE) file for complete terms.

---

## 🎯 Ready to Transform Your Claude Code Experience?

```bash
npm install -g claude-mem
claude-mem install
```

**Your AI assistant is about to get a lot smarter.** 🧠✨

---

*Built with ❤️ for developers who believe AI assistants should remember and learn from every conversation.*