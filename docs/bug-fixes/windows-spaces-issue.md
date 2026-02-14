---
Title: Bug: SDK Agent fails on Windows when username contains spaces
---

## Bug Report

**Summary:** Claude SDK Agent fails to start on Windows when the user's path contains spaces (e.g., `C:\Users\Anderson Wang\`), causing PostToolUse hooks to hang indefinitely.

**Severity:** High - Core functionality broken

**Affected Platform:** Windows only

---

## Symptoms

PostToolUse hook displays `(1/2 done)` indefinitely. Worker logs show:

```
ERROR [SESSION] Generator failed {provider=claude, error=Claude Code process exited with code 1}
ERROR [SESSION] Generator exited unexpectedly
```

---

## Root Cause

Two issues in the Windows code path:

1. **`SDKAgent.ts`** - Returns full auto-detected path with spaces:
   ```
   C:\Users\Anderson Wang\AppData\Roaming\npm\claude.cmd
   ```

2. **`ProcessRegistry.ts`** - Node.js `spawn()` cannot directly execute `.cmd` files when the path contains spaces

---

## Proposed Fix

### File 1: `src/services/worker/SDKAgent.ts`

On Windows, prefer `claude.cmd` via PATH instead of full auto-detected path:

```typescript
// On Windows, prefer "claude.cmd" (via PATH) to avoid spawn issues with spaces in paths
if (process.platform === 'win32') {
  try {
    execSync('where claude.cmd', { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    return 'claude.cmd'; // Let Windows resolve via PATHEXT
  } catch {
    // Fall through to generic error
  }
}
```

### File 2: `src/services/worker/ProcessRegistry.ts`

Use `cmd.exe /d /c` wrapper for .cmd files on Windows:

```typescript
const useCmdWrapper = process.platform === 'win32' && spawnOptions.command.endsWith('.cmd');

if (useCmdWrapper) {
  child = spawn('cmd.exe', ['/d', '/c', spawnOptions.command, ...spawnOptions.args], {
    cwd: spawnOptions.cwd,
    env: spawnOptions.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    signal: spawnOptions.signal,
    windowsHide: true
  });
}
```

---

## Why This Works

- **PATHEXT Resolution:** Windows searches PATH and tries each extension in PATHEXT automatically
- **cmd.exe wrapper:** Properly handles paths with spaces and argument passing
- **Avoids shell parsing:** Using direct arguments instead of `shell: true` prevents empty string misparsing

---

## Testing

Verified on Windows 11 with username containing spaces:
- PostToolUse hook completes successfully
- Observations are stored to database
- No more "process exited with code 1" errors

---

## Additional Notes

- Maintains backward compatibility with `CLAUDE_CODE_PATH` setting
- No impact on non-Windows platforms
- Related to Issue #733 (credential isolation) - separate fix
