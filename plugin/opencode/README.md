# Claude-Mem Plugin for OpenCode

Full lifecycle integration providing persistent memory across OpenCode sessions.

## Quick Install

```bash
# 1. Link plugin
ln -sf $(pwd)/claude-mem.js ~/.config/opencode/plugin/claude-mem.js

# 2. Start worker (from claude-mem root)
cd ../..
npm run worker:start

# 3. Restart OpenCode
```

## Features

- ✅ **Automatic session tracking** - No manual setup
- ✅ **Tool usage capture** - Records all tool executions
- ✅ **File edit tracking** - Captures modifications with diffs
- ✅ **Context injection** - Auto-loads relevant memories
- ✅ **Compaction resilience** - Survives context compression
- ✅ **Session summaries** - Compresses learnings automatically

## Tools Available

- `search_memory(query, ...)` - Search past work
- `timeline_memory(anchor, ...)` - Get chronological context
- `get_memory_details(ids)` - Fetch full observation details

## Full Documentation

See `/docs/OPENCODE.md` for complete installation, configuration, and troubleshooting guide.

## Verification

```bash
# Check plugin loaded
opencode run "test" --print-logs --log-level DEBUG | grep claude-mem
# Should see: [claude-mem] Plugin loaded for project: ...

# Check worker running
curl http://localhost:37777/api/health
# Should return: {"status":"ok"}

# Test in OpenCode
# In a session, try:
await tools.search_memory({ query: "test" })
```

## Requirements

- OpenCode.ai installed
- Claude-mem worker running (npm run worker:start)
- Node.js for plugin execution

## Network Mode

For multi-machine setups:

```bash
# On worker machine
export CLAUDE_MEM_WORKER_BIND=0.0.0.0
npm run worker:start

# On OpenCode machine
export CLAUDE_MEM_WORKER_HOST=192.168.1.100
# Then link plugin normally
```

## Architecture

```
OpenCode Session
    ↓ (events)
Plugin (claude-mem.js)
    ↓ (HTTP localhost:37777)
Worker Service
    ↓
SQLite Database
```

## Troubleshooting

### Plugin not loading
```bash
ls -l ~/.config/opencode/plugin/claude-mem.js
# If broken, recreate symlink with absolute path
```

### Worker not connected
```bash
cd /path/to/claude-mem
npm run worker:start
curl http://localhost:37777/api/health
```

### Tools not available
```bash
# Reinstall
rm ~/.config/opencode/plugin/claude-mem.js
ln -sf /absolute/path/to/claude-mem.js ~/.config/opencode/plugin/claude-mem.js
# Restart OpenCode
```

## License

Part of claude-mem. See main LICENSE file.
