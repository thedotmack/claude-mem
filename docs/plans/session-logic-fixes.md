# Session Logic Fixes - Claude-Mem

**Status:** Planning
**Created:** 2025-10-16
**Priority:** High
**Estimated Effort:** 2-3 days

## Executive Summary

The claude-mem session logic architecture is fundamentally sound, using Claude Agent SDK in streaming input mode with Unix socket IPC for real-time observation processing. However, **we need to verify the basic happy path works end-to-end before addressing edge cases**.

**Critical Goal:** Session ends → summary generated → next session immediately sees summary in context

**Overall Assessment:** Architecture is correct, but needs systematic verification that the happy path works, then resilience improvements

**Current Status:** Unknown if basic cycle works - need to test and debug the core flow first

## Feedback Applied (2025-10-16)

### Round 1: Technical Corrections
- ✅ Confirmed architectural approach is sound
- ❌ **Corrected:** SessionEnd hooks already exist in Claude Code - we're configuring, not implementing
- ✅ Technical fixes for resilience issues are sound

### Round 2: Priority Reordering (MAJOR CHANGE)
**Critical realization:** The document focused on edge cases (zombies, crashes) when the basic happy path might not even work yet.

**Complete restructure:**
1. **Phase 0 (NEW - TOP PRIORITY):** Verify the basic cycle works
   - Does Stop hook fire on normal exit?
   - Does worker generate and store summary?
   - Does context hook load summaries on next session?
   - End-to-end integration test

2. **Phase 1 (SECOND PRIORITY):** Fix resilience issues
   - Zombie workers, race conditions, stale sockets
   - All the original issues moved here

**Key principle:** Everything else is irrelevant if "session ends → next session sees summary" doesn't work.

**Revised Focus:** Get the fucking happy path working first, then worry about edge cases.

## Architecture Overview

### Current Flow

```
SessionStart (startup)
  → context-hook.ts:15
  → Loads recent summaries from DB
  → Outputs markdown to stdout (becomes context)

UserPromptSubmit
  → new-hook.ts:16
  → Creates SDK session in DB (status='active')
  → Spawns detached worker process
  → Worker starts immediately, hooks return

Worker Process (worker.ts:75)
  → Starts Unix socket server at /tmp/claude-mem-worker-{id}.sock
  → Runs SDK agent with streaming input (async generator)
  → Yields init prompt to SDK agent
  → Waits for messages from hooks

PostToolUse (fired for each tool)
  → save-hook.ts:24
  → Sends observation to worker via Unix socket
  → Worker receives → yields to SDK agent
  → SDK agent analyzes → returns <observation> XML
  → Worker parses XML → stores in observations table

Stop (session ends)
  → summary-hook.ts:15
  → Sends FINALIZE message to worker via socket
  → Worker yields finalize prompt to SDK agent
  → SDK agent generates <summary> XML
  → Worker parses → stores in session_summaries table
  → Worker marks session completed, closes socket, exits
```

### Key Components

**Hook Files:**
- `src/hooks/context.ts` - SessionStart hook logic
- `src/hooks/new.ts` - UserPromptSubmit hook logic
- `src/hooks/save.ts` - PostToolUse hook logic
- `src/hooks/summary.ts` - Stop hook logic
- `src/bin/hooks/*.ts` - Entry point wrappers for each hook

**Worker:**
- `src/sdk/worker.ts` - Main worker process with SDK integration
- `src/sdk/prompts.ts` - Prompt generation for SDK agent
- `src/sdk/parser.ts` - XML parser for SDK responses

**Database:**
- `src/services/sqlite/HooksDatabase.ts` - Lightweight DB interface for hooks
- `src/services/sqlite/migrations.ts` - Schema definitions

**Configuration:**
- `hooks/hooks.json` - Hook configuration for Claude Code plugin

### Technologies

- **IPC:** Unix domain sockets (`/tmp/claude-mem-worker-{id}.sock`)
- **SDK Mode:** Streaming input (async generator pattern)
- **Output Format:** XML blocks (`<observation>` and `<summary>`)
- **Process Model:** Detached worker (spawn with detached: true, stdio: 'ignore')
- **Database:** SQLite with Bun

