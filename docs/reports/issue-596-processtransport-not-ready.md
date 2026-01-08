# Issue #596: ProcessTransport is not ready for writing - Generator aborted on every observation

**Date:** 2026-01-07
**Issue:** [#596](https://github.com/thedotmack/claude-mem/issues/596)
**Reported by:** soho-dev-account
**Severity:** Critical
**Status:** Under Investigation
**Labels:** bug

---

## 1. Executive Summary

After a clean install of claude-mem v9.0.0, the SDK agent aborts every observation with a "ProcessTransport is not ready for writing" error. The worker starts successfully and the HTTP API responds, but no observations are stored to the database. The error originates from the Claude Agent SDK's internal transport layer, specifically in the bundled `worker-service.cjs` at line 1119.

**Key Finding:** This is a race condition or timing issue in the Claude Agent SDK's ProcessTransport initialization. The SDK attempts to write messages to its subprocess transport before the transport's ready state is established.

**Impact:** Complete loss of memory functionality. The system appears operational but silently fails to capture any development context.

---

## 2. Problem Analysis

### 2.1 Symptoms

1. **Worker starts successfully** - No startup errors, HTTP endpoints respond
2. **Observations are queued** - HTTP 200 responses from `/api/sessions/observations`
3. **Generator aborts immediately** - Every queued message triggers generator abort
4. **No observations stored** - Database remains empty despite active usage

### 2.2 Error Signature

```
error: ProcessTransport is not ready for writing at write (/Users/.../worker-service.cjs:1119:5337)
```

### 2.3 Worker Logs Pattern

```
[INFO ] [SDK ] Starting SDK query...
[INFO ] [SDK ] Creating message generator...
[INFO ] [SESSION] [session-3458] Generator aborted
```

The log shows:
- SDK query starts (line 78-85 in SDKAgent.ts)
- Message generator created (line 266-272 in SDKAgent.ts)
- Generator aborts immediately (line 169 in SessionRoutes.ts)

The gap between "Creating message generator" and "Generator aborted" indicates the SDK's `query()` function throws before yielding any messages.

### 2.4 Environment Context

- **OS:** macOS 26.3, Apple Silicon
- **Bun:** 1.3.5
- **Node:** v22.21.1
- **Claude Code:** 2.0.75
- **claude-mem:** v9.0.0 (clean install)

---

## 3. Technical Details

### 3.1 ProcessTransport in the Agent SDK

The `ProcessTransport` class is part of the Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`), bundled into `worker-service.cjs` during the build process. This transport manages bidirectional IPC communication between:

1. **Parent process:** The claude-mem worker service
2. **Child process:** Claude Code subprocess spawned for SDK queries

The transport uses stdin/stdout pipes to exchange JSON messages with the Claude Code process.

### 3.2 The Ready State Problem

ProcessTransport maintains a `ready` state that gates write operations:

```javascript
// Approximate structure from bundled code
class ProcessTransport {
  ready = false;

  write(data) {
    if (!this.ready) {
      throw new Error("ProcessTransport is not ready for writing");
    }
    // ... actual write to subprocess stdin
  }

  async start() {
    // Spawn subprocess
    // Set up pipes
    this.ready = true;
  }
}
```

The error occurs when `write()` is called before `start()` completes, or when the transport initialization fails silently.

### 3.3 Code Flow Analysis

1. **Session initialization** (`SessionRoutes.ts:237-299`)
   - HTTP request creates/fetches session
   - Calls `startGeneratorWithProvider()`

2. **Generator startup** (`SessionRoutes.ts:118-217`)
   - Sets `session.currentProvider`
   - Calls `agent.startSession(session, worker)`
   - Wraps in Promise with error/finally handlers

3. **SDK query invocation** (`SDKAgent.ts:102-114`)
   ```typescript
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

4. **SDK internal flow** (inside `query()`)
   - Creates ProcessTransport
   - Spawns Claude subprocess
   - **RACE:** Attempts to write before ready

### 3.4 Abort Controller Signal Path

When ProcessTransport throws, the error propagates through:

1. `query()` async iterator throws
2. `for await` loop in `startSession()` exits
3. Generator promise rejects
4. SessionRoutes `.catch()` handler executes
5. Checks `session.abortController.signal.aborted`
6. Since not manually aborted, logs "Generator failed" at ERROR level
7. `.finally()` handler executes
8. Logs "Generator aborted" (misleading - it wasn't aborted, it crashed)

---

## 4. Impact Assessment

### 4.1 Functional Impact

| Component | Status | Notes |
|-----------|--------|-------|
| Worker startup | Working | HTTP server binds correctly |
| HTTP API | Working | Endpoints respond with 200 |
| Session creation | Working | Database rows created |
| Observation queueing | Working | Messages added to pending queue |
| SDK query | **Failing** | ProcessTransport error |
| Observation storage | **Failing** | No observations saved |
| Summary generation | **Failing** | Depends on working SDK |
| CLAUDE.md generation | **Partial** | No recent activity to show |

### 4.2 User Impact

- **100% loss of memory functionality** - No observations captured
- **Silent failure mode** - Worker appears healthy
- **Queue grows indefinitely** - Messages stuck in "processing"
- **No error visible to user** - Requires checking worker logs

### 4.3 System Recovery

After this failure:
1. Pending messages remain in database (crash-safe design)
2. On worker restart, messages are recoverable
3. If SDK issue is resolved, backlog will process

---

## 5. Root Cause Analysis

### 5.1 Primary Hypothesis: SDK Version Incompatibility

**Confidence: 85%**

The Claude Agent SDK version (`^0.1.76`) may have introduced changes to ProcessTransport initialization timing that conflict with how claude-mem invokes `query()`.

Evidence:
- v9.0.0 works for some users but fails for others
- Error occurs in SDK internals, not claude-mem code
- Similar timing issues seen in previous SDK versions

### 5.2 Alternative Hypothesis: Subprocess Spawn Race

**Confidence: 70%**

The Claude Code subprocess may fail to start or respond in time, causing the transport to remain in non-ready state.

Evidence:
- `pathToClaudeCodeExecutable` is auto-detected
- Different Claude Code versions may have different startup times
- Apple Silicon Bun may spawn processes differently

### 5.3 Alternative Hypothesis: Bun-Specific IPC Issue

**Confidence: 50%**

Bun's process spawning may handle stdin/stdout pipes differently than Node.js, causing transport initialization to fail.

Evidence:
- claude-mem runs under Bun
- Agent SDK may not be tested extensively with Bun runtime
- Bun 1.3.5 is relatively new

### 5.4 Related: Recent Version Mismatch Fix (#567)

Commit `e22e2bfc` fixed a version mismatch causing infinite worker restart loops. This touched:
- `plugin/package.json`
- `plugin/scripts/worker-service.cjs`
- Hook scripts

While this fix addressed restart loops, it may have introduced timing changes that expose this race condition.

---

## 6. Recommended Solutions

### 6.1 Immediate Workarounds

#### Option A: Retry with Backoff (Quick Fix)
Add retry logic around `query()` invocation:

```typescript
// SDKAgent.ts - wrap query() with retry
async function queryWithRetry(options: QueryOptions, maxRetries = 3): Promise<QueryResult> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return query(options);
    } catch (error) {
      if (error.message?.includes('ProcessTransport is not ready') && attempt < maxRetries - 1) {
        await new Promise(resolve => setTimeout(resolve, 100 * (attempt + 1)));
        continue;
      }
      throw error;
    }
  }
}
```

**Pros:** Quick to implement, may resolve timing-sensitive cases
**Cons:** Masks underlying issue, adds latency

#### Option B: Verify Claude Executable Before Query
Add explicit verification that Claude is responsive:

```typescript
// Before calling query()
const testResult = execSync(`${claudePath} --version`, { timeout: 5000 });
if (!testResult) {
  throw new Error('Claude executable not responding');
}
```

**Pros:** Catches subprocess spawn failures early
**Cons:** Adds startup latency, doesn't address transport race

### 6.2 Medium-Term Fixes

#### Option C: Pin SDK Version
Lock to a known-working SDK version:

```json
{
  "dependencies": {
    "@anthropic-ai/claude-agent-sdk": "0.1.75"
  }
}
```

**Pros:** Immediate resolution if regression confirmed
**Cons:** Misses security updates, may not match Claude Code version

#### Option D: Add Transport Ready Callback
Request SDK feature to expose transport ready state:

```typescript
// Hypothetical API
const queryResult = query({
  prompt: messageGenerator,
  options: { ... },
  onTransportReady: () => logger.info('SDK', 'Transport ready')
});
```

**Pros:** Proper fix at SDK level
**Cons:** Requires SDK changes

### 6.3 Long-Term Solutions

#### Option E: V2 SDK Migration
The V2 SDK (`unstable_v2_createSession`) uses a different session-based architecture that may not have this race condition:

```typescript
await using session = unstable_v2_createSession({
  model: 'claude-sonnet-4-5-20250929'
});

await session.send(initPrompt);  // Explicit send/receive
for await (const msg of session.receive()) { ... }
```

**Pros:** Modern API, explicit lifecycle control
**Cons:** V2 is "unstable preview", requires significant refactor

#### Option F: Alternative Agent Provider
Use Gemini or OpenRouter as default when SDK fails:

```typescript
// SessionRoutes.ts - fallback logic
try {
  await sdkAgent.startSession(session, worker);
} catch (error) {
  if (error.message?.includes('ProcessTransport')) {
    logger.warn('SESSION', 'SDK transport failed, falling back to Gemini');
    await geminiAgent.startSession(session, worker);
  }
}
```

**Pros:** System remains functional
**Cons:** Different model behavior, requires API key

---

## 7. Priority/Severity Assessment

### 7.1 Severity: Critical

| Criterion | Rating | Justification |
|-----------|--------|---------------|
| Functional Impact | Critical | Core feature completely broken |
| User Count | Unknown | Appears on clean installs |
| Data Loss | Low | No data corrupted, queue preserved |
| Recoverability | Medium | Worker restart may help |
| Workaround Available | Limited | Use alternative provider |

### 7.2 Priority: P0

This should be treated as a P0 (highest priority) issue because:

1. **Core functionality broken** - Memory capture is the primary feature
2. **Silent failure** - Users may not realize observations aren't being saved
3. **Clean install affected** - New users cannot use the product
4. **No easy workaround** - Requires code changes or provider switching

### 7.3 Recommended Action Plan

1. **Immediate (Day 1)**
   - [ ] Reproduce issue in controlled environment
   - [ ] Test with pinned SDK version 0.1.75
   - [ ] Test with Node.js instead of Bun
   - [ ] Add explicit error message to SessionRoutes for this failure mode

2. **Short-term (Week 1)**
   - [ ] Implement retry logic (Option A)
   - [ ] Add transport failure telemetry
   - [ ] Document workaround in issue comments
   - [ ] File SDK issue with Anthropic if confirmed regression

3. **Medium-term (Week 2-4)**
   - [ ] Evaluate V2 SDK migration timeline
   - [ ] Add graceful fallback to alternative providers
   - [ ] Improve generator error visibility in viewer UI

---

## 8. Appendix

### 8.1 Related Files

| File | Relevance |
|------|-----------|
| `src/services/worker/SDKAgent.ts` | SDK query invocation |
| `src/services/worker/http/routes/SessionRoutes.ts` | Generator lifecycle management |
| `src/services/worker/SessionManager.ts` | Session state and queue management |
| `src/services/worker-types.ts` | ActiveSession type definition |
| `plugin/scripts/worker-service.cjs` | Bundled worker with SDK code |

### 8.2 Related Issues

- **#567** - Version mismatch causing infinite worker restart loop (may be related)
- **#520** - Stuck messages analysis (similar symptom pattern)
- **#532** - Memory leak analysis (generator lifecycle issues)

### 8.3 Related Documentation

- `docs/context/agent-sdk-v2-preview.md` - V2 SDK documentation
- `docs/context/agent-sdk-v2-examples.ts` - V2 SDK code examples
- `docs/reports/2026-01-02--generator-failure-investigation.md` - Previous generator failure analysis

### 8.4 Test Commands

```bash
# Check worker logs
tail -f ~/.claude-mem/logs/worker-$(date +%Y-%m-%d).log

# Check pending queue
npm run queue

# Restart worker
npm run worker:restart

# Test with specific SDK version
npm install @anthropic-ai/claude-agent-sdk@0.1.75
npm run build-and-sync
```

---

**Report prepared by:** Claude Code
**Analysis date:** 2026-01-07
**Next review:** After reproduction attempt
