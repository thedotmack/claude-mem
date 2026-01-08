# Issue #590: Blank Terminal Window Pops Up on Windows When Chroma MCP Server Starts

**Date:** 2026-01-07
**Issue Author:** dwd898
**Severity:** Medium (UX disruption, not a functional failure)
**Status:** OPEN - Root cause confirmed, multiple solutions proposed

---

## 1. Executive Summary

On Windows 11, when claude-mem starts the Chroma MCP server via `uvx`, a blank terminal window (Windows Terminal / PowerShell) appears and does not close automatically. Users must manually close this window each time, which disrupts the workflow.

The root cause is that the MCP SDK's `StdioClientTransport` class does not pass the `windowsHide: true` option to the underlying `child_process.spawn()` call. While the claude-mem codebase attempts to set this option, it has no effect because the MCP SDK ignores it.

This issue affects all Windows users who have ChromaDB vector search enabled (the default configuration).

---

## 2. Problem Analysis

### 2.1 User-Reported Symptoms

- A blank terminal window appears when any action triggers Chroma initialization
- The window shows the `uvx.exe` path but contains no output
- The window remains open until manually closed by the user
- This occurs every time ChromaDB is initialized (typically once per Claude session)

### 2.2 Environment Details

| Component | Value |
|-----------|-------|
| OS | Windows 11 64-bit |
| Terminal | PowerShell 7.6.0-preview.6 |
| claude-mem version | 9.0.0 |
| uvx location | `C:\Users\Dell\AppData\Local\Microsoft\WinGet\Links\uvx.exe` |
| MCP SDK version | ^1.25.1 |

### 2.3 Trigger Conditions

The terminal popup occurs when:

1. Claude Code starts a new session with claude-mem enabled
2. A search query is executed with semantic search enabled
3. The ChromaSync service initializes for the first time in a session
4. Any backfill operation triggers Chroma connection

---

## 3. Technical Details

### 3.1 Affected Code Location

**File:** `/Users/alexnewman/conductor/workspaces/claude-mem/budapest/src/services/sync/ChromaSync.ts`

**Lines:** 106-124

```typescript
const transportOptions: any = {
  command: 'uvx',
  args: [
    '--python', pythonVersion,
    'chroma-mcp',
    '--client-type', 'persistent',
    '--data-dir', this.VECTOR_DB_DIR
  ],
  stderr: 'ignore'
};

// CRITICAL: On Windows, try to hide console window to prevent PowerShell popups
// Note: windowsHide may not be supported by MCP SDK's StdioClientTransport
if (isWindows) {
  transportOptions.windowsHide = true;
  logger.debug('CHROMA_SYNC', 'Windows detected, attempting to hide console window', { project: this.project });
}

this.transport = new StdioClientTransport(transportOptions);
```

### 3.2 Why windowsHide Fails

The `StdioClientTransport` class from `@modelcontextprotocol/sdk` accepts configuration options but does **not** forward `windowsHide` to `child_process.spawn()`. The SDK's transport implementation only uses a subset of spawn options:

- `command` - The executable to run
- `args` - Command line arguments
- `env` - Environment variables (optional)
- `stderr` - Stderr handling mode

The `windowsHide` option is silently ignored because it's not part of the SDK's expected interface.

### 3.3 MCP SDK Transport Architecture

```
ChromaSync.ts
    |
    v
StdioClientTransport (MCP SDK)
    |
    v
child_process.spawn() [internal to SDK]
    |
    v
uvx.exe subprocess
    |
    v
chroma-mcp Python process
```

The SDK controls the spawn call, so claude-mem cannot directly influence the spawn options.

### 3.4 Comparison with Other Subprocess Calls

Other parts of claude-mem successfully hide Windows console windows because they use `child_process.spawn()` directly:

| Component | File | Uses windowsHide | Works on Windows |
|-----------|------|------------------|------------------|
| ProcessManager | `ProcessManager.ts:271` | Yes (direct spawn) | Yes |
| SDKAgent | `SDKAgent.ts:379` | Yes (direct spawn) | Yes |
| BranchManager | `BranchManager.ts:61,88` | Yes (direct spawn) | Yes |
| shared/paths | `paths.ts:103` | Yes (direct spawn) | Yes |
| ChromaSync | `ChromaSync.ts:120` | Yes (via SDK - ignored) | **No** |

