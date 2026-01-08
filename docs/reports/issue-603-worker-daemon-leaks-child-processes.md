# Technical Report: Worker Daemon Child Process Leak

**Issue:** #603 - Bug: worker-service daemon leaks child claude processes
**Author:** raulk
**Created:** 2026-01-07
**Report Version:** 1.0
**Severity:** Critical
**Priority:** P0 - Immediate attention required

---

## 1. Executive Summary

The `worker-service.cjs --daemon` process spawns Claude subagent processes via the Claude Agent SDK that are not being properly terminated when their tasks complete. Over the course of normal usage (6+ hours), this results in the accumulation of orphaned child processes that consume significant system memory.

**Key Findings:**
- 121 orphaned `claude` processes accumulated over ~6 hours
- Total memory consumption: ~44GB RSS
- Average memory per process: ~372MB
- Root cause: Missing child process cleanup after SDK query completion
- The issue affects Linux systems and potentially all platforms

**Recommendation:** Implement explicit child process tracking and cleanup in the SDK agent lifecycle, and add process reaping on generator completion.

---

## 2. Problem Analysis

### 2.1 Observed Behavior

The reporter documented the following scenario:

**Parent daemon process (running 7+ hours):**
```
PID     PPID  RSS(KB)  ELAPSED   COMMAND
4118969 1     161656   07:28:16  bun ~/.claude/plugins/cache/thedotmack/claude-mem/9.0.0/scripts/worker-service.cjs --daemon
```

**Sample of leaked children (121 total, all parented to daemon):**
```
PID   PPID    RSS(KB)  ELAPSED   COMMAND
1927  4118969 377308   06:21:16  claude --output-format stream-json --verbose --input-format stream-json --model claude-sonnet-4-5 --disallowedTools Bash,Read,Write,Edit,Grep,Glob,WebFetch,WebSearch,Task,NotebookEdit,AskUserQuestion,TodoWrite --setting-sources --permission-mode default
2834  4118969 384716   06:20:44  claude --output-format stream-json [...]
3988  4118969 381844   06:20:15  claude --output-format stream-json --resume <session-id> [...]
5938  4118969 382816   06:19:37  claude --output-format stream-json --resume <session-id> [...]
11503 4118969 381276   06:16:12  claude --output-format stream-json --resume <session-id> [...]
```

### 2.2 Reproduction Steps

1. Use claude-mem normally throughout a work session
2. Run: `ps -o pid,ppid,rss,etime --no-headers | awk '$2 == '$(pgrep -f worker-service.cjs)`
3. Count grows over time without bound

### 2.3 Expected Behavior

Child claude processes should terminate when their task completes, or the daemon should reap them.

---

## 3. Technical Details

### 3.1 Architecture Overview

The claude-mem worker service uses a modular architecture:

```
WorkerService (worker-service.ts)
    |
    +-- SDKAgent (SDKAgent.ts)
    |       |
    |       +-- query() from @anthropic-ai/claude-agent-sdk
    |               |
    |               +-- Spawns `claude` CLI subprocess
    |
    +-- SessionManager (SessionManager.ts)
    |       |
    |       +-- Manages active sessions
    |       +-- Event-driven message queues
    |
    +-- ProcessManager (ProcessManager.ts)
            |
            +-- Child process enumeration
            +-- Graceful shutdown cleanup
```

### 3.2 SDK Agent Child Process Spawning

The `SDKAgent.startSession()` method invokes the Claude Agent SDK's `query()` function:

```typescript
// src/services/worker/SDKAgent.ts (lines 100-114)
const queryResult = query({
  prompt: messageGenerator,
  options: {
    model: modelId,
    ...(hasRealMemorySessionId && session.lastPromptNumber > 1 && { resume: session.memorySessionId }),
    disallowedTools,
    abortController: session.abortController,
    pathToClaudeCodeExecutable: claudePath
  }
});
```

The `query()` function internally spawns a `claude` CLI subprocess with the parameters visible in the leaked process list:
- `--output-format stream-json`
- `--verbose`
- `--input-format stream-json`
- `--model claude-sonnet-4-5`
- `--disallowedTools ...`
- `--setting-sources`
- `--permission-mode default`

### 3.3 Session Lifecycle

Sessions are managed through the following flow:

1. **Initialization:** `SessionRoutes.handleSessionInit()` creates a session and starts a generator
2. **Processing:** `SDKAgent.startSession()` runs the query loop, processing messages from the queue
3. **Completion:** Generator promise resolves, triggering cleanup in `finally` block

The relevant generator lifecycle code in `SessionRoutes.ts` (lines 137-216):

