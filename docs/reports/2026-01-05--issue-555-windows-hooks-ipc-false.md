# Issue #555 Analysis: Windows Hooks Not Executing - hasIpc Always False

**Date:** 2026-01-05
**Version Analyzed:** 8.5.9
**Claude Code Version:** 2.0.76
**Platform:** Windows 11 (Build 26100), Git Bash (MINGW64)
**Status:** INVESTIGATION COMPLETE - Root cause identified

## Issue Summary

On Windows 11 with Git Bash, Claude-mem plugin hooks are not executing at all. While the worker service starts successfully and responds to health checks, no observations are being saved and no hook-related logs appear.

### Reported Symptoms

```json
// /api/health
{
  "status": "ok",
  "build": "TEST-008-wrapper-ipc",
  "managed": false,
  "hasIpc": false,
  "platform": "win32",
  "pid": 3596,
  "initialized": true,
  "mcpReady": true
}

// /api/stats
{
  "observations": 0,
  "sessions": 1
}
```

### Key Observations

1. Worker starts and responds correctly to HTTP requests
2. `hasIpc` is `false` (this is **expected behavior**, not a bug)
3. `observations` remains at `0` - no data being captured
4. No `[HOOK]` entries in worker logs - hooks never execute
5. This differs from issue #517 which was about PowerShell escaping

## Root Cause Analysis

### Primary Cause: Hook Commands Not Executing

The hooks defined in `plugin/hooks/hooks.json` are never being invoked by Claude Code on Windows.

### Understanding hasIpc

The `hasIpc` field is a **red herring** and is working as intended:

```typescript
// src/services/server/Server.ts:152
hasIpc: typeof process.send === 'function'
```

This checks if the worker process was spawned with an IPC channel (via `fork()` or `spawn()` with `stdio: 'ipc'`). Plugin hooks execute as independent command-line processes, NOT as forked child processes with IPC channels. Therefore, `hasIpc: false` is the **expected, normal behavior** for all hook executions.

### Actual Problem: Hook Command Execution Failure

The hooks.json uses Unix-style environment variable syntax:

```json
{
  "command": "bun \"${CLAUDE_PLUGIN_ROOT}/scripts/worker-service.cjs\" start"
}
```

**On Windows, this fails because:**

1. **Shell Interpreter Mismatch**: Claude Code on Windows likely uses `cmd.exe` or PowerShell to execute hook commands, not Git Bash. The `${VARIABLE}` syntax only works in Bash; cmd.exe uses `%VARIABLE%`.

2. **PATH Environment Differences**: The user runs Claude in Git Bash where `bun` and `node` are in PATH. However, Claude Code executes hooks in its own shell context (likely cmd.exe), which may not inherit Git Bash's PATH configuration.

3. **CLAUDE_PLUGIN_ROOT Resolution**: If Claude Code doesn't properly set or expand `CLAUDE_PLUGIN_ROOT` before executing the command, the entire path becomes invalid.

## Code Investigation Findings

### Affected Files

| File | Purpose | Issue |
|------|---------|-------|
| `plugin/hooks/hooks.json` | Hook command definitions | Uses `${CLAUDE_PLUGIN_ROOT}` Unix syntax |
| `plugin/scripts/smart-install.js` | Dependency installer | Executed via hooks.json, never runs on Windows |
| `plugin/scripts/worker-service.cjs` | Worker CLI | Executed via hooks.json, never runs on Windows |
| `plugin/scripts/*.js` | Hook scripts | None execute because hooks.json commands fail |

### hooks.json Analysis

Current hooks.json commands:

```json
{
  "SessionStart": [{
    "hooks": [
      { "command": "node \"${CLAUDE_PLUGIN_ROOT}/scripts/smart-install.js\"" },
      { "command": "bun \"${CLAUDE_PLUGIN_ROOT}/scripts/worker-service.cjs\" start" },
      { "command": "node \"${CLAUDE_PLUGIN_ROOT}/scripts/context-hook.js\"" }
    ]
  }],
  "PostToolUse": [{
    "hooks": [
      { "command": "bun \"${CLAUDE_PLUGIN_ROOT}/scripts/worker-service.cjs\" start" },
      { "command": "node \"${CLAUDE_PLUGIN_ROOT}/scripts/save-hook.js\"" }
    ]
  }]
}
```

**Problems identified:**

1. `${CLAUDE_PLUGIN_ROOT}` - Unix variable expansion, fails in cmd.exe
2. `bun` command - May not be in system PATH on Windows
3. `node` command - May not be in system PATH accessible to Claude Code

### Worker hasIpc Usage

The hasIpc field is used only for admin endpoint IPC messaging, which is a separate concern from hook execution:

```typescript
// src/services/server/Server.ts:209-216
const isWindowsManaged = process.platform === 'win32' &&
  process.env.CLAUDE_MEM_MANAGED === 'true' &&
  process.send;

if (isWindowsManaged) {
  process.send!({ type: 'restart' });
}
```

