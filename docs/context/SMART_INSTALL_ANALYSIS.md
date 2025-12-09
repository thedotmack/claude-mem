# Claude-Mem Smart Install & Plugin Hooks - Comprehensive Analysis

**Generated:** 2025-12-09
**Scope:** Smart install system, all plugin hooks, cross-platform compatibility, error handling, edge cases

---

## Executive Summary

This report provides a comprehensive analysis of claude-mem's smart install system and plugin hook infrastructure. The analysis focuses on cross-platform compatibility, error handling patterns, artificial blockers, and edge case handling.

**Key Findings:**
- ✅ Overall architecture is well-designed with clear separation of concerns
- ⚠️ Multiple cross-platform compatibility issues identified
- ⚠️ Several silent failure patterns that hinder debugging
- ⚠️ Artificial blockers that could prevent legitimate use cases
- ⚠️ Inconsistent timeout values across different components
- ✅ No nested try-catch anti-patterns found

---

## Architecture Overview

### Smart Install System Flow

```
User Invokes Hook
    ↓
ensureWorkerRunning() [worker-utils.ts]
    ↓
isWorkerHealthy() → fetch /health endpoint
    ↓
    ├─ [HEALTHY] → Continue
    └─ [UNHEALTHY] → startWorker()
        ↓
        ├─ [Windows] → PowerShell Start-Process (hidden window)
        └─ [Unix] → PM2 start ecosystem.config.cjs
            ↓
        Wait for health check (15 retries × 1000ms)
            ↓
            ├─ [SUCCESS] → Continue
            └─ [FAILURE] → Throw error with manual recovery instructions
```

### Plugin Hook Lifecycle

1. **SessionStart** (context-hook.ts + user-message-hook.ts)
   - context-hook: Fetches context via HTTP/curl
   - user-message-hook: Displays context to user via stderr

2. **UserPromptSubmit** (new-hook.ts)
   - Creates/retrieves SDK session
   - Strips privacy tags from prompt
   - Initializes session via HTTP

3. **PostToolUse** (save-hook.ts)
   - Filters skipped tools
   - Sends observation to worker via HTTP

4. **Stop** (summary-hook.ts)
   - Parses transcript JSONL
   - Extracts last user/assistant messages
   - Requests summary generation via HTTP

5. **SessionEnd** (cleanup-hook.ts)
   - Marks session complete
   - Fire-and-forget HTTP request

---

## Cross-Platform Compatibility Issues

### 🔴 CRITICAL: curl Dependency (context-hook.ts)

**Location:** `src/hooks/context-hook.ts:32`

```typescript
const result = execSync(`curl -s "${url}"`, { encoding: "utf-8", timeout: 5000 });
```

**Issues:**
1. **Windows Compatibility:** curl is not guaranteed to be available on Windows systems (though included in Windows 10 1803+, it may be missing on older systems or custom installations)
2. **Error Handling:** No try-catch around execSync - will throw unhandled exception if curl fails
3. **Redundancy:** Uses curl when JavaScript's native `fetch` is already used everywhere else in the codebase

**Impact:** High - SessionStart hook will crash if curl is unavailable or returns non-zero exit code

**Edge Cases:**
- Corporate proxies blocking curl
- Systems without curl in PATH
- curl returning non-zero exit with valid output (warnings, etc.)

**Recommendation:**
```typescript
// Replace curl with fetch (already used in user-message-hook.ts)
const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
const result = await response.text();
```

---

### 🟡 MEDIUM: Platform-Specific Process Spawning (worker-utils.ts)

**Location:** `src/shared/worker-utils.ts:55-93`

**Windows Implementation:**
```typescript
spawnSync('powershell.exe', [
  '-NoProfile',
  '-NonInteractive',
  '-Command',
  `Start-Process -FilePath 'node' -ArgumentList '${workerScript}' -WorkingDirectory '${MARKETPLACE_ROOT}' -WindowStyle Hidden`
])
```

**Issues:**
1. **PowerShell Dependency:** Assumes PowerShell is available and in PATH
2. **Command Injection Risk:** Worker script path inserted directly into command string without escaping
3. **Process Monitoring:** Windows approach launches detached process with no PM2 monitoring - harder to debug/restart
4. **Health Check Timeout:** Comment says "Windows needs longer timeouts" but timeout is same for all platforms (500ms)

