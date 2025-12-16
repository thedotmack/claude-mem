# Windows, Bun, and Worker Service Struggles

A comprehensive chronicle of platform-specific issues, attempted fixes, and architectural decisions.

## Executive Summary

The claude-mem project has faced persistent Windows-specific issues centered around three core problems:

1. **Console Window Popups**: Blank terminal windows appearing when spawning worker and SDK subprocess
2. **Zombie Socket Issues**: Bun leaving TCP sockets in LISTEN state after termination on Windows
3. **Process Management Complexity**: Platform-specific spawning logic and reliability issues

These issues have driven multiple PRs, architectural pivots, and significant debate about runtime switching (Bun → Node.js).

---

## Timeline of Issues

### Issue #209: Windows Worker Startup Failures (Dec 12-13, 2025)

**Problem**: Worker service failed to start on Windows using PowerShell Start-Process approach.

**Symptoms**:
- Worker startup attempted via `powershell.exe -NoProfile -NonInteractive -Command Start-Process`
- Health check retries exhausted (15 attempts over 15 seconds)
- Users left unable to start worker manually

**Root Causes**:
- Platform-conditional process spawning (PowerShell for Windows, PM2 for Unix)
- PowerShell spawning without `-PassThru` to capture PID
- Inconsistent process management across platforms

**Resolution**: Issue was marked as closed, suggesting it was resolved in v7.1.0 through architectural unification with Bun-based ProcessManager using PID file tracking consistently across all platforms.