---

## 4. Impact Assessment

### 4.1 Affected Users

- All Windows users with ChromaDB enabled (default)
- Approximately 100% of Windows user base

### 4.2 Severity Breakdown

| Aspect | Impact |
|--------|--------|
| Functionality | No impact - Chroma works correctly |
| UX Disruption | Medium - Requires manual window close |
| Workflow Impact | Low - One-time per session |
| Data Integrity | None |
| Security | None |

### 4.3 Workaround Availability

**Current Workaround:** Users can manually close the terminal window. The Chroma process continues running in the background even after the window is closed.

---

## 5. Root Cause Analysis

### 5.1 Primary Cause

The MCP SDK's `StdioClientTransport` class does not implement support for the `windowsHide` spawn option. This is a limitation in the SDK, not a bug in claude-mem.

### 5.2 SDK Gap Analysis

The MCP SDK (version 1.25.1) provides a transport abstraction layer but does not expose all Node.js spawn options. The `StdioClientTransport` constructor signature accepts:

```typescript
interface StdioClientTransportOptions {
  command: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
  stderr?: 'inherit' | 'pipe' | 'ignore';
}
```

Notable missing options:
- `windowsHide`
- `detached`
- `cwd`
- `shell`

### 5.3 Historical Context

The claude-mem codebase has extensively addressed Windows console popup issues in other areas:

- **December 4, 2025:** Added `windowsHide` parameter to ProcessManager
- **December 17, 2025:** PR #378 standardized `windowsHide: true` across all direct spawn calls
- **Known Issue:** The comment in ChromaSync.ts (line 118) explicitly acknowledges this limitation

---

## 6. Recommended Solutions

### 6.1 Solution 1: PowerShell Wrapper (Recommended Short-Term)

**Approach:** Wrap the `uvx` command in a PowerShell invocation that hides the window.

**Implementation:**

```typescript
const transportOptions: any = {
  command: 'powershell',
  args: [
    '-WindowStyle', 'Hidden',
    '-Command',
    `uvx --python ${pythonVersion} chroma-mcp --client-type persistent --data-dir '${this.VECTOR_DB_DIR}'`
  ],
  stderr: 'ignore'
};
```

**Pros:**
- No SDK changes required
- Immediate fix possible
- Pattern already used in worker-cli.js (lines 1-19)

**Cons:**
- Adds PowerShell dependency (already required for Windows)
- Slightly more complex command construction
- PATH escaping considerations

**Estimated Effort:** 2-4 hours

### 6.2 Solution 2: Custom Transport Layer

**Approach:** Bypass `StdioClientTransport` and implement a custom transport using `child_process.spawn()` directly.

**Implementation:**

```typescript
import { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { spawn, ChildProcess } from 'child_process';

class WindowsHiddenStdioTransport implements Transport {
  private process: ChildProcess;

  constructor(options: TransportOptions) {
    this.process = spawn(options.command, options.args, {
      windowsHide: true,
      stdio: ['pipe', 'pipe', options.stderr === 'ignore' ? 'ignore' : 'pipe']
    });
  }
  // ... implement Transport interface
}
```

**Pros:**
- Full control over spawn options
- Clean, maintainable solution
- Reusable for other MCP clients

**Cons:**
- Requires implementing Transport interface
- Must handle stdin/stdout piping manually
- More complex error handling

**Estimated Effort:** 8-16 hours

### 6.3 Solution 3: Upstream SDK Enhancement

**Approach:** Request the MCP SDK team to add `windowsHide` support to `StdioClientTransport`.

**Implementation:**
1. Open issue on MCP SDK repository
2. Propose API extension: `spawnOptions?: Partial<SpawnOptions>`
3. Provide PR if accepted

**Pros:**
- Fixes the root cause
- Benefits all MCP SDK users on Windows
- No workarounds needed

**Cons:**
- Depends on external team
- Uncertain timeline
- May require SDK version bump

