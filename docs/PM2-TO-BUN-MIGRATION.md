# PM2 to Bun Migration: Complete Technical Documentation

**Version**: 7.0.10+
**Date**: December 2025
**Migration Type**: Process Management (PM2 → Bun) + Database Driver (better-sqlite3 → bun:sqlite)

---

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [Architecture Comparison](#architecture-comparison)
3. [Migration Mechanics](#migration-mechanics)
4. [User Experience Timeline](#user-experience-timeline)
5. [Platform-Specific Behavior](#platform-specific-behavior)
6. [Observable Changes](#observable-changes)
7. [File System State](#file-system-state)
8. [Edge Cases and Troubleshooting](#edge-cases-and-troubleshooting)
9. [Developer Notes](#developer-notes)

---

## Executive Summary

Claude-mem version 7.0.10 introduces two major architectural migrations:

1. **Process Management**: PM2 → Custom Bun-based ProcessManager
2. **Database Driver**: better-sqlite3 npm package → bun:sqlite runtime module

Both migrations are **automatic** and **transparent** to end users. The first time a hook fires after updating to 7.0.10+, the system performs a one-time cleanup of legacy PM2 processes and transitions to the new architecture.

### Key Benefits

- **Simplified Dependencies**: Removes PM2 and better-sqlite3 npm packages
- **Improved Cross-Platform Support**: Better Windows compatibility
- **Faster Installation**: No native module compilation required
- **Built-in Runtime**: Leverages Bun's built-in process management and SQLite
- **Reduced Complexity**: Custom ProcessManager is simpler than PM2 integration

### Migration Impact

- **Data Preservation**: User data, settings, and database remain unchanged
- **Automatic Cleanup**: Old PM2 processes automatically terminated (all platforms)
- **No User Action Required**: Migration happens automatically on first hook trigger
- **Backward Compatible**: SQLite database format unchanged (only driver changed)

---

## Architecture Comparison

### Old System (PM2-based)

#### Process Management (PM2)

**Component**: PM2 (Process Manager 2)
- **Package**: `pm2` npm dependency
- **Process Name**: `claude-mem-worker`
- **Management**: External PM2 daemon manages lifecycle
- **Discovery**: `pm2 list`, `pm2 describe` commands
- **Auto-restart**: PM2 automatically restarts on crash
- **Logs**: `~/.pm2/logs/claude-mem-worker-*.log`
- **PID File**: `~/.pm2/pids/claude-mem-worker.pid`

**Lifecycle Commands**:
```bash
pm2 start <script>           # Start worker
pm2 stop claude-mem-worker   # Stop worker
pm2 restart claude-mem-worker # Restart worker
pm2 delete claude-mem-worker  # Remove from PM2
pm2 logs claude-mem-worker    # View logs
```

**Pain Points**:
- Additional npm dependency required
- PM2 daemon must be running
- Potential conflicts with other PM2 processes
- Windows compatibility issues
- Complex configuration for simple use case

#### Database Driver (better-sqlite3)

**Component**: better-sqlite3
- **Package**: `better-sqlite3` npm package (native module)
- **Installation**: Requires native compilation (node-gyp)
- **Windows**: Requires Visual Studio build tools + Python
- **Import**: `import Database from 'better-sqlite3'`
- **Verification**: Extensive checks in `smart-install.js`

**Installation Requirements**:
- Node.js development headers
- C++ compiler (gcc/clang on Mac/Linux, MSVC on Windows)
- Python (for node-gyp)
- Windows: Visual Studio Build Tools

---

### New System (Bun-based)

#### Process Management (Custom ProcessManager)

**Component**: Custom ProcessManager (`src/services/process/ProcessManager.ts`)
- **Package**: Built-in Bun APIs (no external dependency)
- **Process Spawn**: `Bun.spawn()` with detached mode
- **Management**: Direct process control via PID file
- **Discovery**: PID file + process existence check + HTTP health check
- **Auto-restart**: Hook-triggered restart on failure detection
- **Logs**: `~/.claude-mem/logs/worker-YYYY-MM-DD.log`
- **PID File**: `~/.claude-mem/.worker.pid`
- **Port File**: `~/.claude-mem/.worker.port` (new)

**Lifecycle Commands**:
```bash
npm run worker:start    # Start worker
npm run worker:stop     # Stop worker
npm run worker:restart  # Restart worker
npm run worker:status   # Check status
npm run worker:logs     # View logs
```

**Core Mechanisms**:

1. **PID File Management**:
   - File: `~/.claude-mem/.worker.pid`
   - Content: Process ID (e.g., "35557")
   - Created: On worker start
   - Deleted: On worker stop
   - Validation: Process existence via `kill(pid, 0)` signal

2. **Port File Management**:
   - File: `~/.claude-mem/.worker.port`
   - Content: Two lines (port number, PID)
   - Purpose: Track port binding and validate PID match
   - Created: After successful port binding
   - Deleted: On worker stop

3. **Health Checking**:
   - Layer 1: PID file exists?
   - Layer 2: Process alive? (`kill(pid, 0)`)
   - Layer 3: HTTP health check (`GET /health`)
   - All three must pass for "healthy" status

4. **Port Validation**:
   - Range: 1024-65535
   - Validation: At ProcessManager.start() entry point
   - Prevents: Invalid ports from reaching spawn logic

**Advantages**:
- No external dependencies
- Simpler codebase (direct control)
- Better error handling and validation
- Platform-agnostic (Bun handles platform differences)
- Cleaner separation of concerns

#### Database Driver (bun:sqlite)

**Component**: bun:sqlite
- **Package**: Built into Bun runtime (no npm package)
- **Installation**: None required (comes with Bun ≥1.0)
- **Platform**: Works anywhere Bun works
- **Import**: `import { Database } from 'bun:sqlite'`
- **API**: Similar to better-sqlite3 (synchronous)

**Installation Requirements**:
- Bun ≥1.0 (automatically installed if missing)
- No native compilation required
- No platform-specific build tools needed

**Compatibility**:
- SQLite database format: **Unchanged**
- Database file: `~/.claude-mem/claude-mem.db` (same location)
- Query syntax: **Identical** (both use SQLite SQL)
- API surface: **Similar** (both provide synchronous SQLite API)

---

## Migration Mechanics

### One-Time PM2 Cleanup

The migration system uses a marker-based approach to perform PM2 cleanup exactly once.

**Implementation**: `src/shared/worker-utils.ts:72-86`

```typescript
// Clean up legacy PM2 (one-time migration)
const pm2MigratedMarker = join(DATA_DIR, '.pm2-migrated');

if (!existsSync(pm2MigratedMarker)) {
  try {
    spawnSync('pm2', ['delete', 'claude-mem-worker'], { stdio: 'ignore' });
    // Mark migration as complete
    writeFileSync(pm2MigratedMarker, new Date().toISOString(), 'utf-8');
    logger.debug('SYSTEM', 'PM2 cleanup completed and marked');
  } catch {
    // PM2 not installed or process doesn't exist - still mark as migrated
    writeFileSync(pm2MigratedMarker, new Date().toISOString(), 'utf-8');
  }
}
```

### Migration Trigger Points

**Hook Path** (where migration happens):
1. SessionStart, UserPromptSubmit, PostToolUse hooks execute
2. Hook calls `ensureWorkerRunning()` (`worker-utils.ts`)
3. `ensureWorkerRunning()` determines worker not running (no PID file)
4. Calls `startWorker()` (`worker-utils.ts`)
5. `startWorker()` checks for migration marker
6. **If marker missing**: Runs PM2 cleanup, creates marker
7. **If marker exists**: Skips cleanup
8. Proceeds to start new Bun-managed worker

**CLI Path** (bypasses migration):
1. User runs `npm run worker:start|stop|restart`
2. CLI calls `ProcessManager.start|stop|restart()` directly
3. ProcessManager methods do NOT check migration marker
4. No PM2 cleanup attempted
5. Direct Bun process management

**Key Insight**: Migration only happens via hook path, not CLI path. This is intentional - CLI starts are explicit user actions, while hooks represent automatic background starts.

### Migration Steps (First Hook Trigger)

1. **Marker Check**:
   - Check: `~/.claude-mem/.pm2-migrated` exists?
   - Missing → Continue to cleanup
   - Present → Skip to worker start

2. **PM2 Cleanup Attempt**:
   - Executed on all platforms (Mac/Linux/Windows)
   - Safe due to try/catch error handling

3. **PM2 Cleanup**:
   - Execute: `pm2 delete claude-mem-worker`
   - Ignore errors (PM2 might not be installed, process might not exist)
   - This terminates the old PM2-managed worker

4. **Marker Creation**:
   - Write: ISO timestamp to `~/.claude-mem/.pm2-migrated`
   - Purpose: Prevent repeated cleanup attempts
   - Created even if PM2 cleanup failed

5. **New Worker Start**:
   - Spawn: New Bun-managed worker process
   - Create: `.worker.pid` and `.worker.port` files
   - Log: Worker startup in `~/.claude-mem/logs/`

### Marker File

**Location**: `~/.claude-mem/.pm2-migrated`

**Content**: ISO 8601 timestamp
```
2025-12-13T00:18:39.673Z
```

**Purpose**:
- One-time migration flag
- Prevents repeated PM2 cleanup on every start
- Persists across restarts and reboots

**Lifecycle**:
- Created: First hook trigger after update to 7.0.10+ (all platforms)
- Updated: Never
- Deleted: Never (user could manually delete to force re-migration)

**Platform Behavior**:
- **All Platforms**: Created on first hook trigger after update
- **Cross-platform**: Same migration behavior on Mac/Linux/Windows

---

## User Experience Timeline

### Pre-Update State (Version < 7.0.10)

**Process Management**:
- Worker managed by PM2 daemon
- Process name: `claude-mem-worker`
- PID file: `~/.pm2/pids/claude-mem-worker.pid`
- Logs: `~/.pm2/logs/claude-mem-worker-*.log`

**Database**:
- Driver: better-sqlite3 npm package
- Database file: `~/.claude-mem/claude-mem.db`
- Native module: Compiled during npm install

**User Commands**:
```bash
pm2 list                     # See worker status
pm2 logs claude-mem-worker   # View logs
pm2 restart claude-mem-worker # Restart worker
```

### Update Process

**Method 1: Automatic Update**
1. Claude Code checks for plugin updates
2. Downloads claude-mem 7.0.10+
3. Syncs to `~/.claude/plugins/marketplaces/thedotmack/`
4. New hook scripts deployed

**Method 2: Manual Update**
```bash
cd ~/Scripts/claude-mem
git pull origin main
npm run build
npm run sync-marketplace
```

**What Gets Updated**:
- Hook scripts (6 files in `plugin/scripts/*-hook.js`)
- Worker service code (bundled)
- Skill definitions
- Package metadata

**What Doesn't Change**:
- User data: `~/.claude-mem/claude-mem.db` (unchanged)
- Settings: `~/.claude-mem/settings.json` (unchanged)
- Chroma: `~/.claude-mem/chroma/` (unchanged)
- Logs: `~/.claude-mem/logs/` (preserved)

**Old Worker State During Update**:
- Old PM2 worker may still be running
- Running old code (pre-7.0.10)
- Will continue until next hook trigger or manual stop

### First Session After Update (Critical Migration Moment)

**Trigger**: User opens Claude Code, any hook fires (SessionStart most common)

**Step-by-Step Execution**:

1. **Hook Execution** (using new 7.0.10 code):
   ```
   SessionStart hook fires
   → Calls ensureWorkerRunning()
   ```

2. **Worker Status Check**:
   ```
   ensureWorkerRunning() checks:
   - Does ~/.claude-mem/.worker.pid exist? NO
   - Conclusion: Worker not running (from new system perspective)
   ```

3. **Start Worker Decision**:
   ```
   Worker not running → Call startWorker()
   ```

4. **Migration Check**:
   ```
   startWorker() checks:
   - Platform: Mac/Linux/Windows?
   - Marker: ~/.claude-mem/.pm2-migrated exists? NO
   ```

5. **PM2 Cleanup** (all platforms):
   ```
   Execute: pm2 delete claude-mem-worker
   Result: Old PM2 worker terminated (if exists)
   Create: ~/.claude-mem/.pm2-migrated with timestamp
   Log: "PM2 cleanup completed and marked"
   ```

6. **New Worker Start**:
   ```
   Spawn: bun plugin/scripts/worker-cli.js start <port>
   Create: ~/.claude-mem/.worker.pid (e.g., "35557")
   Create: ~/.claude-mem/.worker.port (port + PID)
   Log: Worker startup in ~/.claude-mem/logs/worker-YYYY-MM-DD.log
   ```

7. **Verification**:
   ```
   Check: Process exists (kill -0)
   Check: HTTP health check (GET /health)
   Result: Worker confirmed running
   ```

8. **Hook Completion**:
   ```
   Hook returns success
   Claude Code session starts normally
   ```

**User Observable Behavior**:
- Slight delay on first startup (PM2 cleanup + new worker spawn)
- No error messages (cleanup failures silently handled)
- Worker appears running via `npm run worker:status`
- Old PM2 worker no longer in `pm2 list`

**Timing**:
- Total migration time: ~2-5 seconds
- PM2 cleanup: ~1 second
- New worker spawn: ~1-3 seconds
- Health check: ~1 second

### Subsequent Sessions (After Migration)

**Every Hook Trigger**:

1. **Hook Execution**:
   ```
   Any hook fires → ensureWorkerRunning()
   ```

2. **Worker Status Check**:
   ```
   Check 1: ~/.claude-mem/.worker.pid exists? YES
   Check 2: Process alive (kill -0)? YES
   Check 3: HTTP health check? SUCCESS
   Result: Worker already running, done
   ```

3. **No Migration Logic**:
   ```
   startWorker() NOT called
   Marker check NOT performed
   PM2 cleanup NOT attempted
   Fast path: ~50ms total
   ```

**If Worker Needs Restart**:

```
Scenario: Worker crashed, PID file stale

Check 1: PID file exists? YES (35557)
Check 2: Process alive? NO (process 35557 dead)
Action: Call startWorker()
Migration: Marker exists → skip PM2 cleanup
Result: Spawn new worker immediately
```

**CLI Commands** (all sessions):
```bash
npm run worker:status   # Check: PID file + process + health
npm run worker:restart  # Kill current, spawn new
npm run worker:stop     # Kill current, delete PID files
npm run worker:start    # Spawn new (if not running)
npm run worker:logs     # tail -f logs/worker-YYYY-MM-DD.log
```

**Key Differences from First Session**:
- No PM2 cleanup (marker exists)
- No migration delay
- Faster startup (~1-2 seconds vs ~2-5 seconds)

---

## Platform-Specific Behavior

### macOS (Darwin)

**First Session After Update**:

1. **Marker Check**:
   ```
   File: ~/.claude-mem/.pm2-migrated
   Exists: NO
   ```

2. **Platform Check**:
   ```
   Platform: darwin
   Condition: process.platform !== 'win32'
   Result: TRUE (not Windows)
   Action: Proceed to PM2 cleanup
   ```

3. **PM2 Cleanup**:
   ```bash
   Command: pm2 delete claude-mem-worker

   Possible Outcomes:
   A) PM2 installed, process exists:
      → Successfully deleted, exit code 0

   B) PM2 installed, process doesn't exist:
      → Error: "process claude-mem-worker not found"
      → Exit code 1, error ignored

   C) PM2 not installed:
      → Error: "command not found: pm2"
      → Error ignored (catch block)
   ```

4. **Marker Creation**:
   ```
   File: ~/.claude-mem/.pm2-migrated
   Content: 2025-12-13T00:18:39.673Z
   Created: Regardless of PM2 cleanup success/failure
   ```

5. **New Worker**:
   ```bash
   Spawn: bun plugin/scripts/worker-cli.js start 37777
   Detached: true (process runs independently)
   Stdout/Stderr: ~/.claude-mem/logs/worker-YYYY-MM-DD.log
   ```

**Subsequent Sessions**:
- Marker exists → PM2 cleanup skipped
- Standard ProcessManager flow
- Fast startup (~50ms status check)

**macOS-Specific Notes**:
- POSIX signal handling (kill -0, SIGTERM work natively)
- Bun fully supported on macOS
- No platform-specific workarounds needed

### Linux

**Behavior**: Identical to macOS

**First Session**:
- Marker check → Missing
- Platform check → Pass (not Windows)
- PM2 cleanup → Attempted
- Marker created → `~/.claude-mem/.pm2-migrated`

**Subsequent Sessions**:
- Marker exists → Skip cleanup
- Standard ProcessManager flow

**Linux-Specific Notes**:
- POSIX signal handling (same as macOS)
- Systemd integration possible (not implemented)
- Process management via standard Linux APIs

**Distribution Compatibility**:
- Ubuntu/Debian: Fully supported
- RHEL/CentOS: Fully supported
- Arch: Fully supported
- Alpine: Bun may require glibc (not musl)

### Windows

**First Session After Update**:

1. **Marker Check**:
   ```
   File: ~/.claude-mem/.pm2-migrated
   Exists: NO
   ```

2. **PM2 Cleanup Attempt**:
   ```
   Execute: pm2 delete claude-mem-worker

   Possible Outcomes:
   A) PM2 installed, process exists:
      → Successfully deleted, exit code 0

   B) PM2 installed, process doesn't exist:
      → Error: "process claude-mem-worker not found"
      → Exit code 1, error ignored

   C) PM2 not installed:
      → Error: "command not found: pm2" (or pm2.cmd on Windows)
      → Error ignored (catch block)

   D) PM2.cmd exists but fails:
      → Error caught and ignored
   ```

3. **Marker Creation**:
   ```
   File: ~/.claude-mem/.pm2-migrated
   Content: 2025-12-13T00:18:39.673Z
   Created: Regardless of PM2 cleanup success/failure
   ```

4. **New Worker**:
   ```powershell
   Spawn: bun plugin/scripts/worker-cli.js start 37777
   Detached: true (Windows process detachment)
   Stdout/Stderr: ~/.claude-mem/logs/worker-YYYY-MM-DD.log
   ```

**Subsequent Sessions**:
- Marker exists → PM2 cleanup skipped
- Standard ProcessManager flow
- Fast startup (~50ms status check)

**Windows-Specific Notes**:

1. **PM2 Cleanup on Windows**:
   - Now runs on Windows just like Mac/Linux
   - Safe due to try/catch error handling
   - Even if PM2 had issues historically, orphaned processes are cleaned up
   - Quality migration: no garbage processes left behind

2. **Signal Handling**:
   - Windows doesn't support POSIX signals (SIGTERM, etc.)
   - Bun abstracts this: `kill(pid, 0)` works on Windows
   - Process termination uses Windows APIs internally

3. **Path Separators**:
   - Bun handles `~/.claude-mem/` on Windows (`C:\Users\<user>\.claude-mem\`)
   - Path module ensures correct separators
   - Works seamlessly across platforms

4. **File Locking**:
   - Windows file locking stricter than Unix
   - SQLite database handles this (bun:sqlite)
   - PID/port files use atomic writes

**Windows Command Equivalents**:
```powershell
npm run worker:status   # Works (uses HTTP + process check)
npm run worker:restart  # Works (Bun process management)
npm run worker:logs     # Works (PowerShell compatible)
```

### Platform Comparison Table

| Feature | macOS | Linux | Windows |
|---------|-------|-------|---------|
| PM2 Cleanup | ✅ Attempted | ✅ Attempted | ✅ Attempted |
| Marker File | ✅ Created | ✅ Created | ✅ Created |
| Process Signals | POSIX (native) | POSIX (native) | Bun abstraction |
| Bun Support | ✅ Full | ✅ Full | ✅ Full |
| PID File | ✅ Yes | ✅ Yes | ✅ Yes |
| Port File | ✅ Yes | ✅ Yes | ✅ Yes |
| Health Check | ✅ HTTP | ✅ HTTP | ✅ HTTP |
| Migration Delay | ~2-5s first time | ~2-5s first time | ~2-5s first time |

---

## Observable Changes

### Command Changes

**Old PM2 Commands** → **New Bun Commands**:

| Old (PM2) | New (Bun) | Notes |
|-----------|-----------|-------|
| `pm2 list` | `npm run worker:status` | Shows worker status |
| `pm2 start <script>` | `npm run worker:start` | Start worker |
| `pm2 stop claude-mem-worker` | `npm run worker:stop` | Stop worker |
| `pm2 restart claude-mem-worker` | `npm run worker:restart` | Restart worker |
| `pm2 delete claude-mem-worker` | `npm run worker:stop` | Remove worker |
| `pm2 logs claude-mem-worker` | `npm run worker:logs` | View logs |
| `pm2 describe claude-mem-worker` | `npm run worker:status` | Detailed status |
| `pm2 monit` | ❌ No equivalent | PM2-specific monitoring |

**New Commands Work Everywhere**:
- Cross-platform (Mac/Linux/Windows)
- No PM2 installation required
- Consistent behavior across platforms

### File Location Changes

**Logs**:
```
Old: ~/.pm2/logs/claude-mem-worker-out.log
     ~/.pm2/logs/claude-mem-worker-error.log

New: ~/.claude-mem/logs/worker-YYYY-MM-DD.log
```

**PID Files**:
```
Old: ~/.pm2/pids/claude-mem-worker.pid

New: ~/.claude-mem/.worker.pid
```

**Process State**:
```
Old: PM2 daemon memory (pm2 save)

New: ~/.claude-mem/.worker.pid
     ~/.claude-mem/.worker.port
     ~/.claude-mem/.pm2-migrated (all platforms)
```

**Database** (unchanged):
```
Same: ~/.claude-mem/claude-mem.db
```

### User-Visible Changes

**Before Update**:
```bash
$ pm2 list
┌────┬────────────────────┬─────────┬─────────┬──────────┐
│ id │ name               │ status  │ restart │ uptime   │
├────┼────────────────────┼─────────┼─────────┼──────────┤
│ 0  │ claude-mem-worker  │ online  │ 0       │ 2d 5h    │
└────┴────────────────────┴─────────┴─────────┴──────────┘

$ pm2 logs claude-mem-worker
[2025-12-12 10:00:00] Worker started on port 37777
[2025-12-12 10:01:00] Processing observation #1234
```

**After Update**:
```bash
$ pm2 list
┌────┬────────┬─────────┬─────────┬──────────┐
│ id │ name   │ status  │ restart │ uptime   │
├────┼────────┼─────────┼─────────┼──────────┤
└────┴────────┴─────────┴─────────┴──────────┘
# Empty - worker no longer managed by PM2

$ npm run worker:status
Worker is running
PID: 35557
Port: 37777
Uptime: 2h 15m

$ npm run worker:logs
[2025-12-13 00:18:40] Worker started on port 37777
[2025-12-13 00:19:00] Processing observation #1235
```

### Debugging Changes

**Old System**:
```bash
# Get detailed process info
pm2 describe claude-mem-worker

# Show process tree
pm2 prettylist

# Flush logs
pm2 flush

# Monitor in real-time
pm2 monit
```

**New System**:
```bash
# Get detailed process info
npm run worker:status
cat ~/.claude-mem/.worker.pid
cat ~/.claude-mem/.worker.port

# Show process info (direct)
ps aux | grep worker-cli

# View logs
npm run worker:logs
# Or directly:
tail -f ~/.claude-mem/logs/worker-$(date +%Y-%m-%d).log

# Check migration status
ls -la ~/.claude-mem/.pm2-migrated
cat ~/.claude-mem/.pm2-migrated
```

### Orphaned Files

**After migration, these PM2 files may remain** (safe to delete):
```
~/.pm2/                    # Entire PM2 directory
~/.pm2/logs/               # Old logs
~/.pm2/pids/               # Old PID files
~/.pm2/pm2.log             # PM2 daemon log
~/.pm2/dump.pm2            # PM2 process dump
```

**Cleanup (optional)**:
```bash
# Remove PM2 entirely (if not used for other processes)
pm2 kill
rm -rf ~/.pm2

# Or just remove claude-mem logs
rm -f ~/.pm2/logs/claude-mem-worker-*.log
rm -f ~/.pm2/pids/claude-mem-worker.pid
```

---

## File System State

### PID File (`.worker.pid`)

**Location**: `~/.claude-mem/.worker.pid`

**Content**: Single line with process ID
```
35557
```

**Lifecycle**:
```
Worker Start:
1. Spawn Bun process
2. Get PID from spawn result
3. Write PID to .worker.pid
4. File created

Worker Running:
- File exists (read-only after creation)
- Used for process checks

Worker Stop:
1. Read PID from .worker.pid
2. Send SIGTERM to process
3. Wait for graceful shutdown
4. Delete .worker.pid
5. File removed
```

**Validation**:
```typescript
// Check if worker is running
const pidFile = join(DATA_DIR, '.worker.pid');
if (!existsSync(pidFile)) return false;

const pid = parseInt(readFileSync(pidFile, 'utf-8'));
if (isNaN(pid)) return false;

// Verify process exists
try {
  process.kill(pid, 0); // Signal 0 = existence check
  return true; // Process exists
} catch {
  return false; // Process dead
}
```

**Edge Cases**:
- **Stale PID file**: Process died, file remains → Detected and cleaned up
- **Corrupt PID file**: Non-numeric content → Treated as not running
- **Missing PID file**: Worker not running → Start new worker

### Port File (`.worker.port`)

**Location**: `~/.claude-mem/.worker.port`

**Content**: Two lines (port, PID)
```
37777
35557
```

**Purpose**:
1. Remember which port worker is using
2. Validate port file matches current PID
3. Prevent stale port information

**Lifecycle**:
```
Worker Start:
1. Spawn Bun process (PID: 35557)
2. Worker binds to port (37777)
3. Write port file:
   Line 1: 37777
   Line 2: 35557
4. File created

Worker Running:
- File exists (read-only)
- Used to get worker port

Worker Stop:
1. Read PID from .worker.pid
2. Kill process
3. Delete .worker.port
4. Delete .worker.pid
5. Files removed
```

**Validation**:
```typescript
// Get worker port with PID validation
const portFile = join(DATA_DIR, '.worker.port');
if (!existsSync(portFile)) return null;

const [portStr, pidStr] = readFileSync(portFile, 'utf-8').split('\n');
const port = parseInt(portStr);
const filePid = parseInt(pidStr);

// Check PID matches current worker
const currentPid = getWorkerPid(); // Read from .worker.pid
if (filePid !== currentPid) {
  // PID mismatch - port file stale
  unlinkSync(portFile);
  return null;
}

return port;
```

**Why Two Files?**:
- `.worker.pid`: Canonical source of truth (which process is worker)
- `.worker.port`: Cached port info (avoid config file reads)
- PID in port file: Validation (ensure port file matches current worker)

### Migration Marker (`.pm2-migrated`)

**Location**: `~/.claude-mem/.pm2-migrated`

**Content**: ISO 8601 timestamp
```
2025-12-13T00:18:39.673Z
```

**Purpose**:
- One-time migration flag
- Prevents repeated PM2 cleanup
- Debugging aid (when was migration performed)

**Lifecycle**:
```
First Hook Trigger (All Platforms):
1. Check: File exists? NO
2. Execute: pm2 delete claude-mem-worker (errors ignored)
3. Create: .pm2-migrated with timestamp
4. File persists forever

Subsequent Hook Triggers (All Platforms):
1. Check: File exists? YES
2. Action: Skip PM2 cleanup
3. Continue: Start worker normally
```

**Platform Behavior**:
- **All Platforms**: Consistent migration behavior
- **Mac/Linux/Windows**: File created on first hook trigger

**Manual Intervention**:
```bash
# Force re-migration (all platforms)
rm ~/.claude-mem/.pm2-migrated
# Next hook trigger will re-run PM2 cleanup

# Check migration status
ls -la ~/.claude-mem/.pm2-migrated  # Mac/Linux
dir %USERPROFILE%\.claude-mem\.pm2-migrated  # Windows

cat ~/.claude-mem/.pm2-migrated
# Output: 2025-12-13T00:18:39.673Z
```

### File Permissions

**PID and Port Files**:
```bash
-rw-r--r--  1 user  staff  5 Dec 13 00:18 .worker.pid
-rw-r--r--  1 user  staff 11 Dec 13 00:18 .worker.port
```
- Readable by all (needed for status checks)
- Writable by owner only

**Migration Marker**:
```bash
-rw-r--r--  1 user  staff 25 Dec 13 00:18 .pm2-migrated
```
- Readable by all
- Writable by owner only
- Content not sensitive (just timestamp)

**Database**:
```bash
-rw-r--r--  1 user  staff 10485760 Dec 13 00:20 claude-mem.db
```
- Readable/writable by owner
- Contains user data (observations, sessions)

### State Directory Structure

**Before Migration** (PM2 system):
```
~/.claude-mem/
├── claude-mem.db          # Database (unchanged)
├── chroma/                # Vector embeddings (unchanged)
├── logs/                  # Application logs (unchanged)
└── settings.json          # User settings (unchanged)

~/.pm2/
├── logs/
│   ├── claude-mem-worker-out.log
│   └── claude-mem-worker-error.log
├── pids/
│   └── claude-mem-worker.pid
└── pm2.log
```

**After Migration** (Bun system):
```
~/.claude-mem/
├── claude-mem.db          # Database (same file)
├── chroma/                # Vector embeddings (unchanged)
├── logs/
│   └── worker-2025-12-13.log  # New log format
├── settings.json          # User settings (unchanged)
├── .worker.pid            # ← NEW: Process ID
├── .worker.port           # ← NEW: Port + PID
└── .pm2-migrated          # ← NEW: Migration marker (all platforms)

~/.pm2/                    # ← Orphaned (safe to delete)
├── logs/                  # Old logs (no longer written)
├── pids/                  # Old PID (no longer updated)
└── pm2.log                # PM2 daemon log (not used)
```

---

## Edge Cases and Troubleshooting

### Scenario 1: Migration Fails (PM2 Still Running)

**Symptoms**:
- `pm2 list` still shows `claude-mem-worker`
- Port conflict errors in logs
- Worker fails to start

**Diagnosis**:
```bash
# Check if old PM2 worker running
pm2 list

# Check migration marker
cat ~/.claude-mem/.pm2-migrated
# If missing → migration not attempted or failed
```

**Causes**:
1. PM2 cleanup threw exception (caught silently)
2. PM2 process resurrection (if configured with `--watch`)
3. User manually started PM2 worker after migration

**Resolution**:
```bash
# Manual cleanup
pm2 delete claude-mem-worker
pm2 save  # Persist the deletion

# Force re-migration (optional)
rm ~/.claude-mem/.pm2-migrated

# Restart worker
npm run worker:restart
```

### Scenario 2: Stale PID File (Process Dead)

**Symptoms**:
- `npm run worker:status` shows "not running"
- `.worker.pid` file exists
- Process ID doesn't exist in `ps aux`

**Diagnosis**:
```bash
# Check PID file
cat ~/.claude-mem/.worker.pid
# Example: 35557

# Check if process exists
ps aux | grep 35557
# No result → process dead

# Or use kill -0
kill -0 35557 2>&1
# Output: "No such process"
```

**Causes**:
1. Worker crashed
2. Process manually killed (`kill 35557`)
3. System reboot (PID file persists across reboots)

**Automatic Recovery**:
```
Next hook trigger:
1. Read PID: 35557
2. Check existence: Process dead
3. Cleanup: Delete .worker.pid
4. Action: Start new worker
5. Result: Automatic recovery
```

**Manual Resolution**:
```bash
# Clean up stale files
rm ~/.claude-mem/.worker.pid
rm ~/.claude-mem/.worker.port

# Start fresh worker
npm run worker:start
```

### Scenario 3: Port File PID Mismatch

**Symptoms**:
- Worker running but port unknown
- Port cache returns null
- Settings updates don't find worker

**Diagnosis**:
```bash
# Check PID file
cat ~/.claude-mem/.worker.pid
# Output: 36000

# Check port file
cat ~/.claude-mem/.worker.port
# Output:
# 37777
# 35557  ← Different PID!
```

**Causes**:
1. Worker restarted but port file not updated
2. Race condition during restart
3. Manual file modification

**Automatic Recovery**:
```typescript
// Code handles this automatically
const port = getWorkerPort();
if (port === null) {
  // PID mismatch detected, port file deleted
  // Re-read from settings
  return getPortFromSettings();
}
```

**Manual Resolution**:
```bash
# Remove stale port file
rm ~/.claude-mem/.worker.port

# Port will be re-read from settings on next access
```

### Scenario 4: Simultaneous Hook Triggers (Race Condition)

**Symptoms**:
- Multiple worker processes spawned
- Port binding failures
- Duplicate entries in logs

**Diagnosis**:
```bash
# Check for multiple workers
ps aux | grep worker-cli
# Shows 2+ worker processes

# Check port binding
lsof -i :37777
# Shows which process has the port
```

**Cause**:
- Two hooks fire simultaneously
- Both check PID file (missing)
- Both attempt to start worker
- First succeeds, second fails (port in use)

**Automatic Recovery**:
```
First worker:
1. Spawns successfully
2. Binds to port 37777
3. Writes PID file
4. Running

Second worker:
1. Spawns successfully
2. Attempts to bind to port 37777
3. Error: Address already in use
4. Worker exits
5. No PID file written (first worker owns it)

Result: One worker running (correct state)
```

**Prevention**:
```typescript
// ProcessManager.start() checks if already running
const isRunning = await this.isRunning();
if (isRunning) {
  return { success: true, pid: currentPid };
}
// Prevents double-start
```

### Scenario 5: Windows Platform Detection Fails

**Symptoms**:
- Windows system attempts PM2 cleanup
- Errors in logs about PM2 not found
- Migration marker created on Windows

**Diagnosis**:
```bash
# Check platform detection
node -e "console.log(process.platform)"
# Should output: win32

# Check marker file (shouldn't exist on Windows)
dir %USERPROFILE%\.claude-mem\.pm2-migrated
```

**Cause**:
- `process.platform` returns unexpected value
- Code running in WSL (reports 'linux' not 'win32')
- Environment misconfiguration

**Resolution**:
```bash
# If running in WSL, this is expected
# WSL reports 'linux' → PM2 cleanup runs
# This is correct behavior (treat WSL as Linux)

# If native Windows reporting wrong platform:
# File bug report (platform detection broken)
```

### Scenario 6: Health Check Fails (Worker Running but Unhealthy)

**Symptoms**:
- Worker process exists
- `npm run worker:status` shows "not running"
- HTTP health check fails

**Diagnosis**:
```bash
# Check process exists
cat ~/.claude-mem/.worker.pid
ps aux | grep $(cat ~/.claude-mem/.worker.pid)
# Process is running

# Check HTTP health
curl http://localhost:37777/health
# Connection refused or timeout
```

**Causes**:
1. Worker startup incomplete (still initializing)
2. Worker crashed after spawn (zombie process)
3. Port binding failed but process didn't exit
4. Firewall blocking localhost connections

**Automatic Recovery**:
```
Hook health check:
1. PID exists: YES
2. Process alive: YES
3. HTTP health: FAIL
4. Action: Kill process, restart worker
5. Result: Fresh worker spawned
```

**Manual Resolution**:
```bash
# Kill unhealthy worker
kill $(cat ~/.claude-mem/.worker.pid)

# Clean up state
rm ~/.claude-mem/.worker.pid
rm ~/.claude-mem/.worker.port

# Start fresh
npm run worker:start

# Verify health
curl http://localhost:37777/health
# Should return: {"status":"healthy"}
```

### Scenario 7: Fresh Install (Never Had PM2)

**Symptoms**:
- User installs claude-mem 7.0.10+ for first time
- No previous PM2 installation
- Migration marker created but PM2 cleanup fails

**Diagnosis**:
```bash
# Check PM2
pm2 list
# Output: command not found: pm2

# Check marker
cat ~/.claude-mem/.pm2-migrated
# File exists (created despite PM2 not found)
```

**Expected Behavior**:
```
First hook trigger:
1. Marker check: Missing
2. Platform check: Mac/Linux
3. PM2 cleanup: Attempted
4. Error: "command not found: pm2"
5. Catch block: Error ignored
6. Marker creation: Success
7. Worker start: Success

Result: Normal startup, marker created, no issues
```

**No Action Needed**: This is expected and correct behavior.

### Scenario 8: Manual Marker Deletion

**Symptoms**:
- User deletes `.pm2-migrated` file
- Next hook trigger runs PM2 cleanup again

**Diagnosis**:
```bash
# Check marker
ls ~/.claude-mem/.pm2-migrated
# File not found (user deleted it)
```

**Behavior**:
```
Next hook trigger:
1. Marker check: Missing
2. Platform check: Mac/Linux
3. PM2 cleanup: Attempted
4. Result: No PM2 worker exists (already cleaned)
5. Error: "process claude-mem-worker not found"
6. Catch block: Ignored
7. Marker recreation: Success
8. Worker start: Normal

Result: No harm done, marker recreated
```

**Impact**: Minimal (one extra PM2 command execution, ~1 second delay)

### Common Error Messages

**Error**: `EADDRINUSE: address already in use`
```
Cause: Another process (or old worker) using port
Resolution:
1. Check: lsof -i :37777
2. Kill: kill -9 <PID>
3. Restart: npm run worker:restart
```

**Error**: `No such process`
```
Cause: PID file references dead process
Resolution: Automatic cleanup on next hook trigger
Manual: rm ~/.claude-mem/.worker.pid && npm run worker:start
```

**Error**: `pm2: command not found` (during migration)
```
Cause: PM2 not installed (fresh install or already uninstalled)
Resolution: None needed (error is caught and ignored)
Impact: Migration completes normally
```

**Error**: `Invalid port X. Must be between 1024 and 65535`
```
Cause: Port validation failed
Resolution: Update settings to use valid port
Command: Edit ~/.claude-mem/settings.json
```

**Error**: `Failed to bind to port`
```
Cause: Port already in use, or permission denied (<1024)
Resolution:
1. Check: lsof -i :<port>
2. Change: Update CLAUDE_MEM_WORKER_PORT in settings
3. Restart: npm run worker:restart
```

---

## Developer Notes

### Testing the Migration

**Test Environment Setup**:
```bash
# 1. Install old version (with PM2)
git checkout <pre-7.0.10-tag>
npm install
npm run build
npm run sync-marketplace

# 2. Start PM2 worker
pm2 start plugin/scripts/worker-cli.js --name claude-mem-worker

# 3. Verify PM2 running
pm2 list  # Should show claude-mem-worker

# 4. Update to new version
git checkout main
npm install
npm run build
npm run sync-marketplace

# 5. Trigger hook (simulate Claude Code session)
# Open Claude Code, or manually trigger:
node plugin/scripts/session-start-hook.js

# 6. Verify migration
pm2 list  # Should NOT show claude-mem-worker
cat ~/.claude-mem/.pm2-migrated  # Should exist (all platforms)
npm run worker:status  # Should show Bun worker running
```

**Automated Testing**:
```bash
# Run test suite (includes migration tests)
npm test

# Specific migration tests
npm test -- src/services/process/ProcessManager.test.ts
```

### Architecture Decisions

**Why Custom ProcessManager Instead of PM2?**:
1. **Simplicity**: Direct control, no external daemon
2. **Dependencies**: Remove npm dependency
3. **Cross-platform**: Bun handles platform differences
4. **Bundle Size**: Reduce plugin package size
5. **Control**: Fine-grained error handling and validation

**Why PID File Instead of PM2 Daemon?**:
1. **Simplicity**: Filesystem-based state (no daemon)
2. **Debugging**: Easy to inspect (cat .worker.pid)
3. **Reliability**: No daemon failure scenarios
4. **Unix Philosophy**: Simple, composable tools

**Why One-Time Marker Instead of Always Running PM2 Delete?**:
1. **Performance**: Avoid unnecessary process spawning
2. **Idempotency**: Migration runs exactly once
3. **Debugging**: Timestamp shows when migration occurred
4. **Simplicity**: Clear migration state

**Why Run PM2 Cleanup on All Platforms?**:
1. **Quality Migration**: Clean up orphaned processes, even if PM2 had issues
2. **Consistency**: Same behavior across all platforms
3. **Safety**: Error handling already in place (try/catch)
4. **No Downside**: If PM2 not installed, error is caught and ignored

### Future Considerations

**Potential Improvements**:
1. **Systemd Integration** (Linux): Optional systemd unit file for system-level management
2. **launchd Integration** (macOS): Optional launchd plist for startup on boot
3. **Windows Service**: Optional Windows Service wrapper
4. **Process Monitoring**: Built-in restart on crash (without waiting for hook)
5. **Graceful Shutdown**: SIGTERM handler for clean database closing

**Migration Cleanup** (future version):
1. After ~6 months (all users migrated), remove PM2 cleanup code
2. Remove `.pm2-migrated` marker file logic
3. Simplify `startWorker()` function
4. Keep ProcessManager as permanent architecture

### Related Files

**Core Implementation**:
- `src/services/process/ProcessManager.ts` - Main process management
- `src/shared/worker-utils.ts` - Worker utilities, migration logic
- `src/cli/worker-cli.ts` - CLI commands

**Database**:
- `src/services/sqlite/Database.ts` - bun:sqlite integration
- `src/types/database.ts` - Type definitions

**Documentation**:
- `docs/public/architecture/database.mdx` - Database architecture
- `docs/public/architecture/overview.mdx` - System overview
- `plugin/skills/troubleshoot/operations/worker.md` - Worker troubleshooting

**Tests**:
- `src/services/process/ProcessManager.test.ts` - Process management tests
- `src/hooks/__tests__/full-lifecycle.test.ts` - Integration tests

### Code References

**Migration Marker Logic**:
```typescript
// src/shared/worker-utils.ts:76-86
const pm2MigratedMarker = join(DATA_DIR, '.pm2-migrated');

if (!existsSync(pm2MigratedMarker)) {
  try {
    spawnSync('pm2', ['delete', 'claude-mem-worker'], { stdio: 'ignore' });
    writeFileSync(pm2MigratedMarker, new Date().toISOString(), 'utf-8');
    logger.debug('SYSTEM', 'PM2 cleanup completed and marked');
  } catch {
    writeFileSync(pm2MigratedMarker, new Date().toISOString(), 'utf-8');
  }
}
```

**Port Validation**:
```typescript
// src/services/process/ProcessManager.ts:27-33
if (isNaN(port) || port < 1024 || port > 65535) {
  return {
    success: false,
    error: `Invalid port ${port}. Must be between 1024 and 65535`
  };
}
```

**Health Check Layers**:
```typescript
// src/shared/worker-utils.ts (conceptual)
// Layer 1: PID file check
const pidFile = join(DATA_DIR, '.worker.pid');
if (!existsSync(pidFile)) return false;

// Layer 2: Process existence check
const pid = parseInt(readFileSync(pidFile, 'utf-8'));
try {
  process.kill(pid, 0);
} catch {
  return false;
}

// Layer 3: HTTP health check
const response = await fetch(`http://localhost:${port}/health`);
return response.ok;
```

---

## Summary

The migration from PM2 to Bun-based ProcessManager is a **one-time, automatic, transparent** transition that:

1. **Removes external dependencies** (PM2, better-sqlite3)
2. **Simplifies architecture** (direct process control)
3. **Improves cross-platform support** (especially Windows)
4. **Preserves user data** (database, settings, logs unchanged)
5. **Requires no user action** (automatic on first hook trigger)

**Key Migration Moment**: First hook trigger after update to 7.0.10+
**Duration**: ~2-5 seconds (one-time delay)
**Impact**: Seamless transition, user-invisible
**Rollback**: Not needed (migration is forward-only, safe)

For most users, the migration will be completely transparent - they'll see no errors, no data loss, and experience improved reliability and simpler troubleshooting going forward.