This IPC mechanism is for managed process scenarios and is unrelated to why hooks aren't executing.

## Relationship to Issue #517

| Aspect | Issue #517 | Issue #555 |
|--------|------------|------------|
| **Problem** | PowerShell `$_` variable misinterpreted by Bash | Hooks not executing at all |
| **Location** | ProcessManager.ts (worker internals) | hooks.json execution by Claude Code |
| **Fix Applied** | Replaced PowerShell with WMIC | N/A (new issue) |
| **Scope** | Worker process management | Claude Code hook invocation |

Issue #517 fixed internal worker operations (orphaned process cleanup). Issue #555 is a completely different layer - it's about Claude Code's plugin system failing to invoke hooks on Windows.

## Proposed Fix

### Option 1: Cross-Platform Wrapper Script (Recommended)

Create a platform-aware wrapper that handles path resolution:

```javascript
// plugin/scripts/hook-runner.js
#!/usr/bin/env node
const path = require('path');
const { spawn } = require('child_process');

// Resolve CLAUDE_PLUGIN_ROOT or compute from script location
const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT ||
  path.dirname(__dirname);

const hookScript = process.argv[2];
const hookPath = path.join(pluginRoot, 'scripts', hookScript);

// Execute the actual hook
require(hookPath);
```

Update hooks.json to use relative paths:

```json
{
  "command": "node ./scripts/hook-runner.js context-hook.js"
}
```

### Option 2: Windows-Specific hooks.json

Create a Windows-compatible version using `%CLAUDE_PLUGIN_ROOT%` syntax:

```json
{
  "command": "node \"%CLAUDE_PLUGIN_ROOT%\\scripts\\smart-install.js\""
}
```

**Drawback:** Requires maintaining two hooks.json versions or using conditional logic.

### Option 3: Use Absolute Paths

Generate hooks.json at install time with resolved absolute paths:

```json
{
  "command": "node \"C:\\Users\\username\\.claude\\plugins\\marketplaces\\thedotmack\\plugin\\scripts\\smart-install.js\""
}
```

**Drawback:** Less portable, requires install-time generation.

### Option 4: Ensure bun/node in System PATH

Add installation validation to ensure `bun` and `node` are in the system-wide PATH, not just Git Bash's PATH:

```powershell
# In smart-install.js for Windows
if (IS_WINDOWS) {
  // Add to system PATH if not present
  // Or use absolute paths to node/bun executables
}
```

## Debugging Steps for Users

1. **Verify plugin registration:**
   ```powershell
   claude /status
   ```

2. **Check plugin installation:**
   ```powershell
   dir $env:USERPROFILE\.claude\plugins\marketplaces\thedotmack\plugin\hooks
   ```

3. **Test environment variable:**
   ```powershell
   $env:CLAUDE_PLUGIN_ROOT = "$env:USERPROFILE\.claude\plugins\marketplaces\thedotmack\plugin"
   node "$env:CLAUDE_PLUGIN_ROOT\scripts\smart-install.js"
   ```

4. **Check if node/bun are in system PATH:**
   ```powershell
   where.exe node
   where.exe bun
   ```

5. **Enable Claude Code debug logging:**
   - Check Claude Code settings for debug/verbose mode
   - Look for hook execution errors in logs

## Impact Assessment

- **Severity:** High - Complete loss of memory functionality on Windows
- **Scope:** All Windows users, especially those using Git Bash
- **Workaround:** None currently - hooks must execute for memory to work
- **Affected Versions:** Likely affects 8.5.x on Windows with Claude Code 2.0.76+

## Recommended Actions

1. **Immediate:** Document the issue and potential workarounds
2. **Short-term:** Implement Option 1 (cross-platform wrapper script)
3. **Long-term:** Request clarification from Anthropic on Windows hook execution behavior
4. **Testing:** Add Windows CI/CD testing for hook execution

## Files to Modify

1. `plugin/hooks/hooks.json` - Update command syntax
2. `plugin/scripts/hook-runner.js` - New cross-platform wrapper (create)
3. `plugin/scripts/smart-install.js` - Add PATH validation for Windows
4. `docs/public/troubleshooting.mdx` - Document Windows hook issues

## Appendix: Technical Details

### Environment Variable Expansion by Shell

| Shell | Syntax | Works in hooks.json |
|-------|--------|---------------------|
| Bash | `${VAR}` or `$VAR` | Yes (if Bash executes) |
| cmd.exe | `%VAR%` | Yes (if cmd executes) |
| PowerShell | `$env:VAR` | Yes (if PS executes) |

### Claude Code Hook Execution Flow

1. Claude Code loads hooks.json from plugin directory
2. On hook event (SessionStart, PostToolUse, etc.), executes defined commands
3. Commands are executed via system shell (platform-dependent)
4. Hook process receives JSON via stdin, outputs response to stdout
5. Claude Code processes hook output

The failure occurs at step 3 when the shell cannot resolve the command or environment variables.
