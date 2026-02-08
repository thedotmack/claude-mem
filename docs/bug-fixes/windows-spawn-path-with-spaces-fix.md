# Bug Fix Report: Windows Spawn Path with Spaces

## Issue Summary

**Title:** Claude SDK Agent fails to start on Windows when username contains spaces

**Severity:** High - Core functionality broken (memory observations not being processed)

**Affected Platform:** Windows

**Environment:** Username with spaces (e.g., "Anderson Wang")

**Date Discovered:** 2025-02-07

**Date Fixed:** 2025-02-07

---

## Root Cause Analysis

### Symptom
PostToolUse hook displays `(1/2 done)` indefinitely, with worker logs showing:
```
ERROR [SESSION] Generator failed {provider=claude, error=Claude Code process exited with code 1}
ERROR [SESSION] Generator exited unexpectedly
```

### Investigation
1. The `findClaudeExecutable()` function returns a full path with spaces:
   ```
   C:\Users\Anderson Wang\AppData\Roaming\npm\claude.cmd
   ```

2. Node.js `spawn()` on Windows cannot directly execute `.cmd` files when the path contains spaces

3. The error occurs in two locations:
   - `src/services/worker/SDKAgent.ts` - Path resolution returns full path with spaces
   - `src/services/worker/ProcessRegistry.ts` - Process spawning doesn't handle Windows .cmd files correctly

4. Additional issue: Using `shell: true` causes Windows to misparse empty string arguments like `--setting-sources ""`

---

## Fix Applied

### File 1: `src/services/worker/SDKAgent.ts`

**Location:** Lines 418-467

**Change:** On Windows, prefer `claude.cmd` via PATH instead of full auto-detected path

**Before:**
```typescript
// 2. Try auto-detection
try {
  const claudePath = execSync(
    process.platform === 'win32' ? 'where claude' : 'which claude',
    { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }
  ).trim().split('\n')[0].trim();
  if (claudePath) return claudePath;
}
```

**After:**
```typescript
// On Windows, prefer "claude.cmd" (via PATH) to avoid spawn issues with spaces in paths
if (process.platform === 'win32') {
  // Verify claude is available via PATH first
  try {
    execSync('where claude.cmd', { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    return 'claude.cmd'; // Let Windows resolve via PATHEXT
  } catch {
    // Fall through to generic error below
  }
} else {
  try {
    const claudePath = execSync('which claude', {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
    if (claudePath) return claudePath;
  } catch (error) {
    // Fall through to generic error below
  }
}
```

### File 2: `src/services/worker/ProcessRegistry.ts`

**Location:** Lines 268-313

**Change:** Use `cmd.exe /d /c` wrapper for .cmd files on Windows

**Before:**
```typescript
const child = spawn(spawnOptions.command, spawnOptions.args, {
  cwd: spawnOptions.cwd,
  env: spawnOptions.env,
  stdio: ['pipe', 'pipe', 'pipe'],
  signal: spawnOptions.signal,
  windowsHide: true
});
```

**After:**
```typescript
// On Windows, .cmd files cannot be spawned directly due to path-with-spaces issues.
// Use cmd.exe /c wrapper with proper argument passing.
const useCmdWrapper = process.platform === 'win32' && spawnOptions.command.endsWith('.cmd');

let child;
if (useCmdWrapper) {
  // Wrap in cmd.exe /c but pass args directly to avoid shell parsing issues
  // This preserves argument boundaries (e.g., empty string values for --setting-sources)
  child = spawn('cmd.exe', ['/d', '/c', spawnOptions.command, ...spawnOptions.args], {
    cwd: spawnOptions.cwd,
    env: spawnOptions.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    signal: spawnOptions.signal,
    windowsHide: true
  });
} else {
  child = spawn(spawnOptions.command, spawnOptions.args, {
    cwd: spawnOptions.cwd,
    env: spawnOptions.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    signal: spawnOptions.signal,
    windowsHide: true
  });
}
```

---

## Technical Details

### Why `shell: true` didn't work
Using `shell: true` causes Windows cmd.exe to misparse empty string arguments. The SDK passes `--setting-sources ""` which gets incorrectly parsed when using shell mode, causing the next argument `--permission-mode` to be treated as the value for `--setting-sources`.

### Why `cmd.exe /d /c` works
- `/d` - Disable execution of AutoRun commands from registry (prevents unwanted side effects)
- `/c` - Carries out the command and then terminates
- Arguments are passed directly to the command, preserving boundaries (including empty strings)

### PATHEXT Resolution
By returning `claude.cmd` instead of a full path, Windows automatically:
1. Searches directories in PATH environment variable
2. Tries each extension in PATHEXT (including .cmd)
3. Executes the found command through the proper Windows subsystem

---

## Testing

### Verification Steps
1. Built the project with `npm run build`
2. Copied `worker-service.cjs` to installed plugin directory
3. Restarted worker with `bun run worker:restart`
4. Tested SDK query - successfully received assistant messages

### Test Command Used
```bash
bun -e "
import { query } from '@anthropic-ai/claude-agent-sdk';
// ... test code
"
```

### Expected Result
PostToolUse hook completes with `(2/2 done)` instead of hanging at `(1/2 done)`

### Database Impact
- Previously: 212 failed messages accumulating in queue
- After fix: Messages should process successfully

---

## Files Modified
- `src/services/worker/SDKAgent.ts` - Lines 418-467
- `src/services/worker/ProcessRegistry.ts` - Lines 268-313

## Related Issues
- Resolves Windows-specific spawn failure for users with spaces in username
- Maintains backward compatibility with `CLAUDE_CODE_PATH` setting (user-provided paths still work)

## Deployment Notes
After building, the following files need to be synced:
- `plugin/scripts/worker-service.cjs`

## Reporter
AI Assistant (Claude Code)

## Review Status
Ready for review
