# Queue System Logic Report

This document provides a line-by-line analysis of the queue system in claude-mem, explaining **the reason behind each piece of logic** and **what it actually does**.

---

## Table of Contents

1. [High-Level Architecture](#high-level-architecture)
2. [Message Status State Machine](#message-status-state-machine)
3. [PendingMessageStore (Database Layer)](#pendingmessagestore-database-layer)
4. [SessionManager (Queue Coordination)](#sessionmanager-queue-coordination)
5. [SDKAgent (Message Consumer)](#sdkagent-message-consumer)
6. [SessionRoutes (HTTP Entry Points)](#sessionroutes-http-entry-points)
7. [WorkerService (Orchestrator)](#workerservice-orchestrator)
8. [Critical Flow: How a Message Gets Stuck in "Processing"](#critical-flow-how-a-message-gets-stuck-in-processing)
9. [Recovery Mechanisms](#recovery-mechanisms)

---

## High-Level Architecture

```
Hook (post-tool-use/summary)
    │
    ▼
SessionRoutes.handleObservations/handleSummarize
    │
    ▼
SessionManager.queueObservation/queueSummarize
    │
    ├─► PendingMessageStore.enqueue() [DB: status='pending']
    │
    ├─► session.pendingMessages.push() [In-memory queue]
    │
    └─► emitter.emit('message') [Wake up generator]

    │
    ▼
SDKAgent.createMessageGenerator (async generator)
    │
    ├─► SessionManager.getMessageIterator()
    │       │
    │       ├─► PendingMessageStore.peekPending() [Find oldest pending]
    │       │
    │       ├─► PendingMessageStore.markProcessing() [DB: status='processing']
    │       │
    │       └─► yield message to SDK
    │
    ▼
SDK query() processes message and returns response
    │
    ▼
SDKAgent.processSDKResponse()
    │
    └─► SDKAgent.markMessagesProcessed()
            │
            └─► PendingMessageStore.markProcessed() [DB: status='processed']
```

---

## Message Status State Machine

```
                   ┌─────────────┐
                   │   (new)     │
                   └──────┬──────┘
                          │ enqueue()
                          ▼
                   ┌─────────────┐
              ┌────│   pending   │◄───────────────┐
              │    └──────┬──────┘                │
              │           │ markProcessing()      │ markFailed() [retry_count < maxRetries]
              │           ▼                       │
              │    ┌─────────────┐                │
              │    │ processing  │────────────────┤
              │    └──────┬──────┘                │
              │           │                       │
              │           ├─► markProcessed()     │
              │           │         │             │
              │           │         ▼             │
              │           │  ┌─────────────┐      │
              │           │  │  processed  │      │
              │           │  └─────────────┘      │
              │           │                       │
              │           └─► markFailed() [retry_count >= maxRetries]
              │                     │
              │                     ▼
              │              ┌─────────────┐
              │              │   failed    │
              │              └─────────────┘
              │
              │
              │ resetStuckMessages() [thresholdMs timeout]
              └───────────────────────────────────┘
```

---

## PendingMessageStore (Database Layer)

### `enqueue()` (Lines 56-82)

```typescript
enqueue(sessionDbId: number, claudeSessionId: string, message: PendingMessage): number {
  const now = Date.now();
  const stmt = this.db.prepare(`
    INSERT INTO pending_messages (
      session_db_id, claude_session_id, message_type,
      tool_name, tool_input, tool_response, cwd,
      last_user_message, last_assistant_message,
      prompt_number, status, retry_count, created_at_epoch
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?)
  `);
```

| Line | The Reason Behind This | What It Actually Does |
|------|------------------------|----------------------|
| `const now = Date.now()` | Messages need timestamps for ordering and stuck-detection | Captures the moment the message was queued |
| `status, retry_count ... 'pending', 0` | New messages start in pending state with no retries | Hard-codes initial state in SQL |
| `created_at_epoch` | Need to track when message was originally queued for accurate observation timestamps | Used later when processing backlog to assign correct timestamps to observations |
| `JSON.stringify(message.tool_input)` | SQLite can't store objects natively | Serializes complex tool data to string |
| Returns `lastInsertRowid` | Caller needs the ID to track this specific message | Returns the database-assigned auto-increment ID |

### `peekPending()` (Lines 88-96)

```typescript
peekPending(sessionDbId: number): PersistentPendingMessage | null {
  const stmt = this.db.prepare(`
    SELECT * FROM pending_messages
    WHERE session_db_id = ? AND status = 'pending'
    ORDER BY id ASC
    LIMIT 1
  `);
  return stmt.get(sessionDbId) as PersistentPendingMessage | null;
}
```

| Line | The Reason Behind This | What It Actually Does |
|------|------------------------|----------------------|
| `status = 'pending'` | Only look at messages not yet being processed | Filters out processing/processed/failed |
| `ORDER BY id ASC` | Process messages in the order they arrived (FIFO) | Uses auto-increment ID as natural ordering |
| `LIMIT 1` | Only need one message at a time for the iterator | Returns single oldest pending message |
| Does NOT change status | Peek is non-destructive; status change happens separately in markProcessing | Allows checking without committing to process |

### `markProcessing()` (Lines 216-224)

```typescript
markProcessing(messageId: number): void {
  const now = Date.now();
  const stmt = this.db.prepare(`
    UPDATE pending_messages
    SET status = 'processing', started_processing_at_epoch = ?
    WHERE id = ? AND status = 'pending'
  `);
  stmt.run(now, messageId);
}
```

| Line | The Reason Behind This | What It Actually Does |
|------|------------------------|----------------------|
| `status = 'processing'` | Mark this message as "in progress" so other consumers don't pick it up | Prevents duplicate processing |
| `started_processing_at_epoch = ?` | Track when processing started for stuck detection | If processing takes >5min, considered stuck |
| `WHERE ... AND status = 'pending'` | Only transition from pending->processing (idempotent safety) | Prevents double-processing race conditions |

### `markProcessed()` (Lines 230-242)

```typescript
markProcessed(messageId: number): void {
  const now = Date.now();
  const stmt = this.db.prepare(`
    UPDATE pending_messages
    SET
      status = 'processed',
      completed_at_epoch = ?,
      tool_input = NULL,
      tool_response = NULL
    WHERE id = ? AND status = 'processing'
  `);
  stmt.run(now, messageId);
}
```

| Line | The Reason Behind This | What It Actually Does |
|------|------------------------|----------------------|
| `status = 'processed'` | Message successfully handled, move to terminal state | Marks completion |
| `completed_at_epoch = ?` | Track when processing finished for metrics/display | Records completion time |
| `tool_input = NULL, tool_response = NULL` | Large payload data no longer needed after successful processing | Frees space - observations are already saved elsewhere |
| `WHERE ... AND status = 'processing'` | Only transition from processing->processed | Ensures we only complete messages we actually processed |

### `markFailed()` (Lines 249-274)

```typescript
markFailed(messageId: number): void {
  const msg = this.db.prepare('SELECT retry_count FROM pending_messages WHERE id = ?').get(messageId);

  if (msg.retry_count < this.maxRetries) {
    // Move back to pending for retry
    const stmt = this.db.prepare(`
      UPDATE pending_messages
      SET status = 'pending', retry_count = retry_count + 1, started_processing_at_epoch = NULL
      WHERE id = ?
    `);
  } else {
    // Max retries exceeded, mark as permanently failed
    const stmt = this.db.prepare(`
      UPDATE pending_messages
      SET status = 'failed', completed_at_epoch = ?
      WHERE id = ?
    `);
  }
}
```

| Line | The Reason Behind This | What It Actually Does |
|------|------------------------|----------------------|
| Check `retry_count < maxRetries` | Don't retry forever - eventually give up | Implements bounded retry policy (default: 3) |
| `status = 'pending'` (retry path) | Put message back in queue for another attempt | Allows automatic recovery |
| `retry_count + 1` | Track how many times we've tried | Increment toward failure threshold |
| `started_processing_at_epoch = NULL` | Clear the processing timestamp for next attempt | Prevents stuck detection from immediately triggering |
| `status = 'failed'` (terminal) | Message is permanently broken, stop trying | Prevents infinite retry loops |

### `resetStuckMessages()` (Lines 281-292)

```typescript
resetStuckMessages(thresholdMs: number): number {
  const cutoff = thresholdMs === 0 ? Date.now() : Date.now() - thresholdMs;

  const stmt = this.db.prepare(`
    UPDATE pending_messages
    SET status = 'pending', started_processing_at_epoch = NULL
    WHERE status = 'processing' AND started_processing_at_epoch < ?
  `);

  return result.changes;
}
```

| Line | The Reason Behind This | What It Actually Does |
|------|------------------------|----------------------|
| `thresholdMs === 0 ? Date.now()` | Special case: threshold=0 means "reset all processing messages" | Allows forced recovery of all stuck messages |
| `Date.now() - thresholdMs` | Calculate cutoff time (e.g., 5 minutes ago) | Messages processing longer than this are stuck |
| `status = 'processing'` condition | Only reset messages actively being processed | Don't touch pending or completed messages |
| `started_processing_at_epoch < ?` | Processing started before cutoff = stuck | Time-based stuck detection |
| `SET status = 'pending'` | Move back to queue for retry | Enables automatic recovery |
| Returns `result.changes` | Caller needs to know how many were recovered | For logging/metrics |

### `getPendingCount()` (Lines 297-304)

```typescript
getPendingCount(sessionDbId: number): number {
  const stmt = this.db.prepare(`
    SELECT COUNT(*) as count FROM pending_messages
    WHERE session_db_id = ? AND status IN ('pending', 'processing')
  `);
```

| Line | The Reason Behind This | What It Actually Does |
|------|------------------------|----------------------|
| `status IN ('pending', 'processing')` | **CRITICAL**: Counts BOTH pending AND processing | Used to decide if generator should keep running |
| Why include processing? | A message in processing state is still "work to be done" | Prevents generator from stopping while SDK is mid-response |

---

## SessionManager (Queue Coordination)

### `queueObservation()` (Lines 181-232)

```typescript
queueObservation(sessionDbId: number, data: ObservationData): void {
  // Auto-initialize from database if needed
  let session = this.sessions.get(sessionDbId);
  if (!session) {
    session = this.initializeSession(sessionDbId);
  }

  // CRITICAL: Persist to database FIRST
  const message: PendingMessage = { type: 'observation', ... };
  const messageId = this.getPendingStore().enqueue(sessionDbId, session.claudeSessionId, message);

  // Add to in-memory queue
  session.pendingMessages.push(message);

  // Notify generator immediately
  const emitter = this.sessionQueues.get(sessionDbId);
  emitter?.emit('message');
}
```

| Line | The Reason Behind This | What It Actually Does |
|------|------------------------|----------------------|
| Auto-initialize session | Worker may have restarted, need to rebuild in-memory state | Lazy initialization from database |
| `enqueue()` BEFORE in-memory push | **CRITICAL**: Database is source of truth, survives crashes | Persist-first ensures no data loss |
| `session.pendingMessages.push()` | In-memory queue for backward compatibility and fast status checks | Mirrors database state in RAM |
| `emitter?.emit('message')` | Wake up the generator immediately (zero-latency) | Event-driven, no polling needed |

### `getMessageIterator()` (Lines 397-477)

```typescript
async *getMessageIterator(sessionDbId: number): AsyncIterableIterator<PendingMessageWithId> {
  while (!session.abortController.signal.aborted) {
    // Check for pending messages in persistent store
    const persistentMessage = this.getPendingStore().peekPending(sessionDbId);

    if (!persistentMessage) {
      // Wait for new message event
      await new Promise<void>(resolve => {
        emitter.once('message', messageHandler);
        session.abortController.signal.addEventListener('abort', abortHandler, { once: true });
      });
      continue;
    }

    // Mark as processing BEFORE yielding
    this.getPendingStore().markProcessing(persistentMessage.id);

    // Track this message ID for completion marking
    session.pendingProcessingIds.add(persistentMessage.id);

    // Convert and yield
    const message: PendingMessageWithId = {
      _persistentId: persistentMessage.id,
      _originalTimestamp: persistentMessage.created_at_epoch,
      ...this.getPendingStore().toPendingMessage(persistentMessage)
    };

    yield message;

    // Remove from in-memory queue after yielding
    session.pendingMessages.shift();
  }
}
```

| Line | The Reason Behind This | What It Actually Does |
|------|------------------------|----------------------|
| `while (!aborted)` | Keep processing until session ends | Continuous processing loop |
| `peekPending()` | Check database for work | Non-destructively looks for pending messages |
| `await new Promise` with event | Block until message arrives (no polling) | Event-driven wake-up saves CPU |
| `markProcessing()` BEFORE yield | **CRITICAL**: Claim the message before giving to SDK | Prevents race conditions |
| `pendingProcessingIds.add()` | Track which messages are being processed | So we know what to mark as completed |
| `_persistentId` field | Attach database ID to in-flight message | Needed for markProcessed() later |
| `_originalTimestamp` | Preserve original queue time | For accurate observation timestamps when processing backlog |
| `pendingMessages.shift()` after yield | Keep in-memory queue in sync with database | Mirrors the database state change |

---

## SDKAgent (Message Consumer)

### `startSession()` Main Loop (Lines 75-150)

```typescript
const queryResult = query({
  prompt: messageGenerator,
  options: {
    model: modelId,
    resume: session.claudeSessionId,  // <-- Session continuity
    disallowedTools,
    abortController: session.abortController,
    pathToClaudeCodeExecutable: claudePath
  }
});

for await (const message of queryResult) {
  if (message.type === 'assistant') {
    // Process response
    await this.processSDKResponse(session, textContent, worker, discoveryTokens, originalTimestamp);
  }
}
```

| Line | The Reason Behind This | What It Actually Does |
|------|------------------------|----------------------|
| `resume: session.claudeSessionId` | **CRITICAL**: Connect to existing Claude session | Enables session continuity - same transcript across prompts |
| `for await` loop | Process SDK responses as they arrive | Streaming response handling |
| `processSDKResponse()` called per response | Parse and save observations/summaries | Database + Chroma sync |

### `createMessageGenerator()` (Lines 202-291)

```typescript
private async *createMessageGenerator(session: ActiveSession): AsyncIterableIterator<SDKUserMessage> {
  // Build initial or continuation prompt
  const initPrompt = isInitPrompt
    ? buildInitPrompt(...)
    : buildContinuationPrompt(...);

  // Yield initial prompt
  yield { type: 'user', message: { role: 'user', content: initPrompt }, session_id: session.claudeSessionId };

  // Consume pending messages
  for await (const message of this.sessionManager.getMessageIterator(session.sessionDbId)) {
    if (message.type === 'observation') {
      const obsPrompt = buildObservationPrompt({ ... });
      yield { type: 'user', message: { role: 'user', content: obsPrompt } };
    } else if (message.type === 'summarize') {
      const summaryPrompt = buildSummaryPrompt({ ... });
      yield { type: 'user', message: { role: 'user', content: summaryPrompt } };
    }
  }
}
```

| Line | The Reason Behind This | What It Actually Does |
|------|------------------------|----------------------|
| `isInitPrompt` check | First prompt needs full context, subsequent prompts need continuation | Different prompt templates |
| `yield` initial prompt | Start the SDK conversation | Sends initialization to Claude |
| `for await ... getMessageIterator` | Pull messages as they become available | Event-driven message consumption |
| `yield` for each message | Feed observations/summaries to SDK one at a time | SDK processes each and responds |

### `markMessagesProcessed()` (Lines 462-491)

```typescript
private async markMessagesProcessed(session: ActiveSession, worker: any): Promise<void> {
  const pendingMessageStore = this.sessionManager.getPendingMessageStore();

  if (session.pendingProcessingIds.size > 0) {
    for (const messageId of session.pendingProcessingIds) {
      pendingMessageStore.markProcessed(messageId);
    }
    session.pendingProcessingIds.clear();
    session.earliestPendingTimestamp = null;

    // Cleanup old processed messages
    const deletedCount = pendingMessageStore.cleanupProcessed(100);
  }

  // Broadcast status update
  if (worker && typeof worker.broadcastProcessingStatus === 'function') {
    worker.broadcastProcessingStatus();
  }
}
```

| Line | The Reason Behind This | What It Actually Does |
|------|------------------------|----------------------|
| Loop over `pendingProcessingIds` | Mark ALL messages that were yielded to SDK | Batch completion |
| `markProcessed()` for each | Transition processing->processed in database | Completes the message lifecycle |
| `.clear()` | Reset tracking set for next batch | Prepare for next iteration |
| `earliestPendingTimestamp = null` | Reset timestamp tracking | Next batch gets fresh timestamps |
| `cleanupProcessed(100)` | Don't keep infinite processed messages | Retention policy |
| `broadcastProcessingStatus()` | Update UI with new state | SSE broadcast |

---

## SessionRoutes (HTTP Entry Points)

### `startGeneratorWithProvider()` (Lines 118-189)

```typescript
private startGeneratorWithProvider(session, provider, source): void {
  session.currentProvider = provider;

  session.generatorPromise = agent.startSession(session, this.workerService)
    .catch(error => {
      // Mark all processing messages as failed
      const processingMessages = stmt.all(session.sessionDbId);
      for (const msg of processingMessages) {
        pendingStore.markFailed(msg.id);
      }
    })
    .finally(() => {
      session.generatorPromise = null;
      session.currentProvider = null;
      this.workerService.broadcastProcessingStatus();

      // Check if there's more work pending
      const pendingCount = pendingStore.getPendingCount(sessionDbId);
      if (pendingCount > 0) {
        // Auto-restart
        setTimeout(() => {
          if (stillExists && !stillExists.generatorPromise) {
            this.startGeneratorWithProvider(stillExists, this.getSelectedProvider(), 'auto-restart');
          }
        }, 0);
      } else {
        // Cleanup
        this.sessionManager.deleteSession(sessionDbId);
      }
    });
}
```

| Line | The Reason Behind This | What It Actually Does |
|------|------------------------|----------------------|
| `session.generatorPromise =` | Track that generator is running | Prevents multiple generators per session |
| `.catch()` with markFailed | If generator crashes, don't lose messages | Marks for retry or permanent failure |
| `.finally()` | Always cleanup regardless of success/failure | Guaranteed cleanup |
| `generatorPromise = null` | Allow new generator to start | Clears the "running" flag |
| `getPendingCount() > 0` | **CRITICAL**: Check if more work arrived while processing | Handles messages queued during SDK call |
| `setTimeout(..., 0)` | Don't restart synchronously (could cause stack issues) | Deferred restart |
| `deleteSession()` when no work | Clean up resources | Memory management |

### `ensureGeneratorRunning()` (Lines 90-113)

```typescript
private ensureGeneratorRunning(sessionDbId: number, source: string): void {
  const session = this.sessionManager.getSession(sessionDbId);
  if (!session) return;

  const selectedProvider = this.getSelectedProvider();

  // Start generator if not running
  if (!session.generatorPromise) {
    this.startGeneratorWithProvider(session, selectedProvider, source);
    return;
  }

  // Generator is running - check if provider changed
  if (session.currentProvider && session.currentProvider !== selectedProvider) {
    // Let current generator finish, next one will use new provider
  }
}
```

| Line | The Reason Behind This | What It Actually Does |
|------|------------------------|----------------------|
| Check `!generatorPromise` | Only start if not already running | Prevents duplicate generators |
| Start generator if not running | Ensure messages get processed | Lazy generator startup |
| Provider change detection | Allow switching providers mid-session | Graceful provider transition |

---

## WorkerService (Orchestrator)

### `initializeBackground()` Stuck Message Recovery (Lines 627-633)

```typescript
// Recover stuck messages from previous crashes
const STUCK_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes
const resetCount = pendingStore.resetStuckMessages(STUCK_THRESHOLD_MS);
if (resetCount > 0) {
  logger.info('SYSTEM', `Recovered ${resetCount} stuck messages from previous session`);
}
```

| Line | The Reason Behind This | What It Actually Does |
|------|------------------------|----------------------|
| Called at startup | Worker may have crashed while messages were processing | Recovery mechanism |
| 5 minute threshold | If processing >5min, something went wrong | Reasonable timeout for SDK calls |
| Reset to pending | Give stuck messages another chance | Automatic retry |

### `processPendingQueues()` (Lines 747-811)

```typescript
async processPendingQueues(sessionLimit: number = 10): Promise<Result> {
  const orphanedSessionIds = pendingStore.getSessionsWithPendingMessages();

  for (const sessionDbId of orphanedSessionIds) {
    // Skip if session already has active generator
    const existingSession = this.sessionManager.getSession(sessionDbId);
    if (existingSession?.generatorPromise) {
      result.sessionsSkipped++;
      continue;
    }

    // Initialize session and start SDK agent
    const session = this.sessionManager.initializeSession(sessionDbId);
    this.startSessionWithAutoRestart(session, getPendingCount, 'startup-recovery');
  }
}
```

| Line | The Reason Behind This | What It Actually Does |
|------|------------------------|----------------------|
| Called at startup | Resume work interrupted by crash/restart | Auto-recovery |
| `getSessionsWithPendingMessages()` | Find sessions that have orphaned work | Database query |
| Skip if generator running | Don't start duplicate processors | Race condition prevention |
| `startSessionWithAutoRestart()` | Start processing with auto-restart logic | Shares code with SessionRoutes |

### `startSessionWithAutoRestart()` (Lines 696-739)

```typescript
private startSessionWithAutoRestart(session, getPendingCount, source): void {
  session.generatorPromise = this.sdkAgent.startSession(session, this)
    .catch(error => { ... })
    .finally(() => {
      session.generatorPromise = null;
      this.broadcastProcessingStatus();

      const stillPending = getPendingCount(sid);
      if (stillPending > 0) {
        // Recursive restart
        setTimeout(() => {
          const stillExists = this.sessionManager.getSession(sid);
          if (stillExists && !stillExists.generatorPromise) {
            this.startSessionWithAutoRestart(stillExists, getPendingCount, 'auto-restart');
          }
        }, 0);
      } else {
        // Cleanup
        this.sessionManager.deleteSession(sid);
      }
    });
}
```

| Line | The Reason Behind This | What It Actually Does |
|------|------------------------|----------------------|
| Same pattern as SessionRoutes | **DRY**: Shared auto-restart logic | Prevents code duplication |
| Recursive restart | Keep processing until queue is empty | Ensures all messages processed |
| Check `stillExists` before restart | Session might have been deleted | Safety check |

---

## Critical Flow: How a Message Gets Stuck in "Processing"

### The Problem

Messages can get stuck in `status = 'processing'` if:

1. **SDK call hangs indefinitely** - The Agent SDK query never returns
2. **Worker crashes mid-processing** - Process dies before markProcessed()
3. **Exception in processSDKResponse()** - Error prevents markProcessed() from running

### The Flow

```
1. queueObservation() called
   └─► enqueue() → status = 'pending'

2. getMessageIterator() picks up message
   └─► markProcessing() → status = 'processing' ✓
   └─► pendingProcessingIds.add(id)
   └─► yield message to SDK

3. SDK processes and returns response
   └─► processSDKResponse() called
       └─► Parse observations/summaries
       └─► Store to database
       └─► markMessagesProcessed()
           └─► markProcessed() → status = 'processed' ✓

IF STEP 3 FAILS OR HANGS:
   └─► Message stays in 'processing' forever
   └─► Recovery: resetStuckMessages() after 5 minutes
```

### Why Processing Messages Can Get "Lost"

**Race Condition in getMessageIterator():**

```typescript
// Lines 445-446 in SessionManager
this.getPendingStore().markProcessing(persistentMessage.id);
session.pendingProcessingIds.add(persistentMessage.id);
```

The message is marked as `processing` BEFORE being yielded. If the SDK hangs or crashes AFTER this line but BEFORE processSDKResponse completes, the message is stuck.

**Protection Mechanisms:**

1. `pendingProcessingIds` tracks what's in-flight
2. `markFailed()` in catch handler marks for retry
3. `resetStuckMessages()` at startup cleans up old stuck messages

---

## Recovery Mechanisms

### 1. Startup Recovery (Worker crashes)

```typescript
// In initializeBackground()
const resetCount = pendingStore.resetStuckMessages(STUCK_THRESHOLD_MS);
```

- Runs when worker starts
- Finds messages stuck in `processing` for >5 minutes
- Resets them to `pending` for retry

### 2. Generator Error Recovery

```typescript
// In startGeneratorWithProvider() catch handler
for (const msg of processingMessages) {
  pendingStore.markFailed(msg.id);
}
```

- Runs when SDK call throws
- Marks processing messages as failed (which may reset to pending if retries remain)

### 3. Auto-Restart Recovery

```typescript
// In startGeneratorWithProvider() finally handler
if (pendingCount > 0) {
  setTimeout(() => startGeneratorWithProvider(...), 0);
}
```

- Runs after every generator completes
- Checks for pending work
- Starts new generator if work remains

### 4. Manual Recovery (UI)

```typescript
// PendingMessageStore methods
retryMessage(messageId)      // Reset specific message to pending
retryAllStuck(thresholdMs)   // Reset all stuck messages
abortMessage(messageId)      // Delete message from queue
```

---

## Summary of Potential Issues

| Issue | Cause | Mitigation |
|-------|-------|------------|
| Message stuck in processing | SDK hang, crash during processing | `resetStuckMessages()` at startup |
| Duplicate processing | Race condition on message claim | `markProcessing()` with `WHERE status = 'pending'` |
| Lost messages | Crash before enqueue | DB persist BEFORE in-memory push |
| Generator never starts | No call to `ensureGeneratorRunning()` | Called by every HTTP handler |
| Generator exits early | Empty queue check race | `finally` handler checks and restarts |
| Infinite retry | Repeated failures | `maxRetries` limit (default: 3) |

---

## Diagnostic Queries

Check for stuck messages:
```sql
SELECT * FROM pending_messages
WHERE status = 'processing'
AND started_processing_at_epoch < (strftime('%s', 'now') * 1000 - 300000);
```

Check queue depth by session:
```sql
SELECT session_db_id, status, COUNT(*)
FROM pending_messages
GROUP BY session_db_id, status;
```

Check retry counts:
```sql
SELECT id, message_type, retry_count, status
FROM pending_messages
WHERE retry_count > 0;
```