## Identified Issues

### Phase 0: Verify Happy Path Works (DO THIS FIRST)

**Priority:** CRITICAL - Everything else is irrelevant if the basic cycle doesn't work

**Goal:** Prove that when a session ends normally, the next session immediately sees the summary in its context.

#### Test 0.1: Does Stop Hook Fire on Normal Exit?

**What to test:**
```bash
# Start Claude Code session
claude

# Do some work (read files, etc)

# Exit normally
exit

# Check logs - did Stop hook run?
```

**Expected behavior:**
- Stop hook (`summary-hook`) should fire
- Should send FINALIZE message to worker socket
- Worker should receive it and generate summary

**How to verify:**
1. Add logging to `src/hooks/summary.ts` at the top of `summaryHook()`
2. Add logging when sending socket message
3. Exit session normally and check logs

**If it doesn't work:** Debug why Stop hook isn't firing or why socket message fails

---

#### Test 0.2: Does Worker Receive FINALIZE and Generate Summary?

**What to test:**
After Stop hook fires, does the worker:
1. Receive the FINALIZE message
2. Yield finalize prompt to SDK agent
3. Get back a summary from SDK
4. Parse the XML
5. Store it in `session_summaries` table

**How to verify:**
1. Add console.error logging in `src/sdk/worker.ts:239` in the message handler
2. Log when FINALIZE is received
3. Log the SDK agent response
4. Log when summary is parsed
5. Query DB after session ends:
   ```bash
   sqlite3 ~/.claude-mem/data/claude-mem.db "SELECT * FROM session_summaries ORDER BY created_at DESC LIMIT 1"
   ```

**If it doesn't work:**
- Check if worker is even running (ps aux | grep worker)
- Check if socket message arrived
- Check if SDK agent returned valid XML
- Check if parser worked
- Check if DB insert succeeded

---

#### Test 0.3: Does Context Hook Load Summaries?

**What to test:**
When starting a new session, does context hook:
1. Query recent summaries from DB
2. Format them as markdown
3. Output to stdout (becomes context)

**How to verify:**
1. Add logging to `src/hooks/context.ts:24`
2. Log the summaries retrieved from DB
3. Log the markdown output
4. Start new session and check:
   - Console output (should see markdown)
   - Claude's context (ask "what did we do last session?")

**If it doesn't work:**
- Check if SessionStart hook is firing
- Check if DB query returns results
- Check if markdown is being formatted correctly
- Check if output is going to stdout properly

---

#### Test 0.4: End-to-End Integration Test

**What to test:**
Full cycle from start to finish:

```bash
# Session 1
claude
# Do some work
echo "test file" > test.txt
cat test.txt
exit

# Verify summary was stored
sqlite3 ~/.claude-mem/data/claude-mem.db "SELECT summary_text FROM session_summaries ORDER BY created_at DESC LIMIT 1"

# Session 2
claude
# Ask Claude: "What did we do last session?"
# Expected: Claude should know we created and read test.txt
```

**Success criteria:**
- ✅ Summary appears in DB after session 1
- ✅ Session 2 context includes summary from session 1
- ✅ Claude can answer questions about previous session

**If it doesn't work:**
- Review logs from Tests 0.1-0.3
- Add more granular logging
- Check each step of the pipeline

---

#### Common Failure Points & Debugging

**If summaries aren't showing up in new sessions:**

1. **Stop hook not configured/firing:**
   ```bash
   # Check hooks config
   cat ~/.claude/plugins/claude-mem/hooks.json | jq '.hooks.Stop'

   # Should see summary-hook configured
   # If not, hooks.json is wrong or plugin not installed
   ```

2. **Worker not running:**
   ```bash
   ps aux | grep claude-mem-worker

   # If no worker, UserPromptSubmit hook failed to spawn it
   # Check new-hook logs
   ```

3. **Socket communication failing:**
   ```bash
   # Check socket exists
   ls /tmp/claude-mem-worker-*.sock

   # Try to connect manually
   echo '{"type":"finalize"}' | nc -U /tmp/claude-mem-worker-*.sock
   ```

4. **SDK agent not returning summary:**
   - Check API key is set
   - Check SDK agent prompt is valid
   - Check XML parser is working
   - Add logging to see SDK response

