# Socket File Not Created - Debug Hypotheses

## Problem Statement
Worker process logs "Socket server listening: /Users/alexnewman/.claude-mem/worker-28.sock" but the socket file never appears on the filesystem. All connection attempts fail with `ENOENT`.

## Hypotheses (Ordered by Likelihood)

### H1: Worker Process Exits Immediately After Socket Creation
**Theory:** Worker creates socket, logs message, then crashes/exits before we poll for the file.

**Evidence:**
- We see the log message
- Socket never appears
- No other worker output after "listening" message

**Tests:**
- Check if worker process is running: `ps aux | grep worker`
- Add worker exit handlers to see exit code
- Check if worker.ts crashes after startSocketServer()

**Root Cause Possibilities:**
- Database query fails in loadSession() (worker.ts:75)
- SDK agent initialization crashes
- Unhandled promise rejection in run()

---

### H2: detached=false Kills Worker Prematurely
**Theory:** `detached: false` causes worker to die when replay script continues execution or when replay script changes process state.

**Evidence:**
- Production uses `detached: true, stdio: 'ignore'`
- Replay uses `detached: false, stdio: ['ignore', 'pipe', 'pipe']`
- Worker might be getting killed by parent process lifecycle

**Tests:**
- Change to `detached: true, stdio: 'ignore', worker.unref()`
- Check worker persists: `ps aux | grep worker` after spawn

**Expected Fix:**
- Worker should persist independently
- Socket should remain available

---

### H3: stdio Piping Interferes with Socket Creation
**Theory:** Piping stdout/stderr (`stdio: ['ignore', 'pipe', 'pipe']`) prevents proper socket file creation or causes worker to hang.

**Evidence:**
- Production uses `stdio: 'ignore'`
- We're trying to capture output with pipes
- This might interfere with Unix domain socket operations

**Tests:**
- Change to `stdio: 'ignore'` (no piping)
- Worker won't output to our console but should work

---

### H4: Socket Path Mismatch
**Theory:** Worker creates socket at different path than replay script expects.

**Evidence:**
- getWorkerSocketPath(sessionId) used in both places
- Both should resolve to ~/.claude-mem/worker-<id>.sock
- But maybe DATA_DIR differs between environments

**Tests:**
- Log actual socketPath in worker: `console.error('Creating socket at:', this.socketPath)`
- List all sockets: `ls -la ~/.claude-mem/*.sock`
- Check if socket appears elsewhere: `find /tmp -name "worker-*.sock"`

**Root Cause Possibilities:**
- CLAUDE_MEM_DATA_DIR environment variable difference
- Worker started with different env

---

### H5: Permissions Issue
**Theory:** Worker can't create socket file due to directory permissions.

**Evidence:**
- Socket creation might fail silently
- Worker logs "listening" before checking if socket file was created

**Tests:**
- Check ~/.claude-mem permissions: `ls -ld ~/.claude-mem`
- Try creating socket manually: `nc -U ~/.claude-mem/test.sock`
- Check worker user vs replay script user

**Expected Error:**
- Worker should throw EACCES or EPERM but we might not see it

---

### H6: Socket Listen Callback Fires Before File Creation
**Theory:** The server.listen() callback fires and logs "listening" before the socket file actually appears on filesystem.

**Evidence:**
- Node.js/Bun might call callback before filesystem sync
- We see log but no file

**Tests:**
- Add additional wait time after seeing log
- Add fs.existsSync check inside worker after listen()
- Increase poll duration/frequency in replay script

---

### H7: CLI Worker Command Routing Broken
**Theory:** `dist/claude-mem.min.js worker <sessionId>` doesn't properly route to worker.ts main().

**Evidence:**
- cli.ts has .command('worker') handler
- Handler imports and calls main() from sdk/worker.ts
- But bundling might break this

**Tests:**
- Run directly: `dist/claude-mem.min.js worker 28`
- Check if worker main() is actually called
- Add console.error at top of worker.ts main()

**Root Cause Possibilities:**
- Bundle doesn't include worker code
- Import path broken in minified CLI
- Commander routing fails

---

### H8: Database Session Not Found by Worker
**Theory:** Worker can't find session in database, exits early.

**Evidence:**
- loadSession() query might return null
- Code checks `if (!session) { exit(1) }` (worker.ts:76-79)
- But we'd expect to see error log

**Tests:**
- Verify session exists before spawn: `SELECT * FROM sdk_sessions WHERE id = ?`
- Add debug log in loadSession() before query
- Check DB file path matches

---

### H9: Socket File Created Then Immediately Deleted
**Theory:** Socket is created but something deletes it (cleanup from previous run, OS, etc).

**Evidence:**
- Old socket file might exist and get unlinked (worker.ts:110-112)
- Maybe multiple workers spawning

**Tests:**
- Check for multiple worker processes: `ps aux | grep worker`
- Watch filesystem in real-time: `watch ls -la ~/.claude-mem/`
- Add delay before cleanup code runs

---

### H10: Bun vs Node Runtime Issue
**Theory:** Worker runs under different runtime than expected, causing socket issues.

**Evidence:**
- Replay script uses bun: `#!/usr/bin/env bun`
- Worker spawned via CLI which uses node: `#!/usr/bin/env node`
- Runtime difference might affect socket creation

**Tests:**
- Spawn with explicit bun: `bun dist/claude-mem.min.js worker 28`
- Or spawn with explicit node
- Check if runtime matters for Unix sockets

---

### H11: Race Condition in Socket Server Startup
**Theory:** server.listen() completes but socket isn't ready for connections yet.

**Evidence:**
- We poll for 15 seconds
- Maybe socket file appears but isn't ready
- Connection attempts might be too early

**Tests:**
- Increase wait time after socket found
- Try connecting with retry logic
- Check socket file permissions/readiness

---

### H12: Worker Logs to Wrong Stream
**Theory:** Worker logs "listening" to stdout/stderr but then crashes, and we only see initial log.

**Evidence:**
- console.error used in worker (worker.ts:86)
- With stdio: ['ignore', 'pipe', 'pipe'], stderr is piped
- Maybe crash happens but we don't see it

**Tests:**
- Check full worker output captured
- Look for crash stack traces
- Add more logging throughout worker.run()

---

## Recommended Debug Sequence

1. **Change spawn config to match production exactly**
   - `detached: true`
   - `stdio: 'ignore'`
   - `worker.unref()`
   - This eliminates H2, H3

2. **Check worker process persistence**
   - `ps aux | grep worker` immediately after spawn
   - If not running → H1, H7, H8
   - If running → H4, H5, H6

3. **Check socket file location**
   - `ls -la ~/.claude-mem/*.sock`
   - `find /tmp -name "worker-*.sock"`
   - If found elsewhere → H4
   - If not found → H1, H5, H6

4. **Run worker directly for debugging**
   - `dist/claude-mem.min.js worker 28` manually
   - See full output
   - Check if socket appears

5. **Add more worker logging**
   - Log at start of main()
   - Log after loadSession()
   - Log after startSocketServer() promise resolves
   - Log socket path being used
