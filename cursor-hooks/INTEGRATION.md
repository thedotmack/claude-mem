# Claude-Mem ↔ Cursor Integration Architecture

## Overview

This integration connects claude-mem's persistent memory system to Cursor's hook system, enabling:
- Automatic capture of agent actions (MCP tools, shell commands, file edits)
- Context retrieval from past sessions
- Session summarization for future reference

## Architecture

```
┌─────────────┐
│   Cursor    │
│   Agent     │
└──────┬──────┘
       │
       │ Events (MCP, Shell, File Edits, Prompts)
       │
       ▼
┌─────────────────────────────────────┐
│      Cursor Hooks System             │
│  ┌────────────────────────────────┐ │
│  │ beforeSubmitPrompt             │ │
│  │ afterMCPExecution              │ │
│  │ afterShellExecution            │ │
│  │ afterFileEdit                  │ │
│  │ stop                           │ │
│  └────────────────────────────────┘ │
└──────┬──────────────────────────────┘
       │
       │ HTTP Requests
       │
       ▼
┌─────────────────────────────────────┐
│   Hook Scripts (Bash)               │
│  ┌────────────────────────────────┐ │
│  │ session-init.sh               │ │
│  │ context-inject.sh             │ │
│  │ save-observation.sh          │ │
│  │ save-file-edit.sh             │ │
│  │ session-summary.sh            │ │
│  └────────────────────────────────┘ │
└──────┬──────────────────────────────┘
       │
       │ HTTP API Calls
       │
       ▼
┌─────────────────────────────────────┐
│   Claude-Mem Worker Service         │
│   (Port 37777)                      │
│  ┌────────────────────────────────┐ │
│  │ /api/sessions/init            │ │
│  │ /api/sessions/observations    │ │
│  │ /api/sessions/summarize       │ │
│  │ /api/context/inject          │ │
│  └────────────────────────────────┘ │
└──────┬──────────────────────────────┘
       │
       │ Database Operations
       │
       ▼
┌─────────────────────────────────────┐
│   SQLite Database                    │
│   + Chroma Vector DB                 │
└─────────────────────────────────────┘
```

## Event Flow

### 1. Prompt Submission Flow

```
User submits prompt
    ↓
beforeSubmitPrompt hook fires
    ↓
session-init.sh
    ├─ Extract conversation_id, project name
    ├─ POST /api/sessions/init
    └─ Initialize session in claude-mem
    ↓
context-inject.sh
    ├─ GET /api/context/inject?project=...
    └─ Fetch relevant context (for future use)
    ↓
Prompt proceeds to agent
```

### 2. Tool Execution Flow

```
Agent executes MCP tool or shell command
    ↓
afterMCPExecution / afterShellExecution hook fires
    ↓
save-observation.sh
    ├─ Extract tool_name, tool_input, tool_response
    ├─ Map to claude-mem observation format
    ├─ POST /api/sessions/observations
    └─ Store observation in database
```

### 3. File Edit Flow

```
Agent edits file
    ↓
afterFileEdit hook fires
    ↓
save-file-edit.sh
    ├─ Extract file_path, edits
    ├─ Create "write_file" observation
    ├─ POST /api/sessions/observations
    └─ Store file edit observation
```

### 4. Session End Flow

```
Agent loop ends
    ↓
stop hook fires
    ↓
session-summary.sh
    ├─ POST /api/sessions/summarize
    └─ Generate session summary for future retrieval
```

## Data Mapping

### Session ID Mapping

| Cursor Field | Claude-Mem Field | Notes |
|-------------|------------------|-------|
| `conversation_id` | `contentSessionId` | Stable across turns, used as primary session identifier |
| `generation_id` | (fallback) | Used if conversation_id unavailable |

### Tool Mapping

| Cursor Event | Claude-Mem Tool Name | Input Format |
|-------------|---------------------|--------------|
| `afterMCPExecution` | `tool_name` from event | `tool_input` as JSON |
| `afterShellExecution` | `"Bash"` | `{command: "..."}` |
| `afterFileEdit` | `"write_file"` | `{file_path: "...", edits: [...]}` |

### Project Mapping

| Source | Target | Notes |
|--------|--------|-------|
| `workspace_roots[0]` | Project name | Basename of workspace root directory |

## API Endpoints Used

### Session Management
- `POST /api/sessions/init` - Initialize new session
- `POST /api/sessions/summarize` - Generate session summary

### Observation Storage
- `POST /api/sessions/observations` - Store tool usage observation

### Context Retrieval
- `GET /api/context/inject?project=...` - Get relevant context for injection

### Health Checks
- `GET /api/readiness` - Check if worker is ready

## Configuration

### Worker Settings
Located in `~/.claude-mem/settings.json`:
- `CLAUDE_MEM_WORKER_PORT` (default: 37777)
- `CLAUDE_MEM_WORKER_HOST` (default: 127.0.0.1)

### Hook Settings
Located in `hooks.json`:
- Hook event names
- Script paths (relative or absolute)

## Error Handling

### Worker Unavailable
- Hooks poll `/api/readiness` with 30 retries (6 seconds)
- If worker unavailable, hooks fail gracefully (exit 0)
- Observations are fire-and-forget (curl errors ignored)

### Missing Data
- Empty `conversation_id` → use `generation_id`
- Empty `workspace_root` → use `pwd`
- Missing tool data → skip observation

### Network Errors
- All HTTP requests use `curl -s` (silent)
- Errors redirected to `/dev/null`
- Hooks always exit 0 to avoid blocking Cursor

## Limitations

1. **Context Injection**: Cursor's `beforeSubmitPrompt` doesn't support prompt modification. Context must be retrieved via:
   - MCP tools (claude-mem provides search tools)
   - Manual retrieval from web viewer
   - Future: Agent SDK integration

2. **Transcript Access**: Cursor hooks don't provide transcript paths, limiting summary quality compared to Claude Code integration.

3. **Session Model**: Uses `conversation_id` which may not perfectly match Claude Code's session model.

4. **Tab Hooks**: Currently only supports Agent hooks. Tab (inline completion) hooks could be added separately.

## Future Enhancements

- [ ] Enhanced context injection via MCP tools
- [ ] Support for `beforeTabFileRead` and `afterTabFileEdit` hooks
- [ ] Better error reporting and logging
- [ ] Integration with Cursor's agent SDK
- [ ] Support for blocking/approval workflows
- [ ] Real-time context injection via agent messages

## Testing

### Manual Testing

1. **Test session initialization**:
   ```bash
   echo '{"conversation_id":"test-123","workspace_roots":["/tmp/test"],"prompt":"test"}' | \
     ~/.cursor/hooks/session-init.sh
   ```

2. **Test observation capture**:
   ```bash
   echo '{"conversation_id":"test-123","hook_event_name":"afterMCPExecution","tool_name":"test","tool_input":{},"result_json":{}}' | \
     ~/.cursor/hooks/save-observation.sh
   ```

3. **Test context retrieval**:
   ```bash
   curl "http://127.0.0.1:37777/api/context/inject?project=test"
   ```

### Integration Testing

1. Enable hooks in Cursor
2. Submit a prompt
3. Execute some tools
4. Check web viewer: `http://localhost:37777`
5. Verify observations appear in database

## Troubleshooting

See [README.md](README.md#troubleshooting) for detailed troubleshooting steps.

