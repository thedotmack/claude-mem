# Queue Simplification: Phased Execution Plan

**Goal**: Replace ~2,100 lines of over-engineered queue system with ~200 lines of simple queue.

**Rules**:
- On failure: delete message, no retries
- Simple 100ms polling, no EventEmitters
- One global queue, not per-session

---

## Phase 1: Create New Queue Infrastructure

**Context**: We're building a simple queue system to replace the complex PendingMessageStore. This phase is purely additive - nothing breaks.

**Files to CREATE**:
1. `src/services/queue/SimpleQueue.ts`
2. `src/services/queue/QueueProcessor.ts`
3. `src/services/queue/types.ts`

**Tasks**:

### 1.1 Create types file
Create `src/services/queue/types.ts`:
```typescript
export interface QueueMessage {
  id: number;
  session_db_id: number;
  claude_session_id: string;
  message_type: 'observation' | 'summarize';
  tool_name: string | null;
  tool_input: string | null;
  tool_response: string | null;
  cwd: string | null;
  last_user_message: string | null;
  last_assistant_message: string | null;
  prompt_number: number | null;
  created_at_epoch: number;
}

export interface EnqueuePayload {
  type: 'observation' | 'summarize';
  tool_name?: string;
  tool_input?: unknown;
  tool_response?: unknown;
  cwd?: string;
  last_user_message?: string;
  last_assistant_message?: string;
  prompt_number?: number;
}
```

### 1.2 Create SimpleQueue
Create `src/services/queue/SimpleQueue.ts` (~60 lines):
- Constructor takes Database instance
- `enqueue(sessionDbId, claudeSessionId, payload)` - INSERT, return id
- `peek()` - SELECT oldest, return QueueMessage or null
- `remove(id)` - DELETE by id
- `count()` - SELECT COUNT(*)
- Uses existing `pending_messages` table (reuse schema, ignore status columns)

### 1.3 Create QueueProcessor
Create `src/services/queue/QueueProcessor.ts` (~80 lines):
- Constructor takes SimpleQueue + async processMessage callback
- `start()` - set running=true, begin loop
- `stop()` - set running=false
- `isRunning()` - return running state
- Loop: peek → process → remove → sleep(100ms)
- On error: log, remove message anyway (no retries)

### 1.4 Create barrel export
Create `src/services/queue/index.ts`:
```typescript
export { SimpleQueue } from './SimpleQueue.js';
export { QueueProcessor } from './QueueProcessor.js';
export type { QueueMessage, EnqueuePayload } from './types.js';
```

**Verification**:
```bash
npm run build
# Should compile with no errors
# Old system still works, new files just exist
```

**Commit**: `feat(queue): add SimpleQueue and QueueProcessor infrastructure`

---

## Phase 2: Wire Up Message Producers

**Context**: HTTP routes currently call `sessionManager.queueObservation()` and `sessionManager.queueSummarize()`. We'll add a new method that uses SimpleQueue while keeping old methods working.

**Files to MODIFY**:
1. `src/services/worker/SessionManager.ts`
2. `src/services/worker-service.ts`

**Tasks**:

### 2.1 Add SimpleQueue to SessionManager
In `src/services/worker/SessionManager.ts`:
- Add `private simpleQueue: SimpleQueue | null = null`
- Add `getSimpleQueue()` lazy initializer (like getPendingStore)
- Add `enqueueMessage(sessionDbId, claudeSessionId, payload)` that uses SimpleQueue
- Keep old `queueObservation` and `queueSummarize` methods working

### 2.2 Add QueueProcessor to WorkerService
In `src/services/worker-service.ts`:
- Add `private queueProcessor: QueueProcessor | null = null`
- In `start()`: create QueueProcessor with processMessage callback
- In `stop()`: call queueProcessor.stop()
- processMessage callback: just log for now (placeholder)

### 2.3 Update HTTP routes to use new queue
In `src/services/worker/http/routes/SessionRoutes.ts`:
- Change `queueObservation()` calls to `enqueueMessage()`
- Change `queueSummarize()` calls to `enqueueMessage()`

**Verification**:
```bash
npm run build
npm run build-and-sync
# Start worker, send observations
# Check logs show messages being enqueued AND processed (logged)
```

**Commit**: `feat(queue): wire up SimpleQueue to message producers`

---

## Phase 3: Implement Message Processing

**Context**: QueueProcessor needs to actually process messages. We'll extract the core logic from SDKAgent.

**Files to MODIFY**:
1. `src/services/queue/QueueProcessor.ts`
2. `src/services/worker/SDKAgent.ts`
3. `src/services/worker-service.ts`

**Tasks**:

### 3.1 Extract message processing from SDKAgent
The SDKAgent currently:
1. Gets messages from iterator
2. Builds SDK query
3. Sends to Claude
4. Parses response
5. Stores observations

We need to refactor so QueueProcessor can trigger this for each message.