5. **DB write failing:**
   ```bash
   # Check DB exists and is writable
   sqlite3 ~/.claude-mem/data/claude-mem.db "SELECT * FROM sdk_sessions WHERE status='active'"

   # If no active session, new-hook didn't create it
   ```

6. **Context hook not loading:**
   ```bash
   # Check SessionStart hook configured
   cat ~/.claude/plugins/claude-mem/hooks.json | jq '.hooks.SessionStart'

   # Start session and check for context output
   # Should see markdown in initial context
   ```

**Debugging Checklist:**
- [ ] Verify all hooks are configured in hooks.json
- [ ] Verify plugin is installed correctly
- [ ] Add console.error logging to all hooks (goes to stderr, visible in terminal)
- [ ] Check each step of the pipeline systematically
- [ ] Don't assume anything works - verify each piece

---

### Phase 1: Critical Resilience Issues (Fix After Happy Path Works)

#### 1. Zombie Worker Processes

**Severity:** High
**Impact:** Memory/CPU waste, orphaned processes accumulate

**Problem:**
If Stop hook never fires (user Ctrl-C, Claude Code crash), worker runs forever waiting for FINALIZE message.

**Location:** `src/sdk/worker.ts:239`
```typescript
// Current code - infinite loop with no timeout
while (!this.isFinalized) {
  if (this.pendingMessages.length === 0) {
    await this.sleep(100);
    continue;
  }
  // ... process messages
}
```

**Fix Required:**
```typescript
// Add watchdog timer
class SDKWorker {
  private maxIdleTime = 2 * 60 * 60 * 1000; // 2 hours
  private lastActivityTime = Date.now();

  private updateActivity(): void {
    this.lastActivityTime = Date.now();
  }

  private async* createMessageGenerator(): AsyncIterable<...> {
    // Yield initial prompt
    const initPrompt = buildInitPrompt(...);
    yield { type: 'user', message: { role: 'user', content: initPrompt } };
    this.updateActivity();

    while (!this.isFinalized) {
      // Check for timeout
      const idleTime = Date.now() - this.lastActivityTime;
      if (idleTime > this.maxIdleTime) {
        console.error(`[SDK Worker] Timeout - no activity for ${this.maxIdleTime / 1000}s`);
        this.isFinalized = true;
        break;
      }

      if (this.pendingMessages.length === 0) {
        await this.sleep(100);
        continue;
      }

      // Process messages and update activity
      this.updateActivity();
      // ... existing message processing
    }
  }
}
```

**Testing:**
1. Start claude-mem session
2. Kill Claude Code process (kill -9)
3. Verify worker exits after 2 hours
4. Check no orphaned processes remain

---

#### 2. SessionEnd Hook Not Configured

**Severity:** High
**Impact:** No cleanup on abrupt exit, sessions stuck in "active" status