```typescript
session.generatorPromise = agent.startSession(session, this.workerService)
  .catch(error => { /* error handling */ })
  .finally(() => {
    session.generatorPromise = null;
    session.currentProvider = null;
    this.workerService.broadcastProcessingStatus();

    // Crash recovery logic...
    if (!wasAborted) {
      // Check for pending work and potentially restart
    }
  });
```

### 3.4 Graceful Shutdown Implementation

The existing shutdown mechanism in `GracefulShutdown.ts` (lines 49-90) does handle child processes, but **only during daemon shutdown**:

```typescript
export async function performGracefulShutdown(config: GracefulShutdownConfig): Promise<void> {
  // STEP 1: Enumerate all child processes BEFORE we start closing things
  const childPids = await getChildProcesses(process.pid);

  // ... other cleanup steps ...

  // STEP 6: Force kill any remaining child processes (Windows zombie port fix)
  if (childPids.length > 0) {
    for (const pid of childPids) {
      await forceKillProcess(pid);
    }
    await waitForProcessesExit(childPids, 5000);
  }
}
```

**Critical Gap:** This cleanup only runs when the daemon itself shuts down, not when individual SDK sessions complete.

---

## 4. Impact Assessment

### 4.1 Resource Consumption

| Metric | Value |
|--------|-------|
| Leaked processes | 121 |
| Total RSS | ~44GB |
| Average per process | ~372MB |
| Accumulation rate | ~20 processes/hour |
| Time to exhaustion (64GB system) | ~3 hours |

### 4.2 System Effects

1. **Memory Exhaustion:** Systems with limited RAM will experience OOM conditions
2. **Performance Degradation:** Swap thrashing as memory fills
3. **Process Table Pollution:** Maximum PID limits may be approached
4. **User Experience:** System becomes unresponsive during extended sessions

### 4.3 Affected Platforms

- **Linux (confirmed):** Ubuntu reported by issue author
- **macOS (likely):** Same process spawning mechanism
- **Windows (potentially different):** Uses different child process tracking

---

## 5. Root Cause Analysis

### 5.1 Primary Root Cause

**The SDK's `query()` function spawns a child `claude` process that is not being explicitly terminated when the async iterator completes.**

The `SDKAgent.startSession()` method:
1. Creates an async generator via `query()`
2. Iterates over messages via `for await (const message of queryResult)`
3. When iteration completes (naturally or via abort), the generator resolves
4. **No explicit cleanup of the underlying child process occurs**

### 5.2 Contributing Factors

1. **No Child Process Tracking:** The codebase does not maintain a registry of spawned child processes during normal operation - only during shutdown enumeration.

2. **AbortController Not Triggering Process Kill:** While sessions have an `abortController`, signaling abort to the SDK iterator does not guarantee the underlying `claude` process terminates.

3. **Generator Finally Block Missing Process Cleanup:** The `finally` block in `SessionRoutes.startGeneratorWithProvider()` handles state cleanup but does not explicitly kill child processes.

4. **SDK Abstraction Hiding Process Details:** The `@anthropic-ai/claude-agent-sdk` abstracts the subprocess management, making it difficult to access and terminate the child process directly.

### 5.3 Code Path Analysis

```
User Session Complete
        |
        v
SDKAgent.startSession() completes for-await loop
        |
        v
Generator promise resolves
        |
        v
SessionRoutes finally block executes
        |
        +-- session.generatorPromise = null
        +-- session.currentProvider = null
        +-- broadcastProcessingStatus()
        +-- Check pending work
        |
        v
[MISSING] Child process termination
        |
        v
Claude subprocess continues running (LEAKED)
```

---

## 6. Recommended Solutions

### 6.1 Solution A: SDK-Level Child Process Tracking (Preferred)

Add explicit child process tracking to the SDKAgent class:

```typescript
// src/services/worker/SDKAgent.ts

export class SDKAgent {
  private activeChildProcesses: Map<number, { pid: number, sessionDbId: number }> = new Map();

  async startSession(session: ActiveSession, worker?: WorkerRef): Promise<void> {
    // Before query(), track that we're about to spawn
    const queryResult = query({...});

    // After first message, capture the PID if available
    // Note: May require SDK modification to expose PID

    try {
      for await (const message of queryResult) {
        // ... existing message handling
      }
    } finally {
      // Cleanup: Kill any child process for this session
      this.cleanupSessionProcess(session.sessionDbId);
    }
  }

  private cleanupSessionProcess(sessionDbId: number): void {
    // Find and terminate process for this session
    // Requires either SDK enhancement or platform-specific process enumeration
  }
}
```

**Challenges:** The SDK does not currently expose the child process PID.

### 6.2 Solution B: Session-Level Process Enumeration and Cleanup

Add process cleanup to the session completion flow:

