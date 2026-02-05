# Plan: Remove Worker Start Calls - In-Process Architecture

## Problem Statement

Current architecture has problematic spawn patterns:
1. `hooks.json` calls `worker-service.cjs start` which spawns a daemon
2. Spawning is buggy on Windows - **HARD RULE: NO SPAWN**
3. `user-message` hook is deprecated
4. `smart-install` was supposed to chain: `smart-install && stop && context`

## Target Architecture

**NO SPAWN - Worker runs in-process within hook command**

```
SessionStart:
  smart-install && stop && context
```

Flow:
1. `smart-install` - Install dependencies if needed
2. `stop` - Kill any existing worker (clean slate)
3. `context` - Hook starts worker IN-PROCESS, becomes the worker

**Key insight:** The first hook that needs the worker **becomes** the worker. No spawn, no daemon. The hook process IS the worker process.

---

## Current vs Target hooks.json

### Current (BROKEN)
```json
"SessionStart": [
  { "hooks": [
    { "command": "node smart-install.js" },
    { "command": "bun worker-service.cjs start" },      // REMOVE - spawn
    { "command": "bun worker-service.cjs hook ... context" },
    { "command": "bun worker-service.cjs hook ... user-message" }  // REMOVE - deprecated
  ]}
]
```

### Target
```json
"SessionStart": [
  { "hooks": [
    { "command": "node smart-install.js && bun worker-service.cjs stop && bun worker-service.cjs hook claude-code context" }
  ]}
]
```

---

## Files Involved

| File | Changes |
|------|---------|
| `plugin/hooks/hooks.json` | Restructure to chained commands, remove start/user-message |
| `src/services/worker-service.ts` | `hook` case: start worker in-process if not running |
| `src/cli/handlers/*.ts` | May need adjustment for in-process execution |
| `src/shared/worker-utils.ts` | `ensureWorkerRunning()` → adapt for in-process |

---

## Phase 0: Documentation Discovery

### Available APIs

**From `src/services/infrastructure/HealthMonitor.ts`:**
- `isPortInUse(port): Promise<boolean>`
- `waitForHealth(port, timeoutMs): Promise<boolean>`
- `httpShutdown(port): Promise<void>`

**From `src/services/worker-service.ts`:**
- `WorkerService` class - the actual worker
- `stop` command - shuts down worker via HTTP
- `--daemon` case - starts WorkerService (currently only used after spawn)

**BANNED (spawn patterns):**
- ~~`spawnDaemon()`~~ - NO SPAWN
- ~~`fork()`~~ - NO SPAWN
- ~~`spawn()` with detached~~ - NO SPAWN

### Anti-Patterns
- **NO SPAWN** - Hard rule, Windows buggy
- No `restart` command - removed for same reason
- No detached processes

---

## Phase 1: Modify `hook` Case for In-Process Worker

### Location
`src/services/worker-service.ts:564-576`

### Current Code
```typescript
case 'hook': {
  const platform = process.argv[3];
  const event = process.argv[4];
  if (!platform || !event) {
    console.error('Usage: claude-mem hook <platform> <event>');
    process.exit(1);
  }
  const { hookCommand } = await import('../cli/hook-command.js');
  await hookCommand(platform, event);
  break;
}
```

### Target Code
```typescript
case 'hook': {
  const platform = process.argv[3];
  const event = process.argv[4];
  if (!platform || !event) {
    console.error('Usage: claude-mem hook <platform> <event>');
    process.exit(1);
  }

  // Check if worker already running (port in use = valid, another process has it)
  const portInUse = await isPortInUse(port);
  if (portInUse) {
    // Port in use - either healthy worker or something else
    // Proceed with hook via HTTP to existing worker
    const { hookCommand } = await import('../cli/hook-command.js');
    await hookCommand(platform, event);
    break;
  }

  // Port free - start worker IN THIS PROCESS (no spawn!)
  logger.info('SYSTEM', 'Starting worker in-process for hook');
  const worker = new WorkerService();

  // Start worker (non-blocking, returns when server listening)
  await worker.start();

  // Now execute hook logic - worker is running in this process
  // Can call handler directly (in-process) or via HTTP to self
  const { hookCommand } = await import('../cli/hook-command.js');
  await hookCommand(platform, event);

  // DON'T exit - this process IS the worker now
  // Worker stays alive serving requests
  break;
}
```

### Key Behavior
- If port in use → hook runs via HTTP to existing worker, then exits
- If port free → start worker in-process, run hook, process stays alive as worker

### Verification
- [ ] Stop worker, run hook command → should start worker and stay alive
- [ ] Worker already running, run hook command → should complete and exit
- [ ] `lsof -i :37777` shows hook process IS the worker

---

## Phase 2: Update hooks.json - Chained Commands

### Location
`plugin/hooks/hooks.json`