**Problem:**
SessionEnd hooks are a built-in Claude Code feature that "run when a session ends" and "cannot block session termination but can perform cleanup tasks" ([docs](https://docs.claude.com/en/docs/claude-code/hooks#hook-events)). However, claude-mem's `hooks/hooks.json` does NOT configure this hook. Worker doesn't get cleaned up when Claude Code exits abruptly.

**Note:** This is NOT a missing feature in Claude Code - SessionEnd hooks already exist. We just need to configure them.

**Current Configuration:** `hooks/hooks.json:1-51`
```json
{
  "hooks": {
    "SessionStart": [...],
    "UserPromptSubmit": [...],
    "PostToolUse": [...],
    "Stop": [...]
    // SessionEnd is MISSING
  }
}
```

**Fix Required:**

SessionEnd hooks receive structured input including:
```json
{
  "session_id": "abc123",
  "transcript_path": "~/.claude/projects/.../transcript.jsonl",
  "cwd": "/Users/...",
  "hook_event_name": "SessionEnd",
  "reason": "exit"  // or "clear", "logout", "prompt_input_exit", etc.
}
```

**Implementation Steps:**

1. **Add SessionEnd configuration to hooks/hooks.json:**

For events like SessionEnd that don't use matchers, we can omit the matcher field:

```json
{
  "hooks": {
    "SessionEnd": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "bun ${CLAUDE_PLUGIN_ROOT}/scripts/hooks/cleanup-hook.js",
            "timeout": 60000
          }
        ]
      }
    ]
  }
}
```

2. **Create src/hooks/cleanup.ts:**
```typescript
import { HooksDatabase } from '../services/sqlite/HooksDatabase.js';
import { getWorkerSocketPath } from '../shared/paths.js';
import { existsSync, unlinkSync } from 'fs';
import { execSync } from 'child_process';

export interface SessionEndInput {
  session_id: string;
  cwd: string;
  reason: 'clear' | 'logout' | 'prompt_input_exit' | 'other';
  [key: string]: any;
}

/**
 * Cleanup Hook - SessionEnd
 * Cleans up worker process and marks session as terminated
 */
export function cleanupHook(input?: SessionEndInput): void {
  try {
    if (!input) {
      console.log('No input provided - this script is designed to run as a Claude Code SessionEnd hook');
      process.exit(0);
    }

    const { session_id, reason } = input;

    // Find active SDK session
    const db = new HooksDatabase();
    const session = db.findActiveSDKSession(session_id);

    if (!session) {
      db.close();
      console.log('{"suppressOutput": true}');
      process.exit(0);
    }

    // Get socket path and clean up socket file
    const socketPath = getWorkerSocketPath(session.id);
    if (existsSync(socketPath)) {
      try {
        unlinkSync(socketPath);
      } catch (err) {
        console.error(`[claude-mem cleanup] Failed to remove socket: ${err.message}`);
      }
    }

    // Mark session as failed (not completed since it was terminated)
    db.markSessionFailed(session.id);
    db.close();

    // Try to kill worker process if still running
    // Worker socket path includes session ID, so we can find it
    try {
      // Find worker process by socket file in lsof output
      const lsofOutput = execSync(`lsof ${socketPath} 2>/dev/null || true`, { encoding: 'utf8' });
      const pidMatch = lsofOutput.match(/\s+(\d+)\s+/);
      if (pidMatch) {
        const pid = pidMatch[1];
        console.error(`[claude-mem cleanup] Killing worker process ${pid}`);
        process.kill(parseInt(pid, 10), 'SIGTERM');
      }
    } catch (err) {
      // Worker already dead or couldn't find it - that's fine
    }

    console.log('{"suppressOutput": true}');
    process.exit(0);

  } catch (error: any) {
    console.error(`[claude-mem cleanup error: ${error.message}]`);
    console.log('{"suppressOutput": true}');
    process.exit(0);
  }
}
```

3. **Create src/bin/hooks/cleanup-hook.ts:**
```typescript
#!/usr/bin/env bun

/**
 * Cleanup Hook Entry Point - SessionEnd
 * Standalone executable for plugin hooks
 */

import { cleanupHook } from '../../hooks/cleanup.js';

// Read input from stdin
const input = await Bun.stdin.text();

try {
  const parsed = input.trim() ? JSON.parse(input) : undefined;
  cleanupHook(parsed);
} catch (error: any) {
  console.error(`[claude-mem cleanup-hook error: ${error.message}]`);
  console.log('{"suppressOutput": true}');
  process.exit(0);
}
```

4. **Update build process to compile cleanup-hook.ts to scripts/hooks/cleanup-hook.js**

**Testing:**
1. Start claude-mem session
2. Exit Claude Code with Ctrl-C
3. Verify worker process is killed
4. Verify socket file is removed
5. Verify session marked as "failed" in DB

---

#### 3. Stale Socket Files Block New Sessions

**Severity:** Medium
**Impact:** Worker fails to start if previous worker crashed

**Problem:**
If worker crashes, socket file persists at `/tmp/claude-mem-worker-{id}.sock`. Next worker with same session ID fails with EADDRINUSE.

**Location:** `src/sdk/worker.ts:111-163`
```typescript
private async startSocketServer(): Promise<void> {
  // Current code only removes if exists
  if (existsSync(this.socketPath)) {
    unlinkSync(this.socketPath);
  }

  return new Promise((resolve, reject) => {
    this.server = net.createServer((socket) => { ... });
    this.server.listen(this.socketPath, () => { resolve(); });
  });
}
```

**Fix Required:**
```typescript
private async startSocketServer(): Promise<void> {
  // Clean up stale socket if it exists
  if (existsSync(this.socketPath)) {
    // Test if socket is responsive
    const isStale = await this.testSocketStale(this.socketPath);
    if (isStale) {
      console.error(`[SDK Worker] Removing stale socket: ${this.socketPath}`);
      unlinkSync(this.socketPath);
    } else {
      // Socket is active - another worker is using this session ID
      throw new Error(`Socket already in use: ${this.socketPath}`);
    }
  }

  return new Promise((resolve, reject) => {
    this.server = net.createServer((socket) => {
      let buffer = '';
      socket.on('data', (chunk) => {
        // ... existing code
      });
    });

    this.server.on('error', (err: any) => {
      if (err.code === 'EADDRINUSE') {
        console.error(`[SDK Worker] Socket already in use: ${this.socketPath}`);
      }
      reject(err);
    });

    this.server.listen(this.socketPath, () => {
      resolve();
    });
  });
}

/**
 * Test if socket file is stale (no process listening)
 */
private async testSocketStale(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const testClient = net.connect(socketPath);

    testClient.on('connect', () => {
      // Socket is responsive - not stale
      testClient.end();
      resolve(false);
    });

    testClient.on('error', () => {
      // Socket exists but not responsive - stale
      resolve(true);
    });

    // Timeout after 100ms
    setTimeout(() => {
      testClient.destroy();
      resolve(true);
    }, 100);
  });
}
```

**Testing:**
1. Start worker, kill it with kill -9
2. Verify socket file persists
3. Start new worker with same session ID
4. Verify old socket is detected as stale and removed
5. Verify new worker starts successfully

---

#### 4. Race Condition on First Observation

**Severity:** Medium
**Impact:** First observation might be lost if socket not ready

**Problem:**
Worker startup is async (socket creation, SDK initialization). PostToolUse can fire immediately after UserPromptSubmit returns, before socket is ready.

**Current Flow:**
1. UserPromptSubmit → creates session → spawns worker → returns immediately
2. PostToolUse fires (Claude reads a file)
3. save-hook tries to connect → ENOENT (socket not ready yet)
4. Connection fails → logs error, continues
5. First observation lost

**Location:** `src/hooks/save.ts:71`
```typescript
const client = net.connect(socketPath, () => {
  client.write(JSON.stringify(message) + '\n');
  client.end();
});

client.on('error', (err) => {
  // Currently just logs and continues - observation lost
  console.error(`[claude-mem save] Socket error: ${err.message}`);
});
```

**Fix Required:**
```typescript
/**
 * Save Hook - PostToolUse
 * Sends tool observations to worker via Unix socket with retry logic
 */
export function saveHook(input?: PostToolUseInput): void {
  try {
    if (!input) {
      console.log('No input provided - this script is designed to run as a Claude Code PostToolUse hook');
      process.exit(0);
    }

    const { session_id, tool_name, tool_input, tool_output } = input;

    if (SKIP_TOOLS.has(tool_name)) {
      console.log('{"continue": true, "suppressOutput": true}');
      process.exit(0);
    }

    const db = new HooksDatabase();
    const session = db.findActiveSDKSession(session_id);
    db.close();

    if (!session) {
      console.log('{"continue": true, "suppressOutput": true}');
      process.exit(0);
    }

    const socketPath = getWorkerSocketPath(session.id);
    const message = {
      type: 'observation',
      tool_name,
      tool_input: JSON.stringify(tool_input),
      tool_output: JSON.stringify(tool_output)
    };

    // Try to send with retries
    sendWithRetry(socketPath, message, 5).then(() => {
      console.log('{"continue": true, "suppressOutput": true}');
      process.exit(0);
    }).catch((err) => {
      console.error(`[claude-mem save] Failed after retries: ${err.message}`);
      console.log('{"continue": true, "suppressOutput": true}');
      process.exit(0);
    });

  } catch (error: any) {
    console.error(`[claude-mem save error: ${error.message}]`);
    console.log('{"continue": true, "suppressOutput": true}');
    process.exit(0);
  }
}

/**
 * Send message to socket with exponential backoff retry
 */
async function sendWithRetry(
  socketPath: string,
  message: any,
  maxRetries: number
): Promise<void> {
  let retries = maxRetries;
  let delay = 100; // Start with 100ms

  while (retries > 0) {
    try {
      await sendMessage(socketPath, message);
      return; // Success
    } catch (err: any) {
      retries--;
      if (retries === 0) {
        throw err; // Out of retries
      }

      // Exponential backoff
      await sleep(delay);
      delay = Math.min(delay * 2, 2000); // Cap at 2s
    }
  }
}

/**
 * Send single message to socket
 */
function sendMessage(socketPath: string, message: any): Promise<void> {
  return new Promise((resolve, reject) => {
    const client = net.connect(socketPath, () => {
      client.write(JSON.stringify(message) + '\n');
      client.end();
      resolve();
    });

    client.on('error', (err) => {
      reject(err);
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
```

**Testing:**
1. Add artificial delay in worker startup
2. Fire PostToolUse immediately after UserPromptSubmit
3. Verify save-hook retries and succeeds
4. Verify observation is captured

---

### Medium Priority (Should Fix)

#### 5. Orphaned Active Sessions in Database

**Severity:** Low
**Impact:** DB bloat, confusion about session status

**Problem:**
Sessions marked "active" never transition to "completed" or "failed" if worker crashes or is killed.

**Fix Required:**

Create cleanup script: `src/commands/cleanup-sessions.ts`
```typescript
import { HooksDatabase } from '../services/sqlite/HooksDatabase.js';

/**
 * Mark old active sessions as failed
 */
export function cleanupSessions(maxAgeHours: number = 24): void {
  const db = new HooksDatabase();
  const maxAgeMs = maxAgeHours * 60 * 60 * 1000;
  const cutoffEpoch = Date.now() - maxAgeMs;

  const query = (db as any).db.query(`
    UPDATE sdk_sessions
    SET status = 'failed', completed_at = datetime('now'), completed_at_epoch = ?
    WHERE status = 'active' AND started_at_epoch < ?
  `);

  const result = query.run(Date.now(), cutoffEpoch);
  console.log(`Marked ${result.changes} old active sessions as failed`);

  db.close();
}
```

Add to CLI: `src/bin/cli.ts`
```typescript
.command('cleanup-sessions')
.description('Mark old active sessions as failed')
.option('--max-age <hours>', 'Maximum age in hours', '24')
.action((options) => {
  cleanupSessions(parseInt(options.maxAge, 10));
})
```

**Alternative:** Add auto-expiry check in `context-hook`:
```typescript
// Before loading summaries, clean up stale sessions
const maxAgeMs = 24 * 60 * 60 * 1000;
const cutoffEpoch = Date.now() - maxAgeMs;
db.db.query(`
  UPDATE sdk_sessions
  SET status = 'failed'
  WHERE status = 'active' AND started_at_epoch < ?
`).run(cutoffEpoch);
```

---

#### 6. SessionStart Only Runs on "startup"

**Severity:** Low
**Impact:** No context loaded on /resume

**Problem:**
`context-hook` only loads context on "startup" source, skips "resume", "clear", and "compact".

**Location:** `src/hooks/context.ts:24`
```typescript
// Only run on startup (not on resume)
if (input.source && input.source !== 'startup') {
  console.log('');
  process.exit(0);
}
```

**Fix Required:**
```typescript
// Load context on startup and resume
if (input.source && input.source !== 'startup' && input.source !== 'resume') {
  console.log(''); // Skip for clear/compact
  process.exit(0);
}
```

**Rationale:**
- **startup:** Load context (project overview)
- **resume:** Load context (user continuing work)
- **clear:** Skip (user wants fresh start)
- **compact:** Skip (just memory optimization, context preserved)

---

### Low Priority (Nice to Have)

#### 7. No Cost Control or Observation Limits

**Severity:** Low
**Impact:** Long sessions can be expensive

**Problem:**
No limits on SDK agent API calls. A session with thousands of tools could rack up significant costs.

**Fix Ideas:**
1. Add observation counter, warn after N observations
2. Add cost estimation based on token usage
3. Add budget limit in config
4. Batch observations (send N at once instead of one-by-one)

**Example:**
```typescript
class SDKWorker {
  private observationCount = 0;
  private maxObservations = 1000;

  private handleMessage(message: WorkerMessage): void {
    if (message.type === 'observation') {
      this.observationCount++;
      if (this.observationCount > this.maxObservations) {
        console.error(`[SDK Worker] Exceeded max observations: ${this.maxObservations}`);
        this.isFinalized = true;
        return;
      }
    }
    this.pendingMessages.push(message);
  }
}
```

---

#### 8. No Health Check Mechanism

**Severity:** Low
**Impact:** Can't tell if worker is alive/healthy

**Fix Ideas:**
1. Add `/status` command that checks for active workers
2. Add health check endpoint on socket (ping/pong)
3. Add metrics to DB (last_activity_at)

---

#### 9. No Observation Deduplication

**Severity:** Low
**Impact:** Duplicate observations if same tool executed multiple times

**Fix Ideas:**
1. Hash tool_name + tool_input + tool_output
2. Check for duplicate hash before storing
3. Or let SDK agent handle deduplication naturally

---

## Implementation Checklist

### Phase 0: Verify Happy Path (DO THIS FIRST - HIGHEST PRIORITY)

**Goal:** Prove the basic cycle works end-to-end before fixing edge cases.

- [ ] **Test 0.1: Verify Stop Hook Fires**
  - [ ] Add logging to `src/hooks/summary.ts`
  - [ ] Exit session normally and verify hook runs
  - [ ] Verify FINALIZE message is sent to socket

- [ ] **Test 0.2: Verify Worker Generates Summary**
  - [ ] Add logging to worker message handler
  - [ ] Verify FINALIZE message received
  - [ ] Verify SDK agent response
  - [ ] Verify summary parsed and stored in DB
  - [ ] Query DB to confirm summary exists

- [ ] **Test 0.3: Verify Context Hook Loads Summaries**
  - [ ] Add logging to `src/hooks/context.ts`
  - [ ] Start new session, verify summaries loaded
  - [ ] Verify markdown output to stdout
  - [ ] Verify Claude has context from previous session

- [ ] **Test 0.4: End-to-End Integration Test**
  - [ ] Run session 1 with test work
  - [ ] Verify summary in DB
  - [ ] Run session 2
  - [ ] Ask Claude about previous session
  - [ ] Confirm Claude has correct context

**STOP HERE:** Only proceed to Phase 1 after confirming all Phase 0 tests pass.

---

### Phase 1: Critical Resilience Fixes (Do After Phase 0)

- [ ] Add watchdog timer to worker (Issue #1)
  - [ ] Add lastActivityTime tracking
  - [ ] Add timeout check in message generator loop
  - [ ] Test with zombie worker scenario

- [ ] Configure existing SessionEnd hook (Issue #2)
  - [ ] Add SessionEnd configuration to hooks/hooks.json
  - [ ] Create src/hooks/cleanup.ts (implements cleanup logic)
  - [ ] Create src/bin/hooks/cleanup-hook.ts (entry point)
  - [ ] Update build process to compile cleanup-hook
  - [ ] Test with Ctrl-C exit and verify worker cleanup

- [ ] Fix stale socket detection (Issue #3)
  - [ ] Add testSocketStale method
  - [ ] Update startSocketServer to check for stale sockets
  - [ ] Test with crashed worker scenario

- [ ] Fix save-hook race condition (Issue #4)
  - [ ] Add sendWithRetry function
  - [ ] Add exponential backoff logic
  - [ ] Update save-hook to use retry logic
  - [ ] Test with immediate PostToolUse

### Phase 2: Medium Priority

- [ ] Add session cleanup script (Issue #5)
  - [ ] Create cleanup-sessions command
  - [ ] Add to CLI
  - [ ] Optional: Add auto-cleanup to context-hook

- [ ] Fix SessionStart source handling (Issue #6)
  - [ ] Update context-hook to load on "resume"
  - [ ] Test with /resume command

### Phase 3: Low Priority (Optional)

- [ ] Add cost control (Issue #7)
- [ ] Add health checks (Issue #8)
- [ ] Add observation deduplication (Issue #9)

## Testing Strategy

### Unit Tests

Create tests for each fix:
- `test/hooks/cleanup.test.ts` - SessionEnd hook
- `test/sdk/worker-timeout.test.ts` - Watchdog timer
- `test/hooks/save-retry.test.ts` - Retry logic

### Integration Tests

Test complete flows:
1. **Normal flow:** SessionStart → UserPromptSubmit → PostToolUse → Stop
2. **Crash recovery:** Worker crash → SessionEnd cleanup
3. **Zombie worker:** No Stop hook → Worker timeout
4. **Socket race:** Immediate PostToolUse → Retry success

### Manual Testing Scenarios

1. **Zombie Worker Test:**
   ```bash
   # Start session
   claude
   # Kill Claude with Ctrl-C
   # Check for worker process
   ps aux | grep claude-mem-worker
   # Wait 2 hours, verify worker exits
   ```

2. **SessionEnd Test:**
   ```bash
   # Start session
   claude
   # Exit normally or Ctrl-C
   # Verify worker killed
   # Verify socket removed
   # Check DB for session status
   sqlite3 ~/.claude-mem/data/claude-mem.db "SELECT * FROM sdk_sessions"
   ```

3. **Stale Socket Test:**
   ```bash
   # Start session
   claude
   # Kill worker with kill -9 <pid>
   # Verify socket exists
   ls /tmp/claude-mem-worker-*.sock
   # Start new session
   # Verify old socket removed, new session starts
   ```

4. **Race Condition Test:**
   ```bash
   # Add delay to worker startup (for testing)
   # Start session, immediately run command
   claude "list all files"
   # Verify first observation captured
   ```

## File Modifications Required

### New Files
- `src/hooks/cleanup.ts` - SessionEnd hook logic
- `src/bin/hooks/cleanup-hook.ts` - SessionEnd entry point
- `src/commands/cleanup-sessions.ts` - Session cleanup script
- `test/hooks/cleanup.test.ts` - Tests for SessionEnd hook
- `test/sdk/worker-timeout.test.ts` - Tests for watchdog timer
- `test/hooks/save-retry.test.ts` - Tests for retry logic

### Modified Files
- `hooks/hooks.json` - Add SessionEnd configuration
- `src/sdk/worker.ts` - Add watchdog timer, stale socket detection
- `src/hooks/save.ts` - Add retry logic
- `src/hooks/context.ts` - Load context on resume
- `src/bin/cli.ts` - Add cleanup-sessions command

## Dependencies

No new dependencies required. All fixes use existing:
- `net` (Unix sockets)
- `fs` (file operations)
- `child_process` (process management)
- `bun:sqlite` (database)

## Success Criteria

### Phase 0 (Must Pass First)
1. ✅ Stop hook fires on normal exit
2. ✅ Worker receives FINALIZE and generates summary
3. ✅ Summary is stored in DB correctly
4. ✅ Context hook loads summaries on next session
5. ✅ New session immediately sees previous session's summary in context
6. ✅ End-to-end integration test passes

### Phase 1 (After Phase 0 Passes)
1. ✅ Worker processes never become zombies (exit after 2h max)
2. ✅ SessionEnd hook cleans up worker and socket on exit
3. ✅ Stale sockets don't block new sessions
4. ✅ First observation always captured (no race condition)
5. ✅ No orphaned "active" sessions in DB after 24h
6. ✅ Context loads on /resume
7. ✅ All tests pass

## References

- Claude Code Hooks Documentation: https://docs.claude.com/en/docs/claude-code/hooks
- Claude Agent SDK Streaming: https://docs.claude.com/en/api/agent-sdk/streaming-vs-single-mode
- Unix Domain Sockets: Node.js `net` module
- SQLite Best Practices: Bun SQLite documentation

## Notes

- All hooks must return `{"continue": true, "suppressOutput": true}` on error
- Hooks have 60s default timeout (configurable)
- Worker is detached process, doesn't block Claude Code
- SessionEnd hooks "cannot block session termination" per Claude Code docs
- Streaming input mode is the recommended SDK approach for this architecture
