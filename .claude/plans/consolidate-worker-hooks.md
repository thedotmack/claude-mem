# Consolidate Worker Hooks Plan

## Vision

Keep Bun runtime. Consolidate the separate `start` commands into the `hook` command itself, so each lifecycle event only needs one command instead of two.

**Before:**
```json
{ "command": "bun worker-service.cjs start" },
{ "command": "bun worker-service.cjs hook claude-code observation" }
```

**After:**
```json
{ "command": "bun worker-service.cjs hook claude-code observation" }
```

## Benefits

1. **Simpler hooks.json** - one command per lifecycle, no separate `start` commands
2. **Fewer process spawns** - half the commands (4 instead of 8)
3. **Cleaner architecture** - hook command is self-sufficient

## Implementation Phases

### Phase 1: Modify worker-service.ts hook command

**File**: `src/services/worker-service.ts`

Add startup logic to the `hook` case so it ensures worker is running before processing:

```typescript
case 'hook': {
  const platform = process.argv[3];
  const event = process.argv[4];
  if (!platform || !event) {
    console.error('Usage: worker-service hook <platform> <event>');
    process.exit(1);
  }

  // Ensure worker is running before processing hook
  const workerReady = await ensureWorkerReadyForHook(port);
  if (!workerReady) {
    logger.error('SYSTEM', 'Worker not ready, hook cannot proceed');
    process.exit(0); // Exit 0 per Windows Terminal strategy
  }

  const { hookCommand } = await import('../cli/hook-command.js');
  await hookCommand(platform, event);
  break;
}
```

Add helper function `ensureWorkerReadyForHook()` that:
1. Quick health check (1s)
2. Version mismatch detection and auto-restart
3. Spawn daemon if not running
4. Wait for health (30s timeout)

### Phase 2: Update hooks.json

**File**: `plugin/hooks/hooks.json`

Remove all `start` commands, keep only `hook` commands:

```json
{
  "description": "Claude-mem memory system hooks",
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup|clear|compact",
        "hooks": [
          {
            "type": "command",
            "command": "node \"${CLAUDE_PLUGIN_ROOT}/scripts/smart-install.js\"",
            "timeout": 300
          },
          {
            "type": "command",
            "command": "bun \"${CLAUDE_PLUGIN_ROOT}/scripts/worker-service.cjs\" hook claude-code context",
            "timeout": 120
          },
          {
            "type": "command",
            "command": "bun \"${CLAUDE_PLUGIN_ROOT}/scripts/worker-service.cjs\" hook claude-code user-message",
            "timeout": 60
          }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "bun \"${CLAUDE_PLUGIN_ROOT}/scripts/worker-service.cjs\" hook claude-code session-init",
            "timeout": 120
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "bun \"${CLAUDE_PLUGIN_ROOT}/scripts/worker-service.cjs\" hook claude-code observation",
            "timeout": 180
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "bun \"${CLAUDE_PLUGIN_ROOT}/scripts/worker-service.cjs\" hook claude-code summarize",
            "timeout": 180
          }
        ]
      }
    ]
  }
}
```

**Key changes:**
- Remove all `bun ... start` commands
- Keep Bun runtime for hook commands
- Remove test hooks (TEST-3)
- Increase timeouts to account for startup time

### Phase 3: Testing

1. **Build verification**:
   - [ ] `npm run build` succeeds

2. **Integration testing**:
   - [ ] Kill worker, start new Claude Code session
   - [ ] SessionStart hook works (worker starts, context injected)
   - [ ] UserPromptSubmit hook works
   - [ ] PostToolUse hook works
   - [ ] Stop hook works

## Files Changed

| File | Change Type | Description |
|------|-------------|-------------|
| `src/services/worker-service.ts` | Modify | Add startup logic to hook command |
| `plugin/hooks/hooks.json` | Modify | Remove start commands |

## Exit Code Strategy

Per CLAUDE.md:
- **Exit 0**: Success or graceful shutdown (Windows Terminal closes tabs)
- **Exit 1**: Non-blocking error (stderr shown)
- **Exit 2**: Blocking error (passed to Claude)

Worker startup failures exit 0 to prevent Windows Terminal tab accumulation.
