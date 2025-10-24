# Plugin Hooks

Claude-Mem integrates with Claude Code through 5 lifecycle hooks that capture events and inject context.

## Hook Overview

| Hook Name           | Purpose                              | Timeout | Script                  |
|---------------------|--------------------------------------|---------|-------------------------|
| SessionStart        | Inject context from previous sessions| 120s    | context-hook.js         |
| UserPromptSubmit    | Create/track new sessions            | 120s    | new-hook.js             |
| PostToolUse         | Capture tool execution observations  | 120s    | save-hook.js            |
| Stop                | Generate session summaries           | 120s    | summary-hook.js         |
| SessionEnd          | Mark sessions complete               | 120s    | cleanup-hook.js         |

## Hook Configuration

Hooks are configured in `plugin/hooks/hooks.json`:

```json
{
  "description": "Claude-mem memory system hooks",
  "hooks": {
    "SessionStart": [{
      "hooks": [{
        "type": "command",
        "command": "cd \"${CLAUDE_PLUGIN_ROOT}/..\" && npm install --prefer-offline --no-audit --no-fund --loglevel=error && node ${CLAUDE_PLUGIN_ROOT}/scripts/context-hook.js",
        "timeout": 120
      }]
    }],
    "UserPromptSubmit": [{
      "hooks": [{
        "type": "command",
        "command": "node ${CLAUDE_PLUGIN_ROOT}/scripts/new-hook.js",
        "timeout": 120
      }]
    }],
    "PostToolUse": [{
      "matcher": "*",
      "hooks": [{
        "type": "command",
        "command": "node ${CLAUDE_PLUGIN_ROOT}/scripts/save-hook.js",
        "timeout": 120
      }]
    }],
    "Stop": [{
      "hooks": [{
        "type": "command",
        "command": "node ${CLAUDE_PLUGIN_ROOT}/scripts/summary-hook.js",
        "timeout": 120
      }]
    }],
    "SessionEnd": [{
      "hooks": [{
        "type": "command",
        "command": "node ${CLAUDE_PLUGIN_ROOT}/scripts/cleanup-hook.js",
        "timeout": 120
      }]
    }]
  }
}
```

## 1. SessionStart Hook (`context-hook.js`)

**Purpose**: Inject context from previous sessions into Claude's initial context.

**Behavior**:
- Ensures dependencies are installed (runs fast idempotent npm install)
- Auto-starts PM2 worker service if not running
- Retrieves last 10 session summaries with three-tier verbosity (v4.2.0)
- Returns context via `hookSpecificOutput` in JSON format (fixed in v4.1.0)

**Input** (via stdin):
```json
{
  "session_id": "claude-session-123",
  "cwd": "/path/to/project",
  "source": "startup"
}
```

**Output** (via stdout):
```json
{
  "hookSpecificOutput": "# Recent Sessions\n\n## Session 1...\n"
}
```

**Implementation**: `src/hooks/context.ts` and `src/bin/hooks/context-hook.ts`

## 2. UserPromptSubmit Hook (`new-hook.js`)

**Purpose**: Create new session records and initialize session tracking.

**Behavior**:
- Creates new session in database
- Initializes session tracking
- Saves raw user prompts for full-text search (as of v4.2.0)
- Sends init signal to worker service

**Input** (via stdin):
```json
{
  "session_id": "claude-session-123",
  "cwd": "/path/to/project",
  "prompt": "User's actual prompt text"
}
```

**Implementation**: `src/hooks/new.ts` and `src/bin/hooks/new-hook.ts`

## 3. PostToolUse Hook (`save-hook.js`)

**Purpose**: Capture tool execution observations.

**Behavior**:
- Fires after EVERY tool execution (Read, Write, Edit, Bash, etc.)
- Sends observations to worker service for processing
- Includes correlation IDs for tracing
- Filters low-value observations

**Input** (via stdin):
```json
{
  "session_id": "claude-session-123",
  "cwd": "/path/to/project",
  "tool_name": "Read",
  "tool_input": {...},
  "tool_result": "...",
  "correlation_id": "abc-123"
}
```

**Implementation**: `src/hooks/save.ts` and `src/bin/hooks/save-hook.ts`

## 4. Stop Hook (`summary-hook.js`)

**Purpose**: Generate session summaries when Claude stops.

**Behavior**:
- Triggers final summary generation
- Sends summarize request to worker service
- Summary includes: request, completed, learned, next_steps

**Input** (via stdin):
```json
{
  "session_id": "claude-session-123",
  "cwd": "/path/to/project",
  "source": "user_stop"
}
```

**Implementation**: `src/hooks/summary.ts` and `src/bin/hooks/summary-hook.ts`

## 5. SessionEnd Hook (`cleanup-hook.js`)

**Purpose**: Mark sessions as completed (graceful cleanup as of v4.1.0).

**Behavior**:
- Marks sessions as completed
- Skips cleanup on `/clear` commands to preserve ongoing sessions
- Allows workers to finish pending operations naturally
- Previously sent DELETE requests; now uses graceful completion

**Input** (via stdin):
```json
{
  "session_id": "claude-session-123",
  "cwd": "/path/to/project",
  "source": "normal"
}
```

**Implementation**: `src/hooks/cleanup.ts` and `src/bin/hooks/cleanup-hook.ts`

## Hook Development

### Adding a New Hook

1. Create hook implementation in `src/hooks/your-hook.ts`
2. Create entry point in `src/bin/hooks/your-hook.ts`
3. Add to `plugin/hooks/hooks.json`
4. Rebuild with `npm run build`

### Hook Best Practices

- **Fast execution**: Hooks should complete quickly (< 1s ideal)
- **Graceful degradation**: Don't block Claude if worker is down
- **Structured logging**: Use logger for debugging
- **Error handling**: Catch and log errors, don't crash
- **JSON output**: Use `hookSpecificOutput` for context injection

## Troubleshooting

See [Troubleshooting - Hook Issues](../troubleshooting.md#hook-issues) for common problems and solutions.