**Edge Cases:**
- Windows systems with PowerShell execution policy restrictions
- Paths containing single quotes or special characters
- Windows subsystem for Linux (WSL) environments
- Wine/Proton compatibility layers

**Unix Implementation:**
```typescript
const localPm2Base = path.join(MARKETPLACE_ROOT, 'node_modules', '.bin', 'pm2');
const pm2Command = existsSync(localPm2Base) ? localPm2Base : 'pm2';
```

**Issues:**
1. **PM2 Dependency:** Falls back to global pm2 if local not found, but doesn't verify it exists
2. **Silent Failure:** If PM2 not installed globally, spawnSync will fail with cryptic ENOENT error

**Recommendation:**
- Add pm2 existence check before spawn
- Implement consistent process monitoring across platforms
- Add path escaping for Windows command construction
- Actually implement longer timeout for Windows if needed

---

### 🟡 MEDIUM: Git Dependency (paths.ts)

**Location:** `src/shared/paths.ts:89-97`

```typescript
export function getCurrentProjectName(): string {
  try {
    const gitRoot = execSync('git rev-parse --show-toplevel', {
      cwd: process.cwd(),
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore']
    }).trim();
    return basename(gitRoot);
  } catch {
    return basename(process.cwd());
  }
}
```

**Issues:**
1. **Git Assumption:** Assumes git is installed and available in PATH
2. **Non-Git Projects:** Silently falls back to cwd basename, but this behavior is undocumented

**Edge Cases:**
- Projects not using git
- Monorepos where cwd !== git root is desired
- Systems without git installed

**Status:** ✅ Already handled with fallback, but could benefit from debug logging

---

## Error Handling Analysis

### 🔴 CRITICAL: Silent Failures Without Logging

#### 1. Settings File Loading (early-settings.ts:20-28)

```typescript
try {
  if (existsSync(SETTINGS_PATH)) {
    const data = JSON.parse(readFileSync(SETTINGS_PATH, 'utf-8'));
    const fileValue = data.env?.[key];
    if (fileValue !== undefined) return fileValue;
  }
} catch {
  // Fail silently - fall through to env var
}
```

**Problem:**
- Invalid JSON in settings file fails silently
- File read permission errors fail silently
- Users have no way to know their settings file is being ignored

**Impact:** High - Users may think settings are applied when they're actually using defaults

**Recommendation:**
```typescript
} catch (error) {
  logger.warn('SETTINGS', 'Failed to load settings file', { path: SETTINGS_PATH }, error);
}
```

---

#### 2. Worker Startup Failure (worker-utils.ts:104-107)

```typescript
try {
  // ... worker startup logic ...
} catch (error) {
  // Failed to start worker
  return false;
}
```

**Problem:**
- Catches ALL errors during worker startup
- Returns boolean with no information about what failed
- User only gets generic error after all retries exhausted

**Impact:** High - Makes debugging worker startup issues extremely difficult

**Recommendation:**
```typescript
} catch (error) {
  logger.error('WORKER', 'Failed to start worker', {}, error as Error);
  return false;
}
```

---

#### 3. Worker Health Check (worker-utils.ts:30-40)

```typescript
async function isWorkerHealthy(): Promise<boolean> {
  try {
    const port = getWorkerPort();
    const response = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(HEALTH_CHECK_TIMEOUT_MS)
    });
    return response.ok;
  } catch {
    return false;
  }
}
```

**Problem:**
- Network errors, timeouts, and non-200 responses all indistinguishable
- No logging at all - completely silent

**Impact:** Medium - Hard to debug why health checks fail

**Recommendation:**
```typescript
} catch (error) {
  logger.debug('WORKER', 'Health check failed', { port }, error);
  return false;
}
```

---

#### 4. Tool Formatting (logger.ts:122-124)

```typescript
try {
  const input = typeof toolInput === 'string' ? JSON.parse(toolInput) : toolInput;
  // ...
} catch {
  return toolName;
}
```

**Problem:**
- Invalid JSON in tool input fails silently
- Could mask data corruption issues

**Impact:** Low - Only affects log formatting

**Status:** ✅ Acceptable for log formatting, but could log at DEBUG level

---

### 🟢 GOOD: No Nested Try-Catch Anti-Patterns

Analysis confirmed zero instances of nested try-catch blocks. Error handling is consistently at single level per function.

---

