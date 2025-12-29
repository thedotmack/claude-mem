# Queue System Simplification Plan

## 1. Executive Summary
The current queue system suffers from accidental complexity due to **state duplication** (in-memory vs. database), **fragile control flow** (recursive restarts), and **distributed state management**. This plan proposes a refactoring to establish the Database as the Single Source of Truth, unifying the processing logic into a robust, linear "Pump" model.

## 2. Identified Pain Points

1.  **Dual State Synchronization:**
    *   *Issue:* The system maintains both `session.pendingMessages` (in-memory array) and the `pending_messages` SQLite table.
    *   *Impact:* Requires constant manual synchronization (push/shift/enqueue), leading to race conditions where the in-memory queue drifts from the DB state.

2.  **Fragile Generator Lifecycle:**
    *   *Issue:* The use of `startGeneratorWithProvider` and `startSessionWithAutoRestart` with recursive `setTimeout` calls to keep the processor alive is brittle.
    *   *Impact:* Hard to debug, prone to stack issues or silent failures if the "chain" breaks.

3.  **Non-Atomic State Transitions:**
    *   *Issue:* The logic separates "peeking" a message from "marking it processing" (the "Critical Flow" identified in the analysis).
    *   *Impact:* If the worker crashes or halts between these steps, messages can be processed twice or lost in limbo.

4.  **Distributed Logic:**
    *   *Issue:* Queue logic is scattered across `SessionManager` (coordination), `PendingMessageStore` (DB queries), `SDKAgent` (consumption), and `WorkerService` (orchestration).
    *   *Impact:* Difficult to trace the lifecycle of a single message.

## 3. Proposed Architecture

### 3.1. Core Principle: "The Database is the Queue"
We will eliminate the in-memory `pendingMessages` array entirely. The SQLite database will be the *only* place where queue state exists.

### 3.2. Architecture Components

#### A. Atomic `claimNextMessage()`
Instead of `peek` then `mark`, we will implement a single atomic operation in `PendingMessageStore`.

*   **Logic:**
    1.  Find the oldest `pending` message for the session.
    2.  Update it to `processing` and set the timestamp.
    3.  Return the message record.
*   **SQL Strategy:** Use a transaction or `UPDATE ... RETURNING` (if supported) to ensure no other worker can claim the same message.

#### B. The `QueuePump` (Unified Processor)
We will replace the recursive generator logic with a class (or function) dedicated to "pumping" messages for a specific session.

*   **Pseudocode Structure:**
    ```typescript
    async function runSessionPump(sessionId: number, signal: AbortSignal) {
        while (!signal.aborted) {
            // 1. Atomic Claim
            const message = store.claimNextMessage(sessionId);
            
            if (!message) {
                // 2. Wait for signal (Event-driven, not polling)
                await waitForNewData(sessionId, signal);
                continue;
            }

            try {
                // 3. Process
                await sdkAgent.processMessage(message);
                
                // 4. Mark Complete
                store.markProcessed(message.id);
            } catch (error) {
                // 5. Handle Failure
                store.markFailed(message.id, error);
            }
        }
    }
    ```

### 3.3. Key Changes

| Component | Current State | Proposed State |
| :--- | :--- | :--- |
| **Storage** | In-memory Array + SQLite | SQLite Only |
| **Consumption** | `yield` loop inside SDK Agent | `QueuePump` calls SDK Agent per message |
| **Concurrency** | `peekPending` -> `markProcessing` (Race Prone) | `claimNextMessage` (Atomic Transaction) |
| **Lifecycle** | Recursive `setTimeout` loops | Single `while` loop with `await` |
| **Recovery** | `resetStuckMessages` (Global) | Pump handles own retries + Global cleanup on startup |

## 4. Implementation Steps

### Phase 1: Database Layer Hardening
1.  Add `claimNextMessage(sessionDbId)` to `PendingMessageStore`.
    *   Must be transactional.
    *   Returns `null` if no work is available.
2.  Ensure `markProcessed` and `markFailed` are robust.

### Phase 2: The Pump
1.  Create `SessionQueueProcessor.ts`.
2.  Implement the `while(!aborted)` loop.
3.  Integrate the `EventEmitter` to wake the loop when `enqueue()` happens (replacing the current polling-like behavior).

### Phase 3: SDK Integration
1.  Refactor `SDKAgent` to accept a *single* message or a streamlined iterator that doesn't manage queue state itself.
2.  Remove `session.pendingMessages` from `ActiveSession` type.

### Phase 4: Cleanup
1.  Remove `startGeneratorWithProvider` and `startSessionWithAutoRestart`.
2.  Remove `peekPending` (as it's replaced by `claimNextMessage`).
3.  Remove manual synchronization code in `SessionManager`.

## 5. Benefits
*   **Simplicity:** Code reduction of ~30-40%.
*   **Reliability:** Atomic database operations eliminate race conditions.
*   **Observability:** Linear control flow is easier to log and debug.
*   **Resilience:** Crashes are handled by simply restarting the Pump, which naturally picks up "processing" (stuck) or "pending" messages.
