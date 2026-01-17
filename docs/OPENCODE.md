# OpenCode Full Integration Guide

Complete guide for using claude-mem with [OpenCode.ai](https://opencode.ai) - includes automatic session tracking, observation capture, and context injection.

## Overview

This integration provides the **same full lifecycle hooks** as Claude Code:
- ✅ **SessionStart** - Initialize session in claude-mem
- ✅ **Tool Usage Tracking** - Capture all tool executions as observations
- ✅ **File Edit Tracking** - Record file modifications
- ✅ **Context Injection** - Auto-inject relevant memories at session start
- ✅ **Context Persistence** - Re-inject after context compaction
- ✅ **Session Summary** - Summarize and compress on session end

## Quick Install

Tell OpenCode:

```
Fetch and follow instructions from https://raw.githubusercontent.com/thedotmack/claude-mem/refs/heads/main/.opencode/INSTALL.md
```

**Or use the fork with network mode:**

```
Fetch and follow instructions from https://raw.githubusercontent.com/nycterent/claude-mem/refs/heads/main/.opencode/INSTALL.md
```

### Already have claude-mem installed?

```
Create directory ~/.config/opencode/plugin, then symlink /path/to/your/claude-mem/plugin/opencode/claude-mem.js to ~/.config/opencode/plugin/claude-mem.js, then restart opencode.
```

(Replace `/path/to/your/claude-mem` with your actual installation path)

## Prerequisites

- [OpenCode.ai](https://opencode.ai) installed
- Claude-mem repository cloned
- Node.js installed
- Claude-mem worker service running

## Installation Steps

### 1. Install Claude-Mem

If you haven't already:

```bash
git clone https://github.com/thedotmack/claude-mem.git ~/.claude-mem-source
cd ~/.claude-mem-source
npm install
npm run build-and-sync
```

### 2. Start the Worker

```bash
cd ~/.claude-mem-source
npm run worker:start
```

Verify it's running:

```bash
curl http://localhost:37777/api/health
# Should return: {"status":"ok"}
```

### 3. Install the OpenCode Plugin

#### Global Installation (Recommended)

```bash
mkdir -p ~/.config/opencode/plugin
ln -sf ~/.claude-mem-source/plugin/opencode/claude-mem.js \
  ~/.config/opencode/plugin/claude-mem.js
```

#### Project-Specific Installation

```bash
# In your OpenCode project
mkdir -p .opencode/plugin
ln -sf ~/.claude-mem-source/plugin/opencode/claude-mem.js \
  .opencode/plugin/claude-mem.js
```

### 4. Restart OpenCode

Restart OpenCode to load the plugin. Check logs:

```bash
opencode run "test" --print-logs --log-level DEBUG | grep claude-mem
```

You should see:

```
[claude-mem] Plugin loaded for project: your-project
[claude-mem] Connected to worker at http://localhost:37777
```

## Features

### 1. Automatic Session Tracking

When you start an OpenCode session, claude-mem automatically:
- Initializes a session record
- Assigns a unique session ID
- Links to your project

**No manual setup required** - just start coding!

### 2. Tool Usage Capture

Every tool OpenCode executes is captured as an observation:

```javascript
// OpenCode uses a tool
await client.file.read('/path/to/file')

// Claude-mem automatically records:
{
  type: "discovery",
  title: "Used read_file tool",
  text: {
    tool: "read_file",
    args: { path: "/path/to/file" },
    result: "..." // Truncated to 500 chars
  }
}
```

### 3. File Edit Tracking

File modifications are captured with diffs:

```javascript
// OpenCode edits a file
await client.file.write('/src/app.js', newContent)

// Claude-mem records:
{
  type: "change",
  title: "Edited /src/app.js",
  text: "File modified",
  file_path: "/src/app.js"
}
```

### 4. Context Injection

On your **first message** in a session, claude-mem:
1. Searches for relevant past work
2. Injects compressed context automatically
3. Updates as you work

**Example:**
```
You: "Fix the authentication bug"

[claude-mem automatically injects:]
# Claude-Mem Context

## Recent Work
- #1234: Fixed OAuth token refresh (2 days ago)
- #1156: Updated auth middleware (1 week ago)

---

You: "Fix the authentication bug"
```

### 5. Context Compaction Resilience

OpenCode compacts context in long sessions. Claude-mem:
- Detects `session.compacted` events
- Re-injects critical context automatically
- Maintains continuity across compression

### 6. Session Summarization

When you end a session:
- Claude-mem generates a summary
- Compresses observations into learnings
- Makes them searchable for future sessions

## Available Tools

The plugin provides 3 custom tools for manual memory queries:

### `search_memory`

Search past work and learnings.

```javascript
// In OpenCode
await tools.search_memory({
  query: "authentication implementation",
  limit: 10,
  project: "my-app",
  type: "bugfix"
})
```

**Parameters:**
- `query` (string, required): What to search for
- `limit` (number, optional): Number of results (default: 10)
- `project` (string, optional): Filter by project name
- `type` (string, optional): Filter by type (bugfix, feature, decision, discovery, refactor)

**Returns:** Index with observation IDs (~50-100 tokens per result)

### `timeline_memory`

Get chronological context around a specific observation.

```javascript
await tools.timeline_memory({
  anchor: 1234,
  depth_before: 2,
  depth_after: 2
})
```

**Parameters:**
- `anchor` (number, required): Observation ID
- `depth_before` (number, optional): Observations before (default: 2)
- `depth_after` (number, optional): Observations after (default: 2)

**Returns:** Timeline showing what happened before and after

### `get_memory_details`

Fetch full details for specific observations.

```javascript
await tools.get_memory_details({
  ids: [1234, 1235, 1236]
})
```

**Parameters:**
- `ids` (number[], required): Array of observation IDs from search

**Returns:** Full observation details

**⚠️ Token Warning:** Only use after filtering with `search_memory`!

## Recommended Workflow

Follow this 3-layer pattern for 10x token savings:

```javascript
// 1. Search for relevant topics (compact index)
const results = await tools.search_memory({
  query: "user authentication"
})

// 2. Get timeline around interesting results
const timeline = await tools.timeline_memory({
  anchor: results[0].id
})

// 3. Fetch full details ONLY for filtered IDs
const details = await tools.get_memory_details({
  ids: [results[0].id, results[1].id]
})
```

**Never fetch full details without filtering first!**

## Configuration

### Environment Variables

Control worker connection:

```bash
# Default: localhost:37777
export CLAUDE_MEM_WORKER_HOST=localhost
export CLAUDE_MEM_WORKER_PORT=37777
```

### Network Mode (Multi-Machine)

If OpenCode and claude-mem run on different machines:

**On claude-mem server:**

```bash
export CLAUDE_MEM_WORKER_BIND=0.0.0.0
export CLAUDE_MEM_WORKER_PORT=37777
npm run worker:start
```

**On OpenCode machine:**

```bash
export CLAUDE_MEM_WORKER_HOST=192.168.1.100
export CLAUDE_MEM_WORKER_PORT=37777
```

Then install the plugin normally.

## Plugin Architecture

### Hook Flow

```
┌─────────────────────────────────────────────────────────────┐
│                     OpenCode Session                        │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                  Claude-Mem OpenCode Plugin                 │
├─────────────────────────────────────────────────────────────┤
│  • session.created       → Initialize session in worker     │
│  • chat.message          → Inject context on first message  │
│  • tool.execute.after    → Capture tool usage               │
│  • file.edited           → Capture file modifications       │
│  • session.compacted     → Re-inject context                │
│  • session.deleted       → Summarize and cleanup            │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼ HTTP (localhost:37777)
┌─────────────────────────────────────────────────────────────┐
│                   Claude-Mem Worker Service                 │
├─────────────────────────────────────────────────────────────┤
│  • POST /api/sessions/init        - Create session          │
│  • POST /api/sessions/observations - Save observation       │
│  • GET  /api/context/inject        - Get relevant context   │
│  • POST /api/sessions/summarize    - Summarize session      │
│  • GET  /api/search                - Search past work       │
│  • GET  /api/timeline              - Get chronology         │
│  • POST /api/observations/batch    - Get full details       │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│              SQLite Database (~/.claude-mem/)               │
│  • Sessions, Observations, Summaries, Embeddings            │
└─────────────────────────────────────────────────────────────┘
```

### Event Handlers

| OpenCode Event | Claude-Mem Action |
|----------------|-------------------|
| `session.created` | Initialize session record |
| `chat.message` (first) | Inject relevant context |
| `tool.execute.after` | Save tool usage as observation |
| `file.edited` | Save file edit as observation |
| `session.compacted` | Re-inject context after compression |
| `session.deleted` | Generate summary, cleanup state |

## Comparison with Claude Code

| Feature | Claude Code | OpenCode (this plugin) |
|---------|-------------|------------------------|
| **Session Tracking** | ✅ SessionStart hook | ✅ session.created event |
| **Tool Usage Capture** | ✅ PostToolUse hook | ✅ tool.execute.after event |
| **File Edit Capture** | ✅ PostToolUse hook | ✅ file.edited event |
| **Context Injection** | ✅ SessionStart output | ✅ chat.message hook |
| **Context Persistence** | ✅ Auto-maintained | ✅ session.compacted re-injection |
| **Session Summary** | ✅ SessionEnd hook | ✅ session.deleted event |
| **Manual Search** | ✅ /mem-search skill | ✅ search_memory tool |
| **Hook Type** | Shell scripts (stdin/stdout) | JavaScript functions (async/await) |

**Both provide identical functionality with different mechanisms!**

## Troubleshooting

### Plugin Not Loading

**Check plugin file exists:**

```bash
ls -l ~/.config/opencode/plugin/claude-mem.js
```

**Check OpenCode logs:**

```bash
opencode run "test" --print-logs --log-level DEBUG | grep plugin
```

Look for:

```
service=plugin path=file:///.../claude-mem.js loading plugin
```

**Common issues:**
- Symlink broken → Re-create with absolute path
- Node.js not found → Install Node.js
- Plugin syntax error → Check console for errors

### Worker Not Connected

**Error:** `WARNING: Cannot connect to worker at http://localhost:37777`

**Solutions:**

1. **Start the worker:**
   ```bash
   cd ~/.claude-mem-source
   npm run worker:start
   ```

2. **Check worker is running:**
   ```bash
   curl http://localhost:37777/api/health
   ```

3. **Check logs:**
   ```bash
   tail -f ~/.claude-mem/logs/worker-service.log
   ```

4. **Kill and restart:**
   ```bash
   pkill -f worker-service
   npm run worker:start
   ```

### Sessions Not Initializing

**Check session creation:**

```bash
curl http://localhost:37777/api/sessions
```

**Manual initialization:**

```javascript
// In OpenCode, trigger manually:
await tools.search_memory({ query: "test" })
```

This will force session initialization.

### Context Not Injecting

**Verify context exists:**

```bash
curl "http://localhost:37777/api/context/inject?session_id=test&project=default"
```

**Check if already injected:**

Context only injects once per session. Restart OpenCode session to re-inject.

### Tools Not Available

**Verify plugin loaded:**

```bash
opencode run "list available tools" --print-logs
```

Should show: `search_memory`, `timeline_memory`, `get_memory_details`

**Reinstall plugin:**

```bash
rm ~/.config/opencode/plugin/claude-mem.js
ln -sf ~/.claude-mem-source/plugin/opencode/claude-mem.js \
  ~/.config/opencode/plugin/claude-mem.js
```

Restart OpenCode.

## Advanced Usage

### Project-Specific Memory

Each OpenCode project gets its own memory namespace:

```bash
# Project A sessions
cd ~/project-a
opencode
# Memory stored under project: "project-a"

# Project B sessions
cd ~/project-b
opencode
# Memory stored under project: "project-b"
```

Cross-project search:

```javascript
// Search all projects
await tools.search_memory({ query: "auth" })

// Filter by project
await tools.search_memory({ query: "auth", project: "project-a" })
```

### Custom Observation Types

The plugin auto-assigns types:
- `discovery` - Tool usage
- `change` - File edits

You can add more via worker API:

```javascript
await fetch('http://localhost:37777/api/sessions/observations', {
  method: 'POST',
  body: JSON.stringify({
    session_id: 'current-session-id',
    type: 'decision',
    title: 'Chose Redis for caching',
    text: 'After benchmarking...',
  })
})
```

### Privacy Controls

Use `<private>` tags in your messages:

```
<private>
This contains API keys and secrets.
Not stored in claude-mem.
</private>

This will be stored and searchable.
```

The plugin strips private content before saving.

## Performance

### Token Efficiency

**Without claude-mem:**
- Repeat context every session: ~5,000 tokens
- Re-explain decisions: ~2,000 tokens
- Re-search codebase: ~3,000 tokens
- **Total: 10,000 tokens per session**

**With claude-mem:**
- Auto-inject relevant context: ~500 tokens
- Search compressed memories: ~50-100 tokens per result
- **Total: 500-1,000 tokens per session**

**Savings: 90% token reduction for context**

### Observation Limits

- Tool results truncated to 500 chars
- File diffs truncated (full diff in database)
- Search returns IDs first (50-100 tokens each)
- Full details only when requested

## Migration

### From MCP-Only Setup

If you were using the `remote-mcp-wrapper.js`:

1. **Uninstall MCP config:**
   Remove from `~/.config/opencode/config.json`:
   ```json
   {
     "mcp": {
       "claude-mem-remote": { /* ... */ }
     }
   }
   ```

2. **Install plugin:**
   ```bash
   ln -sf ~/.claude-mem-source/plugin/opencode/claude-mem.js \
     ~/.config/opencode/plugin/claude-mem.js
   ```

3. **Restart OpenCode**

The plugin provides **all MCP tools plus automatic session tracking**.

### From Cursor

Sessions from Cursor are compatible:

```bash
# Search Cursor sessions from OpenCode
await tools.search_memory({ project: "cursor-project" })
```

All observations are cross-platform searchable.

## Development

### Plugin Source

Located at: `/path/to/claude-mem/plugin/opencode/claude-mem.js`

Edit and reload:

```bash
# Edit plugin
vim ~/.claude-mem-source/plugin/opencode/claude-mem.js

# Restart OpenCode (auto-reloads plugin)
```

### Debug Logging

Enable verbose logging:

```javascript
// In plugin, add console.log statements
console.log('[claude-mem]', 'Debug info:', data);
```

View logs:

```bash
opencode run "test" --print-logs --log-level DEBUG
```

### Testing

Test worker connectivity:

```bash
# In OpenCode
await tools.search_memory({ query: "test" })
```

Check database:

```bash
sqlite3 ~/.claude-mem/claude-mem.db "SELECT * FROM sessions ORDER BY id DESC LIMIT 5;"
```

## Getting Help

- **Documentation**: https://docs.claude-mem.ai
- **Issues**: https://github.com/thedotmack/claude-mem/issues
- **OpenCode Docs**: https://opencode.ai/docs/
- **Community**: https://discord.gg/claude-mem

## License

Claude-mem is open source. See LICENSE file for details.
