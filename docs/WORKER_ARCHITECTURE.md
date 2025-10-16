# Worker Process Architecture

This document explains how the SDK worker process is handled in both plugin and traditional installation modes.

## Overview

The worker is a critical background process that:
- Runs the Claude Agent SDK in a long-lived session
- Listens on a Unix socket for messages from hooks
- Processes tool observations in real-time
- Generates session summaries
- Stores observations and summaries in the database

## Architecture Diagram

```
┌─────────────────┐
│  Claude Code    │
│   (Main UI)     │
└────────┬────────┘
         │
         ├─ SessionStart Hook ──> context-hook.js
         │
         ├─ UserPromptSubmit ───> new-hook.js ──┐
         │                                       │
         │                                       ├──> Spawns Worker
         │                                       │    (Background Process)
         │                                       │
         ├─ PostToolUse Hook ───> save-hook.js ─┼──> Unix Socket
         │                                       │
         │                                       │    ┌──────────────┐
         │                                       └───>│ worker.js    │
         │                                            │              │
         │                                            │ - SDK Agent  │
         └─ Stop Hook ───────────> summary-hook.js ──┼─>- Socket Srv│
                                                      │ - Database   │
                                                      └──────────────┘
```

## Worker Lifecycle

### 1. Session Initialization (UserPromptSubmit)

When a user submits a prompt, `new-hook.js` is triggered:

```typescript
// 1. Check if session already exists
const existing = db.findActiveSDKSession(session_id);
if (existing) { /* already running */ }

// 2. Create new SDK session record
const sessionId = db.createSDKSession(session_id, project, prompt);

// 3. Spawn worker process
const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
if (pluginRoot) {
  // Plugin mode: use bundled worker
  spawn('bun', [`${pluginRoot}/scripts/hooks/worker.js`, sessionId]);
} else {
  // Traditional mode: use global CLI
  spawn('claude-mem', ['worker', sessionId]);
}
```

### 2. Worker Startup

The worker process starts and:
1. Loads session info from database
2. Creates Unix socket at `~/.claude-mem/sockets/session-{id}.sock`
3. Starts listening for messages
4. Initializes SDK agent with streaming input

### 3. Tool Observation Flow (PostToolUse)

Every time Claude uses a tool, `save-hook.js` is triggered:

```typescript
// 1. Find active SDK session
const session = db.findActiveSDKSession(session_id);

// 2. Connect to worker's Unix socket
const socketPath = getWorkerSocketPath(session.id);
const client = net.connect(socketPath);

// 3. Send observation message
client.write(JSON.stringify({
  type: 'observation',
  tool_name: 'Read',
  tool_input: '{"file_path": "/path/to/file"}',
  tool_output: '{"content": "..."}'
}));
```

The worker receives the message and:
1. Queues it in `pendingMessages`
2. Yields it to SDK agent via message generator
3. Receives agent's analysis
4. Parses and stores observations in database

### 4. Session Finalization (Stop)

When the session ends, `summary-hook.js` is triggered:

```typescript
// 1. Find active session
const session = db.findActiveSDKSession(session_id);

// 2. Send finalize message to worker
const client = net.connect(socketPath);
client.write(JSON.stringify({
  type: 'finalize'
}));
```

The worker:
1. Stops accepting new observations
2. Sends finalize prompt to SDK agent
3. Receives and parses session summary
4. Stores summary in database
5. Cleans up socket and exits

## Plugin vs Traditional Mode

### Plugin Mode (Self-Contained)

When installed as a plugin:
- `CLAUDE_PLUGIN_ROOT` environment variable is set by Claude Code
- Hooks use bundled scripts: `${CLAUDE_PLUGIN_ROOT}/scripts/hooks/`
- Worker is spawned as: `bun ${CLAUDE_PLUGIN_ROOT}/scripts/hooks/worker.js`
- **No global CLI installation required**

```bash
# Plugin mode execution
/plugin install claude-mem
# Hooks automatically use bundled worker
```

### Traditional Mode (Global CLI)

When installed via npm:
- `CLAUDE_PLUGIN_ROOT` is not set
- Hooks installed via `claude-mem install`
- Worker is spawned as: `claude-mem worker`
- **Requires global CLI installation**

```bash
# Traditional mode installation
npm install -g claude-mem
claude-mem install
```

## Worker Binary Size

The worker is the largest bundled script because it includes:
- Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`)
- Prompt templates and parsers
- Socket server implementation
- Database operations

**Size**: ~232 KB (minified)

This is acceptable because:
- Only spawned once per session (not per tool use)
- Runs in background (doesn't block UI)
- Contains full SDK functionality

## Worker Communication Protocol

### Message Types

#### 1. Observation Message
```json
{
  "type": "observation",
  "tool_name": "Read",
  "tool_input": "{\"file_path\": \"/path\"}",
  "tool_output": "{\"content\": \"...\"}"
}
```

#### 2. Finalize Message
```json
{
  "type": "finalize"
}
```

### Socket Protocol

- **Transport**: Unix domain socket
- **Format**: JSON messages separated by newlines (`\n`)
- **Location**: `~/.claude-mem/sockets/session-{id}.sock`
- **Lifecycle**: Created on worker startup, deleted on worker exit

## Error Handling

### Worker Startup Failures

If the worker fails to start:
- New-hook logs error but doesn't block Claude Code
- Session record remains in "pending" state
- No observations are captured (graceful degradation)

### Socket Communication Failures

If hooks can't connect to worker socket:
- Hook logs error but doesn't block Claude Code
- Tool use continues normally
- Observations are skipped for that session

### Worker Crashes

If the worker crashes mid-session:
- Database marks session as "failed"
- Socket is cleaned up automatically
- Next session will spawn new worker

## Testing

### Test Worker Directly

```bash
# Build the worker
npm run build:hooks

# Test worker (needs valid session ID in DB)
bun scripts/hooks/worker.js 123
```

### Test Worker Spawning

```bash
# Plugin mode (with CLAUDE_PLUGIN_ROOT)
CLAUDE_PLUGIN_ROOT=$(pwd) printf '{"session_id":"test","cwd":"/path","prompt":"help"}' | \
  bun scripts/hooks/new-hook.js

# Traditional mode (without CLAUDE_PLUGIN_ROOT)
printf '{"session_id":"test","cwd":"/path","prompt":"help"}' | \
  bun scripts/hooks/new-hook.js
```

### Monitor Worker Logs

Worker logs to stderr:
```bash
# Watch worker logs in real-time
tail -f ~/.claude-mem/logs/worker-*.log
```

## Benefits of This Architecture

1. **Self-contained**: Plugin bundles everything needed
2. **Backwards compatible**: Works with global CLI too
3. **Automatic detection**: Uses environment variable to choose mode
4. **Isolated execution**: Worker runs in separate process
5. **Async communication**: Hooks don't block on SDK operations
6. **Graceful degradation**: Failures don't break Claude Code

## Future Improvements

Potential enhancements:
- [ ] Worker health checks and auto-restart
- [ ] Multiple workers for concurrent sessions
- [ ] Worker pool management
- [ ] WebSocket support for remote workers
- [ ] Worker performance metrics

## See Also

- [Plugin Structure Documentation](./PLUGIN_STRUCTURE.md)
- [Plugin Development Guide](./PLUGIN_DEVELOPMENT.md)
- [Build Documentation](./BUILD.md)