**Status**: ✅ Resolved (pre-PR #335)

---

### Issue #309 & PR #315: Console Window Popups (Dec 14-15, 2025)

**Problem**: Blank terminal windows appear when spawning worker processes and SDK subprocesses on Windows.

**First Attempted Fix (PR #315)**: Add `windowsHide: true` to spawn options

**Why It Failed**: Node.js bug #21825 - `windowsHide: true` is **ignored** when `detached: true` is also set. Both flags are required:
- `detached: true` - Needed for background process
- `windowsHide: true` - Needed to hide window (but doesn't work when detached)

**Testing Results** (by ToxMox):
- Tested PR #315 on Windows 11
- Confirmed blank terminal windows still appear for both worker and SDK subprocess spawns
- Affects both `ProcessManager.ts` (worker) and `SDKAgent.ts` (SDK subprocess)

**Working Solution**: Use PowerShell's `Start-Process` with `-WindowStyle Hidden` flag instead of standard spawn.

**Status**: ❌ PR #315 closed in favor of more comprehensive solution

---

### Bun Zombie Socket Issue (Dec 15, 2025)

**Problem**: Bun leaves TCP sockets in zombie LISTEN state on Windows after worker termination.

**Symptoms**:
- Port remains bound even though no process owns it
- `OwningProcess` shows 0 or dead PID
- New worker instances cannot start due to `EADDRINUSE` errors
- Happens regardless of termination method (process.exit(), external kill, Ctrl+C)
- **Only system reboot clears zombie ports**

**Upstream Tracking**:
- Bun issue #12127
- Bun issue #5774
- Bun issue #8786

**Impact**: Windows users may need to reboot their systems when worker crashes or is restarted.

**Proposed Solution**: Switch worker runtime from Bun to Node.js on Windows (or globally).

**Status**: 🟡 Unresolved - Platform-specific bug in Bun's Windows socket cleanup

---

### SDK Subprocess Hang Issue (Dec 15, 2025)

**Problem**: SDK subprocesses can hang indefinitely, blocking observation processing.

**Root Cause**: `AbortController.abort()` does not actually terminate child processes.

**Symptoms**:
- For-await loop blocks forever waiting for output from hung subprocess
- Observation processing halts
- No recovery mechanism

**Solution**: Implement watchdog timer that explicitly kills child processes using platform-specific commands:
- **Windows**: `wmic process where ParentProcessId=<pid> delete`
- **Unix**: `pkill -P <pid>`

**Timeout**: `SDK_QUERY_TIMEOUT_MS` set to 2 minutes

**Status**: ✅ Fixed in PR #335 (watchdog implementation)

---

## PR #335: Comprehensive Windows Fix (Dec 15, 2025)

### What It Attempted

ToxMox developed a comprehensive PR addressing all Windows issues simultaneously:

1. **PowerShell-based spawning** to fix popup windows
2. **Runtime switch** from Bun to Node.js (globally) to fix zombie sockets
3. **Queue monitoring system** with persistent message queue
4. **Watchdog service** for stuck message recovery
5. **SQLite compatibility layer** for Node.js support

### Architecture Decisions

**ProcessManager Changes**:
- Switched from `startWithBun()` to `startWithNode()`
- Windows: Uses PowerShell `Start-Process -WindowStyle Hidden -PassThru`
- Unix: Uses standard `spawn()` with `detached: true`
- Captures PID via PowerShell `Select-Object -ExpandProperty Id`
- Comment states: "Use Node on all platforms (Bun has zombie socket issues on Windows)"

**SQLite Compatibility Layer**:
- Created `sqlite-compat.ts` adapter pattern
- Provides `bun:sqlite` API compatibility via `better-sqlite3`
- Allows code to work with both Bun and Node.js runtimes

### Critical Issues Identified

#### 1. **Global vs Platform-Conditional Runtime**

**The Inconsistency**: Code comment explicitly states zombie sockets occur "on Windows", yet solution applies Node.js universally across all platforms.

**Questions Raised**:
- Why sacrifice Bun's performance on macOS/Linux where no issues documented?
- Platform-specific spawning already implemented - why not platform-specific runtime?
- No documented Bun reliability issues on non-Windows platforms

#### 2. **Performance Regressions**

**better-sqlite3 Blocking**:
- Synchronous-only API blocks Node.js event loop during all DB operations
- Contrasts with Bun's async SQLite support
- Affects: enqueue, markProcessing, markProcessed, watchdog checks

**Watchdog Polling Overhead**:
- Full table scans every 30 seconds even when idle
- Constant database I/O overhead
- No max queue size limits = unbounded growth

**Startup Latency**:
- Node.js initialization (slower than Bun)
- Native module loading (better-sqlite3)
- Database migrations
- Stuck message scan
- Watchdog initialization
- HTTP server startup

#### 3. **Build Dependencies**

**better-sqlite3 Requirements**:
- node-gyp
- Python
- C++ compiler toolchains
- Visual Studio Build Tools (Windows)

**Impact**:
- Local development machines without build tools fail
- CI/CD pipelines need updated Docker images
- Restricted environments where compilers not permitted
- ARM/M1 Mac compatibility issues

#### 4. **Migration Risks**

**Breaking Changes**:
- Automatic database migration adds `pending_messages` table
- Runtime switch not documented in PR
- Node.js becomes undocumented hard requirement
- No migration guide or rollback procedure

**Unanswered Questions**:
- What happens to in-flight messages during upgrade?
- Can users safely downgrade?
- Is migration idempotent?

#### 5. **Code Quality Issues**

**Command Injection Risk** (ProcessManager.ts:67):
- PowerShell commands use template literal concatenation
- Vulnerable if `MARKETPLACE_ROOT` or script paths attacker-controlled
- Should use array-based argument passing

**Missing Error Handling** (WatchdogService.ts:61):
- `setInterval` callback lacks error handling
- Timer continues running if `check()` throws
- Creates zombie watchdog scenario

**No Queue Size Limits**:
- Unbounded database growth if messages accumulate
- Failed messages (exceeding `maxRetries`) accumulate indefinitely
- Only 24-hour retention for processed messages

---

## Assessment and Recommendations

### What Was Validated

**Legitimate Windows Issues**:
- ✅ Console window popups are real (Node.js bug #21825)
- ✅ PowerShell `Start-Process` solution works
- ✅ Bun zombie socket issue is real and Windows-specific
- ✅ SDK subprocess hang issue is real

### What Remains Questionable

**Global Runtime Switch**:
- ❌ No evidence Bun problematic on macOS/Linux
- ❌ Platform-conditional runtime not considered
- ❌ Performance trade-offs not documented
- ❌ "Windows-only" issue applied globally

**Zombie Socket Root Cause**:
- 🟡 May be fixable with proper cleanup handlers:
  - Missing `server.close()` calls before exit
  - Processes killed with `SIGKILL` before cleanup finishes
  - Missing `SIGTERM` signal handlers for graceful shutdown
- 🟡 Runtime switch may be unnecessary over-engineering

### Salvageable Components

**If Extracted into Separate PRs**:

1. **PowerShell Spawning for Windows Worker**
   - Focused PR: "Windows: Use Node.js instead of Bun for worker process"
   - Platform-conditional logic (Node.js on Windows, Bun elsewhere)
   - Independent justification required

2. **SQLite Compatibility Layer**
   - Well-designed adapter pattern
   - Requires independent justification for Node.js runtime need
   - Should not be bundled with other changes

3. **Queue Monitoring UI Concept**
   - Valuable visibility into worker state
   - Should build on in-memory state first
   - Remove database persistence requirement initially

4. **Watchdog Improvements**
   - SDK subprocess timeout handling
   - Evidence of superiority over current approach needed

---

## Current Status

### Resolved
- ✅ Issue #209: Windows worker startup (v7.1.0)
- ✅ SDK subprocess hang issue (watchdog implementation)

### In Progress
- 🔄 PR #339: Windows console popup fix (extracted from PR #335)
- 🔄 PR #338: Queue monitoring system (extracted from PR #335)

### Open Questions
- ❓ Should runtime switch be global or Windows-only?
- ❓ Can zombie socket issue be fixed without runtime switch?
- ❓ Is better-sqlite3's synchronous blocking acceptable?
- ❓ Should queue persistence be in-memory first?

---

## Lessons Learned

### Architectural Principles Violated

**YAGNI**: Queue persistence, watchdog service, and comprehensive monitoring added without proven need.

**Happy Path**: Should have started with simplest Windows fix (PowerShell spawning), validated, then added complexity if needed.

**Incremental Validation**: Bundling multiple architectural changes prevents isolating what actually solves the problem.

### What Should Have Happened

1. **Phase 1**: PowerShell spawning fix for Windows console popups (targeted, testable)
2. **Phase 2**: Investigate zombie socket root cause (cleanup handlers vs runtime switch)
3. **Phase 3**: If runtime switch justified, implement as Windows-conditional first
4. **Phase 4**: Add queue monitoring as optional feature with in-memory state
5. **Phase 5**: Add persistence only if in-memory insufficient

### Key Takeaways

- **Windows-specific issues don't justify global architectural changes** without clear evidence
- **Platform-conditional logic is acceptable** when solving platform-specific problems
- **Native module dependencies are heavy** - avoid unless necessary
- **Performance regressions need explicit justification** - synchronous blocking, startup latency, polling overhead all impact UX
- **Bundle size matters** - build tools, compilers, Python are significant requirements

---

## References

**GitHub Issues**:
- #209: Windows worker startup failures
- #309: Console window popups
- #315: windowsHide approach (closed)

**PRs**:
- #335: Comprehensive Windows fix (under review)
- #338: Queue monitoring system (extracted)
- #339: Windows console popup fix (extracted)

**Upstream Bugs**:
- Node.js #21825: windowsHide ignored with detached
- Bun #12127, #5774, #8786: Windows zombie sockets

**Related Observations**:
- #27302: PR #315 windowsHide failure analysis
- #27233: Bun zombie socket discovery
- #27232: Windows background window root cause
- #27286: Runtime switch assessment
- #27283: PowerShell process spawn fix
- #27190: ProcessManager Node.js implementation
- #24532: Issue #209 resolution

---

**Last Updated**: 2025-12-16
**Document Status**: Comprehensive review based on memory search through #S3485
