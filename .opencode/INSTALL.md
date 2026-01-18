# Claude-Mem for OpenCode

Persistent memory across OpenCode sessions, powered by claude-mem.

## Prerequisites

- Claude-Mem installed and worker running
- OpenCode installed

## Quick Verification

Check if claude-mem worker is running:
```bash
curl -s http://localhost:37777/health
```

If not running, the worker will auto-start when you use Claude Code. Alternatively:
```bash
cd ~/.claude/plugins/marketplaces/thedotmack/plugin && npm run worker:start
```

## Installation

### Option 1: Project-Level (Recommended for Development)

The plugin files are already in `.opencode/plugin/` in this repository. When you run OpenCode in this directory, the plugin loads automatically.

### Option 2: Global Installation

For use across all projects:

```bash
# Copy plugin to global OpenCode config
cp -r /path/to/claude-mem/.opencode/plugin/claude-mem.ts ~/.config/opencode/plugin/
cp /path/to/claude-mem/.opencode/package.json ~/.config/opencode/

# Install dependencies
cd ~/.config/opencode && bun install
```

## Verification

1. Start OpenCode in the claude-mem directory:
   ```bash
   cd /path/to/claude-mem && opencode
   ```

2. Verify context injection appears at session start

3. After using any tool, verify observation was captured:
   ```bash
   sqlite3 ~/.claude-mem/claude-mem.db "SELECT id, tool_name, created_at FROM observations ORDER BY id DESC LIMIT 3"
   ```

4. Test the mem_search tool:
   ```
   Use mem_search to find recent observations
   ```

## Features

- **Context Injection**: Previous session context automatically injected on session start
- **Observation Capture**: All tool usage is captured for future reference
- **Memory Search**: Query past observations with `mem_search` tool
- **Shared Database**: Same database as Claude Code - cross-platform memory

## Troubleshooting

### Worker not running
```bash
curl -s http://localhost:37777/health
# If no response, start the worker:
cd ~/.claude/plugins/marketplaces/thedotmack/plugin && npm run worker:start
```

### Plugin not loading
Check OpenCode logs for plugin errors. Ensure `@opencode-ai/plugin` is installed:
```bash
cd ~/.config/opencode && bun install
```

### No context appearing
Verify the database has observations for your project:
```bash
sqlite3 ~/.claude-mem/claude-mem.db "SELECT project, COUNT(*) FROM observations GROUP BY project"
```