**Estimated Effort:** Variable (depends on upstream response)

### 6.4 Solution 4: VBS Wrapper Script

**Approach:** Use a Windows Script Host (VBS) file to launch the process silently.

**Implementation:**

Create `launch-chroma.vbs`:
```vbs
Set WshShell = CreateObject("WScript.Shell")
WshShell.Run "uvx --python 3.13 chroma-mcp --client-type persistent --data-dir " & DataDir, 0, False
```

**Pros:**
- Guaranteed hidden window
- Works on all Windows versions

**Cons:**
- Requires additional script file
- Complex path handling
- VBS is deprecated technology

**Estimated Effort:** 4-6 hours

---

## 7. Priority/Severity Assessment

### 7.1 Severity Matrix

| Factor | Rating | Justification |
|--------|--------|---------------|
| User Impact | Medium | Annoying but not blocking |
| Frequency | Low | Once per session |
| Workaround | Yes | Close window manually |
| Data Risk | None | No data loss or corruption |
| Security Risk | None | No security implications |

### 7.2 Recommended Priority

**Priority: P2 (Medium)**

This issue should be addressed in the next minor release but is not urgent enough to warrant an immediate patch release.

### 7.3 Recommendation

Implement **Solution 1 (PowerShell Wrapper)** as an immediate fix for the next release. Simultaneously, open an upstream issue for **Solution 3** to address the root cause in the MCP SDK.

---

## 8. Related Issues and Context

### 8.1 Related GitHub Issues

| Issue | Title | Relationship |
|-------|-------|--------------|
| #367 | Console windows appearing during hook execution | Similar root cause |
| #517 | PowerShell `$_` escaping in Git Bash | Windows shell escaping |
| #555 | Windows hooks IPC issues | Windows platform challenges |

### 8.2 Related PRs

| PR | Title | Relevance |
|----|-------|-----------|
| #378 | Windows stabilization | Added windowsHide to other spawn calls |
| #372 | Worker wrapper architecture | Similar Windows console hiding approach |

### 8.3 Documentation

- Windows Woes Report: `/docs/reports/2026-01-06--windows-woes-comprehensive-report.md`
- Windows Troubleshooting: https://docs.claude-mem.ai/troubleshooting/windows-issues

---

## 9. Testing Recommendations

### 9.1 Test Cases

1. **Basic functionality:** Verify Chroma starts correctly with proposed fix
2. **Window visibility:** Confirm no terminal window appears
3. **Process lifecycle:** Ensure Chroma process terminates on worker shutdown
4. **Error handling:** Verify errors are properly captured despite hidden window
5. **PATH variations:** Test with uvx in different PATH locations

### 9.2 Test Environments

- Windows 11 with PowerShell 7.x
- Windows 11 with PowerShell 5.1
- Windows 10 with PowerShell 5.1
- Windows with Git Bash as default shell

---

## 10. Appendix

### 10.1 Current ChromaSync Connection Flow

```
1. ChromaSync.ensureConnection() called
2. Check if already connected
3. Load Python version from settings
4. Detect Windows platform
5. Set windowsHide: true (ineffective)
6. Create StdioClientTransport with uvx command
7. Connect MCP client to transport
   -> POPUP APPEARS HERE
8. Mark as connected
```

### 10.2 PowerShell Command Pattern (from worker-cli.js)

The existing pattern for hidden PowerShell execution:

```typescript
const cmd = `Start-Process -FilePath '${escapedPath}' -ArgumentList '${args}' -WindowStyle Hidden`;
spawnSync("powershell", ["-Command", cmd], {
  stdio: "pipe",
  timeout: 10000,
  windowsHide: true
});
```

### 10.3 MCP SDK Source Reference

The StdioClientTransport implementation in `@modelcontextprotocol/sdk` uses:

```typescript
this._process = spawn(command, args, {
  env: this._env,
  stdio: ['pipe', 'pipe', stderr]
});
```

Note the absence of `windowsHide` in the spawn options.

---

## 11. Revision History

| Date | Author | Changes |
|------|--------|---------|
| 2026-01-07 | Claude Opus 4.5 | Initial report |
