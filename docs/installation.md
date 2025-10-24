# Installation Guide

## Quick Start

Install Claude-Mem directly from the plugin marketplace:

```bash
/plugin marketplace add thedotmack/claude-mem
/plugin install claude-mem
```

That's it! The plugin will automatically:
- Download prebuilt binaries (no compilation needed)
- Install all dependencies (including PM2 and SQLite binaries)
- Configure hooks for session lifecycle management
- Set up the MCP search server
- Auto-start the worker service on first session

Start a new Claude Code session and you'll see context from previous sessions automatically loaded.

## System Requirements

- **Node.js**: 18.0.0 or higher
- **Claude Code**: Latest version with plugin support
- **PM2**: Process manager (bundled with plugin - no global install required)
- **SQLite 3**: For persistent storage (bundled)

## Advanced Installation

For development or testing, you can clone and build from source:

### Clone and Build

```bash
# Clone the repository
git clone https://github.com/thedotmack/claude-mem.git
cd claude-mem

# Install dependencies
npm install

# Build hooks and worker service
npm run build

# Worker service will auto-start on first Claude Code session
# Or manually start with:
npm run worker:start

# Verify worker is running
npm run worker:status
```

### Post-Installation Verification

#### 1. Automatic Dependency Installation

Dependencies are installed automatically during plugin installation. The SessionStart hook also ensures dependencies are up-to-date on each session start (this is fast and idempotent). Works cross-platform on Windows, macOS, and Linux.

#### 2. Verify Plugin Installation

Check that hooks are configured in Claude Code:
```bash
cat plugin/hooks/hooks.json
```

#### 3. Data Directory Location

v4.0.0+ stores data in `${CLAUDE_PLUGIN_ROOT}/data/`:
- Database: `${CLAUDE_PLUGIN_ROOT}/data/claude-mem.db`
- Worker port file: `${CLAUDE_PLUGIN_ROOT}/data/worker.port`
- Logs: `${CLAUDE_PLUGIN_ROOT}/data/logs/`

For development/testing, you can override:
```bash
export CLAUDE_MEM_DATA_DIR=/custom/path
```

#### 4. Check Worker Logs

```bash
npm run worker:logs
```

#### 5. Test Context Retrieval

```bash
npm run test:context
```

## Upgrading from v3.x

**BREAKING CHANGES - Please Read:**

v4.0.0 introduces breaking changes:

- **Data Location Changed**: Database moved from `~/.claude-mem/` to `${CLAUDE_PLUGIN_ROOT}/data/` (inside plugin directory)
- **Fresh Start Required**: No automatic migration from v3.x. You must start with a clean database
- **Worker Auto-Starts**: Worker service now starts automatically - no manual `npm run worker:start` needed
- **MCP Search Server**: 7 new search tools with full-text search and citations
- **Enhanced Architecture**: Improved plugin integration and data organization

See [CHANGELOG.md](../CHANGELOG.md) for complete details.

## Next Steps

- [Getting Started Guide](usage/getting-started.md) - Learn how Claude-Mem works automatically
- [MCP Search Tools](usage/search-tools.md) - Query your project history
- [Configuration](configuration.md) - Customize Claude-Mem behavior