### 3.2 Create processQueueMessage in WorkerService
In `src/services/worker-service.ts`:
- Add `async processQueueMessage(msg: QueueMessage): Promise<void>`
- Initialize session if needed
- Call SDKAgent to process the message
- SDKAgent should handle one message at a time now

### 3.3 Update SDKAgent for single-message processing
In `src/services/worker/SDKAgent.ts`:
- Add `async processMessage(session, message): Promise<void>`
- Remove the iterator-based message consumption
- Each call processes exactly one message

**Verification**:
```bash
npm run build
npm run build-and-sync
# Restart worker
# Send observations via hooks
# Verify observations appear in database
```

**Commit**: `feat(queue): implement single-message processing in SDKAgent`

---

## Phase 4: Delete Old Queue System

**Context**: New queue is working. Delete the old complexity.

**Files to DELETE**:
1. `src/services/sqlite/PendingMessageStore.ts`
2. `src/services/queue/SessionQueueProcessor.ts`

**Files to MODIFY**:
1. `src/services/worker/SessionManager.ts` - remove old queue methods
2. `src/services/worker-service.ts` - remove recovery logic
3. `src/services/worker/SDKAgent.ts` - remove iterator consumption
4. `src/services/worker/GeminiAgent.ts` - remove PendingMessageStore refs
5. `src/services/worker/OpenRouterAgent.ts` - remove PendingMessageStore refs
6. `src/services/worker/http/routes/DataRoutes.ts` - update queue status endpoint
7. `src/services/worker/http/routes/SessionRoutes.ts` - remove old queue calls

**Tasks**:

### 4.1 Delete PendingMessageStore.ts
```bash
rm src/services/sqlite/PendingMessageStore.ts
```

### 4.2 Delete SessionQueueProcessor.ts
```bash
rm src/services/queue/SessionQueueProcessor.ts
```

### 4.3 Clean SessionManager
Remove:
- `pendingStore` field and `getPendingStore()`
- `queueObservation()` method (replaced by `enqueueMessage`)
- `queueSummarize()` method (replaced by `enqueueMessage`)
- `sessionQueues` Map and EventEmitters
- `getMessageIterator()` method
- `getPendingMessageStore()` method

### 4.4 Clean WorkerService
Remove:
- All crash recovery loops
- `startSessionProcessor()` complexity
- `processPendingQueues()`
- `resetStuckMessages()` calls
- References to PendingMessageStore

### 4.5 Clean SDKAgent
Remove:
- `buildMessageGenerator()` (no more iterators)
- `markMessagesProcessed()` (messages deleted after processing)
- Iterator-based consumption logic
- `pendingProcessingIds` tracking

### 4.6 Clean GeminiAgent and OpenRouterAgent
Remove all PendingMessageStore references.

### 4.7 Update DataRoutes queue endpoint
`GET /api/pending-queue` should use SimpleQueue.count() instead.

**Verification**:
```bash
npm run build  # Must compile clean
npm run build-and-sync
# Full integration test
```

**Commit**: `refactor(queue): delete old PendingMessageStore and SessionQueueProcessor`

---

## Phase 5: Final Cleanup

**Context**: Remove any remaining dead code and simplify.

**Files to MODIFY**:
1. `src/services/worker-types.ts` - remove unused types
2. `src/services/worker/SessionManager.ts` - simplify ActiveSession type
3. Various files - remove unused imports

**Tasks**:

### 5.1 Clean worker-types.ts
Remove:
- `PendingMessageWithId` type (no more iterators)
- Status-related types
- Any unused fields

### 5.2 Simplify ActiveSession
Remove from ActiveSession:
- `pendingMessages: []` (deprecated field)
- `pendingProcessingIds: Set` (no more tracking)
- `earliestPendingTimestamp` (no more backlog handling)

### 5.3 Remove dead imports
Search all files for imports of deleted modules and remove them.

### 5.4 Delete QUEUE-SYSTEM-ANALYSIS.md
```bash
rm QUEUE-SYSTEM-ANALYSIS.md
```

### 5.5 Update scripts/check-pending-queue.ts
Either delete or update to use SimpleQueue.

**Verification**:
```bash
npm run build
npm run test  # If tests exist
npm run build-and-sync
# Full end-to-end test with real Claude Code session
```

**Commit**: `chore(queue): final cleanup of dead code and types`

---

## Summary

| Phase | Description | Risk | Duration |
|-------|-------------|------|----------|
| 1 | Create new queue files | None (additive) | Low |
| 2 | Wire up producers | Low (parallel path) | Low |
| 3 | Implement processing | Medium (core logic) | Medium |
| 4 | Delete old system | High (breaking) | Medium |
| 5 | Final cleanup | Low (cosmetic) | Low |

**Before/After**:
- Lines of code: ~2,100 → ~200
- State machine: 4 states → 0 states
- Recovery mechanisms: 3 → 0
- EventEmitters: N → 0
- Retry logic: Yes → No

**Execute each phase with**: `/do <phase_number> QUEUE-SIMPLIFICATION-PHASES.md`