## Artificial Blockers & Unnecessary Checks

### 🔴 CRITICAL: First-Run Detection (user-message-hook.ts:14-40)

```typescript
const nodeModulesPath = join(pluginDir, 'node_modules');

if (!existsSync(nodeModulesPath)) {
  // Show first-time setup message
  console.error(`...`);
  process.exit(3);
}
```

**Problems:**
1. **False Positive:** Will trigger if user manually deletes node_modules (e.g., for troubleshooting)
2. **Installation Race:** Could fail if installation is still in progress
3. **Hook-Level Check:** Runs on EVERY SessionStart, not just actual first run

**Impact:** High - Prevents usage until node_modules exists, even if dependencies are installed elsewhere

**Edge Cases:**
- User runs `rm -rf node_modules` for troubleshooting
- Package manager installation interrupted
- Symlinked node_modules (some package managers)

**Recommendation:**
- Use a `.first-run-complete` marker file instead
- Move check to npm postinstall script
- Make check more robust (check for specific required modules)

---

### 🟡 MEDIUM: Overly Specific Validation (paths.ts:117-119)

```typescript
if (!existsSync(join(commandsDir, 'save.md'))) {
  throw new Error('Package commands directory missing required files');
}
```

**Problem:**
- Checks for ONE specific file to validate entire directory
- Hardcoded filename could break if files reorganized
- Error message doesn't specify what's missing

**Impact:** Medium - Could prevent package from working after internal refactoring

**Recommendation:**
- Remove check entirely (let actual command invocation fail with better error)
- Or check all required files if validation is critical

---

### 🟡 MEDIUM: Duplicate Health Endpoints

**Locations:**
- `src/services/worker-service.ts:107` - `/api/health`
- `src/services/worker/http/routes/ViewerRoutes.ts:27` - `/health`

**Usage:**
- `worker-utils.ts` uses `/health`
- `mcp-server.ts` uses `/api/health`

**Problem:**
- Redundant endpoints doing the same thing
- Inconsistent usage across codebase
- Maintenance burden

**Impact:** Low - Both work, but creates confusion

**Recommendation:**
- Standardize on `/api/health` (follows REST convention)
- Remove `/health` endpoint
- Update worker-utils.ts to use `/api/health`

---

## Timeout Configuration Issues

### Inconsistent Timeouts Across Components

| Component | Timeout | Location | Purpose |
|-----------|---------|----------|---------|
| Health check | 500ms | worker-utils.ts:13 | Check if worker alive |
| Worker startup wait | 1000ms | worker-utils.ts:14 | Wait between health checks |
| Worker startup retries | 15x | worker-utils.ts:15 | Max retries (15s total) |
| Hook HTTP requests | 2000ms | cleanup-hook.ts:61, save-hook.ts:70, summary-hook.ts:164 | Send data to worker |
| New hook session init | 5000ms | new-hook.ts:129 | Initialize session |
| Context hook fetch | 5000ms | context-hook.ts:32 | Fetch context via curl |
| User message hook | 5000ms | user-message-hook.ts:52 | Fetch context display |

**Problems:**
1. **Health Check Too Aggressive:** 500ms may be too short for loaded systems or slow network
2. **No Platform Adjustment:** Comment says "Windows needs longer timeouts" but values are same
3. **Hook Timeout Variation:** Some hooks use 2s, others use 5s with no clear reasoning

**Recommendations:**
- Increase health check timeout to 1000ms minimum
- Actually implement longer timeouts for Windows
- Standardize hook timeouts to 5000ms across the board
- Make timeouts configurable via settings

---

## Edge Case Analysis

### Handled Well ✅

1. **JSONL Parsing:** summary-hook.ts continues on malformed lines (60-64, 117-121)
2. **Git Not Available:** paths.ts falls back to cwd basename (89-97)
3. **Settings File Missing:** early-settings.ts falls back to env vars and defaults (20-28)
4. **Privacy Tags:** new-hook.ts handles fully-private prompts (99-109)
5. **Tool Skipping:** save-hook.ts filters low-value tools (24-30)

### Missing Edge Case Handling ⚠️

1. **curl Failure:** context-hook.ts has no error handling for curl failures
2. **PM2 Not Installed:** worker-utils.ts assumes pm2 exists globally
3. **PowerShell Restrictions:** worker-utils.ts doesn't check execution policy
4. **Concurrent Worker Starts:** No locking to prevent multiple hooks from starting worker simultaneously
5. **Port Already In Use:** No detection or recovery if worker port is taken
6. **Zombie Processes:** Windows approach doesn't track PIDs, can't detect/kill zombies