### Target Structure
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
            "command": "node \"${CLAUDE_PLUGIN_ROOT}/scripts/smart-install.js\" && bun \"${CLAUDE_PLUGIN_ROOT}/scripts/worker-service.cjs\" stop && bun \"${CLAUDE_PLUGIN_ROOT}/scripts/worker-service.cjs\" hook claude-code context",
            "timeout": 300
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
            "timeout": 60
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
            "timeout": 120
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
            "timeout": 120
          }
        ]
      }
    ]
  }
}
```

### Changes Summary
1. SessionStart: Chain `smart-install && stop && context` in single command
2. Remove `user-message` hook (deprecated)
3. Remove all separate `start` commands
4. Other hooks unchanged (just hook command, auto-starts if needed)

### Verification
- [ ] JSON valid: `cat plugin/hooks/hooks.json | jq .`
- [ ] No `start` command: `grep -c '"start"' plugin/hooks/hooks.json` = 0
- [ ] No `user-message`: `grep -c 'user-message' plugin/hooks/hooks.json` = 0

---

## Phase 3: Handle "Port In Use" Gracefully

### Scenario
Another process has port 37777 (not our worker). Hook should handle gracefully.

### Current Behavior
`ensureWorkerRunning()` polls for 15 seconds, then throws error.

### Target Behavior
If port in use but not healthy (not our worker):
- Hook is "valid" - don't block Claude Code
- Return graceful response (empty context, etc.)
- Log warning for debugging

### Location
`src/shared/worker-utils.ts:117-141`

### Changes
```typescript
export async function ensureWorkerRunning(): Promise<boolean> {
  const port = getWorkerPort();

  // Quick health check (2 seconds max)
  try {
    if (await isWorkerHealthy()) {
      await checkWorkerVersion();
      return true;  // Worker healthy
    }
  } catch (e) {
    // Not healthy
  }

  // Port might be in use by something else
  // Return false but don't throw - let caller decide
  logger.warn('SYSTEM', 'Worker not healthy, hook will proceed gracefully');
  return false;
}
```

### Handler Updates
Update handlers to handle `ensureWorkerRunning()` returning false:
```typescript
const workerReady = await ensureWorkerRunning();
if (!workerReady) {
  // Return graceful empty response
  return { output: '', exitCode: HOOK_EXIT_CODES.SUCCESS };
}
```

### Verification
- [ ] Start non-worker process on 37777, run hook → completes gracefully
- [ ] No 15-second hang when port blocked

---

## Phase 4: Remove Deprecated Code

### Remove `user-message` Handler (if unused elsewhere)
- [ ] Check if `user-message.ts` is used anywhere else
- [ ] Remove from `src/cli/handlers/index.ts` if safe
- [ ] Consider keeping file but removing from hooks.json only

### Remove `start` Command (optional)
The `start` command in worker-service.ts can stay for manual use:
```bash
bun worker-service.cjs start  # Manual start if needed
```
But it should NOT be called from hooks.json.

### Verification
- [ ] `npm run build` succeeds
- [ ] No references to removed handlers in hooks.json

---

## Phase 5: Update Handler `ensureWorkerRunning()` Calls

### Context
Each handler currently calls `ensureWorkerRunning()` which polls for 15 seconds.

With in-process architecture:
- If hook started worker in-process → worker is THIS process, no HTTP needed
- If worker already running → HTTP to existing worker

### Decision
**Keep handler calls** but modify `ensureWorkerRunning()` to:
1. Return quickly if port is in use (assume valid)
2. Return true if in-process worker (detect via global flag?)
3. Graceful false return instead of throwing

### Files
- `src/cli/handlers/context.ts:15`
- `src/cli/handlers/session-init.ts:15`
- `src/cli/handlers/observation.ts:14`
- `src/cli/handlers/summarize.ts:17`
- `src/cli/handlers/file-edit.ts:15`

### Verification
- [ ] Handlers don't hang on port-in-use scenarios
- [ ] In-process worker scenario works

---

## Phase 6: Final Verification

### Tests
- [ ] `bun test` - All tests pass
- [ ] `npm run build-and-sync` - Build succeeds

### Manual Tests

**Test 1: Clean Start**
```bash
bun plugin/scripts/worker-service.cjs stop
# Start new Claude Code session
# Verify: context hook starts worker in-process
# Verify: lsof -i :37777 shows the hook process
```

**Test 2: Worker Already Running**
```bash
bun plugin/scripts/worker-service.cjs stop
bun plugin/scripts/worker-service.cjs hook claude-code context &
# Wait for worker to start
bun plugin/scripts/worker-service.cjs hook claude-code observation
# Verify: observation hook exits after completing (doesn't stay alive)
```

**Test 3: Port Blocked**
```bash
bun plugin/scripts/worker-service.cjs stop
nc -l 37777 &  # Block port with netcat
bun plugin/scripts/worker-service.cjs hook claude-code context
# Verify: completes gracefully, doesn't hang
kill %1  # Clean up netcat
```

**Test 4: Full Session**
```bash
# Start fresh Claude Code session
# Do some work (creates observations)
# End session (Ctrl+C or /exit)
# Verify: summarize hook ran, observations saved
```

---

## Risk Assessment

| Risk | Mitigation |
|------|------------|
| Hook stays alive forever | Expected - it's the worker now |
| Multiple hooks compete for port | First one wins, others use HTTP |
| Graceful shutdown on session end | Stop command in chain handles this |
| Windows compatibility | No spawn = no Windows issues |

## Rollback Plan

If issues arise:
1. Restore hooks.json with separate start commands
2. Revert worker-service.ts hook case changes
3. No database changes to rollback