```typescript
// src/services/worker/http/routes/SessionRoutes.ts

private startGeneratorWithProvider(session, provider, source): void {
  const parentPid = process.pid;
  const preExistingPids = new Set(await getChildProcessesForSession(parentPid, 'claude'));

  session.generatorPromise = agent.startSession(session, this.workerService)
    .finally(async () => {
      // Find new child processes that appeared during this session
      const currentPids = await getChildProcessesForSession(parentPid, 'claude');
      const newPids = currentPids.filter(pid => !preExistingPids.has(pid));

      // Terminate orphaned processes
      for (const pid of newPids) {
        await forceKillProcess(pid);
      }

      // ... existing cleanup
    });
}
```

### 6.3 Solution C: Periodic Orphan Reaper (Mitigation)

Add a background task that periodically identifies and terminates leaked processes:

```typescript
// src/services/worker/OrphanReaper.ts

export class OrphanReaper {
  private interval: NodeJS.Timer | null = null;

  start(intervalMs: number = 60000): void {
    this.interval = setInterval(async () => {
      const orphans = await this.findOrphanedClaudeProcesses();
      for (const pid of orphans) {
        await forceKillProcess(pid);
      }
    }, intervalMs);
  }

  private async findOrphanedClaudeProcesses(): Promise<number[]> {
    // Find claude processes parented to the worker daemon
    // that have been running longer than expected (e.g., > 30 minutes)
  }
}
```

**Pros:** Works without SDK modifications
**Cons:** Reactive rather than proactive; processes leak for up to interval duration

### 6.4 Solution D: Request SDK Enhancement

File an issue with the Claude Agent SDK requesting:
1. Exposure of child process PID in query result
2. Built-in cleanup on iterator completion
3. Explicit `close()` or `terminate()` method

### 6.5 Recommended Implementation Order

1. **Immediate (P0):** Implement Solution C (Orphan Reaper) as a mitigation
2. **Short-term (P1):** Implement Solution B (Session-Level Cleanup)
3. **Medium-term (P2):** Pursue Solution D (SDK Enhancement) with Anthropic
4. **Long-term (P3):** Implement Solution A once SDK provides PID access

---

## 7. Priority/Severity Assessment

### 7.1 Severity: Critical

- **Data Loss:** No
- **System Instability:** Yes - memory exhaustion
- **User Impact:** High - system becomes unusable
- **Scope:** All users with extended sessions

### 7.2 Priority: P0 - Immediate

- **Frequency:** Every session creates leaked processes
- **Accumulation:** Unbounded growth
- **Workaround:** Manual daemon restart (disruptive)
- **Business Impact:** Renders product unusable for long sessions

### 7.3 Effort Estimate

| Solution | Effort | Risk |
|----------|--------|------|
| Orphan Reaper (C) | 2-4 hours | Low |
| Session Cleanup (B) | 4-8 hours | Medium |
| SDK Enhancement (D) | External dependency | - |
| Full Tracking (A) | 8-16 hours | Medium |

---

## 8. References

- **Issue:** https://github.com/thedotmack/claude-mem/issues/603
- **Source Files:**
  - `/src/services/worker/SDKAgent.ts` - SDK query invocation
  - `/src/services/worker/SessionManager.ts` - Session lifecycle
  - `/src/services/worker/http/routes/SessionRoutes.ts` - Generator management
  - `/src/services/infrastructure/ProcessManager.ts` - Process utilities
  - `/src/services/infrastructure/GracefulShutdown.ts` - Shutdown cleanup
- **Related Code:**
  - `@anthropic-ai/claude-agent-sdk` - External SDK spawning processes

---

## 9. Appendix: Process Enumeration Reference

### Current getChildProcesses Implementation

```typescript
// src/services/infrastructure/ProcessManager.ts
export async function getChildProcesses(parentPid: number): Promise<number[]> {
  if (process.platform !== 'win32') {
    return [];  // NOTE: Only implemented for Windows!
  }

  // Windows implementation using wmic
  const cmd = `wmic process where "parentprocessid=${parentPid}" get processid /format:list`;
  // ...
}
```

**Critical Finding:** The `getChildProcesses` function is currently **Windows-only** and returns an empty array on Linux/macOS. This means the Linux user reporting the issue has no built-in cleanup mechanism.

### Required Fix for Linux/macOS

```typescript
export async function getChildProcesses(parentPid: number): Promise<number[]> {
  if (process.platform === 'win32') {
    // Existing Windows implementation
  } else {
    // Unix implementation
    const { stdout } = await execAsync(`pgrep -P ${parentPid}`);
    return stdout.trim().split('\n').map(Number).filter(n => !isNaN(n));
  }
}
```

---

*Report prepared by Claude Code analysis of codebase and issue #603*