---

## Recommendations Summary

### High Priority 🔴

1. **Replace curl with fetch** in context-hook.ts
   - Eliminates external dependency
   - Consistent with rest of codebase
   - Better error handling

2. **Add logging to silent failures**
   - early-settings.ts: Log when settings file fails to load
   - worker-utils.ts: Log startup failures with details
   - worker-utils.ts: Log health check failures at debug level

3. **Fix first-run detection**
   - Use marker file instead of node_modules check
   - More reliable and intentional

### Medium Priority 🟡

4. **Verify PM2 availability** before attempting to use it
   - Check existence before spawn
   - Provide clear error message if missing

5. **Implement platform-specific timeouts**
   - Actually use longer timeouts on Windows as comment suggests
   - Make timeouts configurable

6. **Standardize health endpoints**
   - Remove duplicate `/health` endpoint
   - Use `/api/health` everywhere

7. **Add path escaping** for Windows PowerShell commands
   - Prevent injection issues
   - Handle paths with special characters

### Low Priority 🟢

8. **Standardize HTTP timeouts** across all hooks
9. **Add concurrent startup protection** (locking mechanism)
10. **Improve error messages** with actionable recovery steps

---

## Testing Recommendations

### Cross-Platform Testing Needed

1. **Windows Environments:**
   - Windows 10 (various versions)
   - Windows 11
   - Windows Server
   - WSL/WSL2
   - PowerShell execution policies (Restricted, RemoteSigned, Unrestricted)

2. **Unix Environments:**
   - macOS (Intel + Apple Silicon)
   - Linux (Ubuntu, Fedora, Arch)
   - FreeBSD

3. **Edge Environments:**
   - Docker containers
   - CI/CD environments
   - Systems without git installed
   - Systems without curl (or with restricted curl)
   - Corporate networks with proxies
   - Low-spec systems (slow startup)

### Test Scenarios

1. **Cold Start:** First run with no existing data
2. **Corrupt Settings:** Invalid JSON in settings.json
3. **Missing Dependencies:** No PM2, no git, no curl
4. **Port Conflicts:** Worker port already in use
5. **Rapid Hook Invocations:** Multiple hooks trying to start worker simultaneously
6. **Permission Issues:** Read-only filesystem, restricted execution
7. **Network Issues:** Localhost blocked, slow network

---

## Code Quality Assessment

### Strengths ✅

- Clean separation of concerns (hooks → worker → database)
- No nested try-catch anti-patterns
- Consistent use of modern async/await
- Good use of TypeScript for type safety
- Idempotent database operations
- Clear documentation in critical sections

### Weaknesses ⚠️

- Silent failures hinder debugging
- Inconsistent error handling patterns
- Platform-specific code not fully tested/documented
- Timeout configuration hardcoded and inconsistent
- Some artificial blockers prevent legitimate use cases

### Technical Debt

- Duplicate health endpoints
- curl dependency when fetch available
- PM2 dependency on Unix but not Windows (inconsistent monitoring)
- First-run detection using node_modules existence
- Hardcoded timeout values

---

## Conclusion

The claude-mem smart install and plugin hook system is architecturally sound with a well-designed separation of concerns. However, several cross-platform compatibility issues and silent failure patterns could cause problems in production, particularly on Windows systems or in edge case scenarios.

The highest priority improvements are:
1. Removing the curl dependency
2. Adding proper logging to silent failures
3. Fixing the fragile first-run detection
4. Verifying external dependencies before use

These changes would significantly improve debuggability and cross-platform reliability without requiring major architectural changes.

---

**Analysis Methodology:**
- Systematic review of all TypeScript source files
- Static analysis of error handling patterns
- Cross-platform compatibility assessment
- Edge case identification through code path analysis
- Comparison against best practices and KISS principles

**Files Analyzed:**
- src/hooks/*.ts (6 files)
- src/services/worker-service.ts
- src/services/worker/*.ts (10+ files)
- src/servers/mcp-server.ts
- src/shared/*.ts (worker-utils, early-settings, paths)
- src/utils/*.ts (logger, silent-debug, tag-stripping)
