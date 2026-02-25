# Hook Bugs Investigation & Fix Plan

## Problem Summary

Two open issues report hook failures affecting users on v10.4.0+:

### Issue #1215 — Stop hooks fail: `${CLAUDE_PLUGIN_ROOT}` not injected
- **Root cause**: Upstream Claude Code bug — `${CLAUDE_PLUGIN_ROOT}` is not set when Claude Code executes Stop hooks
- **Scope**: On macOS, only Stop hooks affected. On Linux (Claude Code v2.1.51), ALL hooks affected
- **Upstream refs**: `anthropics/claude-code#24529`, `anthropics/claude-code#27145`
- **Impact**: Session-end summarization and session-complete never run

### Issue #1220 — PostToolUse hooks crash on stdin
- **Bug 1**: `start` command exits 1 when stdin has data (every PostToolUse call sends stdin to all commands in the hook group, including `start` which doesn't need it)
- **Bug 2**: `observation` command crashes on payloads > ~350 bytes
- **Impact**: Every tool call produces 2x `PostToolUse:<tool> hook error` messages; observation data never processed

## Root Cause Analysis

### Issue #1215 (CLAUDE_PLUGIN_ROOT)
This is an **upstream Claude Code bug**, not a regression we introduced. The `${CLAUDE_PLUGIN_ROOT}` variable is supposed to be set by Claude Code's hook executor for all hook types, but Stop hooks don't receive it. Our hooks.json uses this variable in all commands:
```
node "${CLAUDE_PLUGIN_ROOT}/scripts/bun-runner.js" "${CLAUDE_PLUGIN_ROOT}/scripts/worker-service.cjs" ...
```
When not set, the path resolves to `/scripts/bun-runner.js` which doesn't exist.

### Issue #1220 (stdin crashes) — ROOT CAUSE IDENTIFIED

Three compounding code-level bugs:

**1. Missing `break` statements in switch — `src/services/worker-service.ts:1022-1204`**
Only the `hook` case (line 1142) has a `break`. All 7 other cases (`start`, `stop`, `restart`, `status`, `cursor`, `generate`, `clean`) rely on `process.exit()` to prevent fall-through. This is fragile — if any async operation throws before `process.exit()` is reached, execution falls through to the next case. For `start`, if `ensureWorkerStarted()` throws, it falls through into `stop` → `restart` → etc.

**2. Unhandled promise rejection — `src/services/worker-service.ts:1213`**
`main()` is called as `Hge && Fge()` (compiled) without a `.catch()`. The `ensureWorkerStarted()` function CAN throw — specifically via `getInstalledPluginVersion()` in `src/services/infrastructure/HealthMonitor.ts:132` which calls `readFileSync()` and can throw on non-ENOENT/EBUSY errors. An unhandled rejection causes Bun to exit with code 1 silently — matching the reported symptoms exactly.

**3. Redundant `start` command in hooks.json — `plugin/hooks/hooks.json:65`**
The PostToolUse hook group has a standalone `start` command that receives stdin it doesn't need. This is redundant because the `hook` case at `worker-service.ts:1101` already calls `ensureWorkerStarted()` internally. The extra `start` command adds latency (bun-runner.js waits up to 5s for stdin EOF via `collectStdin()`) and triggers the crash path described above.

**Why Bug 2 (large payloads) manifests at ~350 bytes:**
The same unhandled-rejection chain. When `ensureWorkerStarted()` inside the `hook` case throws before `hookCommand()` reads stdin, the process exits 1. Larger payloads affect the timing of stdin buffering vs. the concurrent HTTP health check calls, making the throw more likely to occur before stdin is fully consumed.

## Phases

### Phase 0: Documentation Discovery & Reproduction

**Tasks:**
1. Read Claude Code's hook documentation to understand the stdin contract:
   - Does Claude Code pass stdin to all commands in a hook group, or only specific ones?
   - Does Claude Code close stdin after writing, or leave it open?
   - What are the expected exit code semantics?

2. Check Claude Code upstream issues for any resolution on CLAUDE_PLUGIN_ROOT:
   - `anthropics/claude-code#24529`
   - `anthropics/claude-code#27145`

3. Reproduce issue #1220 locally:
   ```bash
   # Bug 1: start with stdin
   echo '{"tool_name":"Read","tool_response":"test"}' | bun plugin/scripts/worker-service.cjs start
   echo $?  # Expected: 1 (broken), should be: 0

   # Bug 2: observation with large payload
   python3 -c "import json; print(json.dumps({'tool_name':'Read','tool_response':'x'*400,'session_id':'test','cwd':'/tmp'}))" | bun plugin/scripts/worker-service.cjs hook claude-code observation
   echo $?  # Expected: 1 (broken), should be: 0
   ```

4. Check `bun-runner.js` stdin timeout behavior:
   ```bash
   # Time how long the start command takes through bun-runner
   time echo '{}' | node plugin/scripts/bun-runner.js plugin/scripts/worker-service.cjs start
   # If this takes ~5s, the collectStdin timeout is the bottleneck
   ```

**Verification:** Issue #1220 bugs reproduced locally with exact exit codes documented.

### Phase 1: Fix the three root causes (#1220)

**Fix 1: Add `break` statements to all switch cases**

File: `src/services/worker-service.ts:1022-1204`

Add `break` after every case in the switch statement. Currently only the `hook` case has one. Every other case relies on `process.exit()` which is fragile if the preceding async code throws.

```typescript
case 'start': {
  const success = await ensureWorkerStarted(port);
  if (success) {
    exitWithStatus('ready');
  } else {
    exitWithStatus('error', 'Failed to start worker');
  }
  break;  // ADD THIS
}

case 'stop': {
  // ...
  process.exit(0);
  break;  // ADD THIS (defensive, even after process.exit)
}
// ... same for restart, status, cursor, generate, clean
```

**Fix 2: Add `.catch()` to `main()` invocation**

File: `src/services/worker-service.ts:1213`

The compiled code calls `Fge()` (main) without error handling. Add a catch:

```typescript
if (isMainModule) {
  main().catch((error) => {
    logger.error('SYSTEM', 'Fatal error in main', {}, error instanceof Error ? error : undefined);
    process.exit(0);  // Exit 0: don't block Claude Code, don't leave Windows Terminal tabs open
  });
}
```

**Fix 3: Remove redundant `start` command from hook groups**

File: `plugin/hooks/hooks.json`

Remove the standalone `start` command from PostToolUse, UserPromptSubmit, and Stop hook groups. The `hook` case in worker-service.ts already calls `ensureWorkerStarted()` internally (line 1101), making the separate `start` command redundant. This also eliminates:
- The 5s stdin timeout delay in bun-runner.js `collectStdin()`
- The stdin-crash path entirely

Before:
```json
"PostToolUse": [{
  "matcher": "*",
  "hooks": [
    { "command": "... worker-service.cjs start", "timeout": 60 },
    { "command": "... worker-service.cjs hook claude-code observation", "timeout": 120 }
  ]
}]
```

After:
```json
"PostToolUse": [{
  "matcher": "*",
  "hooks": [
    { "command": "... worker-service.cjs hook claude-code observation", "timeout": 120 }
  ]
}]
```

Apply the same removal to UserPromptSubmit and Stop groups.

**Files to modify:**
- `src/services/worker-service.ts` — add break statements + .catch() on main()
- `plugin/hooks/hooks.json` — remove redundant `start` commands from PostToolUse, UserPromptSubmit, Stop

**Verification:**
```bash
# Bug 1 fixed — start no longer called from hooks, but also safe if called directly
echo '{"tool_name":"Read","tool_response":"test"}' | bun plugin/scripts/worker-service.cjs start
echo $?  # Should be 0

# Bug 2 fixed — observation handles large payloads
python3 -c "import json; print(json.dumps({'tool_name':'Read','tool_response':'x'*2000,'session_id':'test','cwd':'/tmp'}))" | bun plugin/scripts/worker-service.cjs hook claude-code observation
echo $?  # Should be 0

# No error messages in Claude Code UI during normal tool use
```

### Phase 2: Workaround for CLAUDE_PLUGIN_ROOT (#1215)

Since this is an upstream Claude Code bug, our options are limited:

**Option 1: Resolve paths at Setup time (preferred)**
In the `Setup` hook (which DOES receive CLAUDE_PLUGIN_ROOT), write the resolved path to a file:
```bash
# In setup.sh
echo "${CLAUDE_PLUGIN_ROOT}" > ~/.claude-mem/.plugin-root
```
Then in bun-runner.js, fall back to reading this file when CLAUDE_PLUGIN_ROOT is empty.

**Option 2: Self-resolve using __dirname**
The scripts know their own location on disk. Instead of relying on CLAUDE_PLUGIN_ROOT, resolve the plugin root from the script's own path:
```javascript
const PLUGIN_ROOT = path.resolve(__dirname, '..');
```
Then use this instead of the environment variable.

**Option 3: Document the workaround**
Add to README/docs: users can run `sed` to replace `${CLAUDE_PLUGIN_ROOT}` with absolute paths in hooks.json.

**Files to modify:**
- `plugin/scripts/bun-runner.js` — add PLUGIN_ROOT self-resolution fallback
- `plugin/hooks/hooks.json` — potentially use self-resolving paths
- Docs — document the upstream issue and workaround

**Anti-patterns to avoid:**
- Don't hardcode absolute paths in hooks.json (varies per installation)
- Don't remove CLAUDE_PLUGIN_ROOT usage entirely (it works on most platforms)

**Verification:**
```bash
# Simulate missing CLAUDE_PLUGIN_ROOT
unset CLAUDE_PLUGIN_ROOT
node plugin/scripts/bun-runner.js plugin/scripts/worker-service.cjs start
echo $?  # Should be 0 (falls back to self-resolved path)
```

### Phase 3: Verification & Testing

1. Run existing hook tests:
   ```bash
   npm test -- --grep "hook"
   ```

2. Verify all 5 hook types work end-to-end:
   - SessionStart: context injection
   - UserPromptSubmit: session-init
   - PostToolUse: observation (small AND large payloads)
   - Stop: summarize + session-complete (if CLAUDE_PLUGIN_ROOT is available)

3. Check for regressions:
   - No error messages in Claude Code UI during normal operation
   - Observations are stored correctly
   - Worker starts reliably

4. Build and verify:
   ```bash
   npm run build-and-sync
   ```

**Anti-patterns to avoid:**
- Don't suppress errors that indicate real bugs (the stderr suppression from PR #1214 may be hiding issues)
- Don't add try/catch blocks that swallow errors silently during development
