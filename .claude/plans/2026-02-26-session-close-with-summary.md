# Implementation Plan: Session-Close with Summary

## Overview

When a session is closed via the UI (`POST /api/sessions/:id/close`), summary generation is never triggered. Summaries are only generated via the Stop hook's `queueSummarize()` call. This means UI-closed sessions lose valuable session context. The fix injects `SessionManager` and `SessionEventBroadcaster` into `ActiveSessionRoutes` and queues a summary before marking the session as completed.

## Requirements

- When a session is closed via the UI, trigger summary generation BEFORE marking it as completed
- Handle the case where `lastAssistantMessage` is not available (UI close has no transcript access)
- Queue summary asynchronously (don't block the API response)
- Keep the existing Stop hook summary flow working unchanged
- Handle edge cases: session already has a summary, session has no observations, session is already being summarized

## Delivery Strategy

User-managed (not specified).

## Architecture Changes

- `src/services/worker/http/routes/ActiveSessionRoutes.ts` -- Add `SessionManager` and `SessionEventBroadcaster` as constructor dependencies; modify `handleCloseSession` to queue summary
- `src/services/worker-service.ts` -- Pass `SessionManager` and `SessionEventBroadcaster` when constructing `ActiveSessionRoutes`
- `src/services/sqlite/sessions/active.ts` -- Add new `getLastObservationTextForSession()` query (optional context enrichment)
- `src/services/sqlite/SessionStore.ts` -- Expose new query method
- `tests/worker/routes/active-session-routes.test.ts` -- Update tests for new behavior
- `src/ui/viewer/components/SessionDetail.tsx` -- Update UI text (optional polish)

## Implementation Steps

### Phase 1: Database Layer -- Last Observation Context Query

1. **Add `getLastObservationTextForSession()` query** (File: `src/services/sqlite/observations/get.ts`)
   - Action: Create a new exported function that queries the latest observation's `text` (or `narrative` + `title`) for a given `memory_session_id`, ordered by `created_at_epoch DESC LIMIT 1`
   - Why: Provides context for the summary prompt when `lastAssistantMessage` is unavailable from the UI close path. The summary prompt uses `lastAssistantMessage` as context -- we substitute the last observation text as a reasonable alternative
   - Dependencies: None
   - Risk: Low

   ```typescript
   // In src/services/sqlite/observations/get.ts
   export function getLastObservationTextForSession(
     db: Database,
     memorySessionId: string
   ): string | null {
     const stmt = db.prepare(`
       SELECT COALESCE(narrative, title, text) as context_text
       FROM observations
       WHERE memory_session_id = ?
       ORDER BY created_at_epoch DESC
       LIMIT 1
     `);
     const row = stmt.get(memorySessionId) as { context_text: string | null } | undefined;
     return row?.context_text ?? null;
   }
   ```

2. **Expose on SessionStore** (File: `src/services/sqlite/SessionStore.ts`)
   - Action: Add `getLastObservationTextForSession(memorySessionId: string): string | null` method that delegates to the new query function
   - Dependencies: Step 1
   - Risk: Low

### Phase 2: Route Handler Modification

3. **Update `ActiveSessionRoutes` constructor signature** (File: `src/services/worker/http/routes/ActiveSessionRoutes.ts`)
   - Action: Add `sessionManager: SessionManager` and `eventBroadcaster: SessionEventBroadcaster` as constructor parameters alongside existing `dbManager`
   - Why: The route handler needs access to the summary queue (`sessionManager.queueSummarize()`) and event broadcasting
   - Dependencies: None
   - Risk: Low

   ```typescript
   constructor(
     private readonly dbManager: DatabaseManager,
     private readonly sessionManager: SessionManager,
     private readonly eventBroadcaster: SessionEventBroadcaster,
   ) {
     super();
   }
   ```

4. **Modify `handleCloseSession` to queue summary before closing** (File: `src/services/worker/http/routes/ActiveSessionRoutes.ts`)
   - Action: Before calling `store.closeActiveSessionById(id)`, look up the session to get `memory_session_id`, check if a summary already exists, retrieve last observation text as context, queue the summary, and THEN close the session
   - Why: Summary generation must be queued while the session is still 'active' because `queueSummarize` -> `initializeSession` expects to find the session in the database
   - Dependencies: Steps 1-3
   - Risk: Medium -- must ensure ordering (queue first, close second) and handle cases where session has no `memory_session_id` (never processed any observations)

   Pseudocode:
   ```typescript
   handleCloseSession = this.wrapHandler((req: Request, res: Response): void => {
     const id = this.parseIntParam(req, res, 'id');
     if (id === null) return;

     const store = this.dbManager.getSessionStore();

     // Verify session exists and is active before doing anything
     // (closeActiveSessionById already checks this, but we need session data)
     const session = store.getSessionById(id);
     if (!session) {
       this.notFound(res, 'Session not found or not active');
       return;
     }

     // Queue summary if session has been processed (has memory_session_id)
     // and doesn't already have a summary
     if (session.memory_session_id) {
       const existingSummary = store.getSummaryForSession(session.memory_session_id);
       if (!existingSummary) {
         // Get last observation text as context (substitute for lastAssistantMessage)
         const lastObsText = store.getLastObservationTextForSession(session.memory_session_id);

         try {
           this.sessionManager.queueSummarize(id, lastObsText ?? undefined);
           this.eventBroadcaster.broadcastSummarizeQueued();
           logger.info('SESSION', 'Queued summary for UI-closed session', {
             sessionId: id,
             hasContext: !!lastObsText,
           });
         } catch (error) {
           // Log but don't block close -- summary is best-effort
           logger.error('SESSION', 'Failed to queue summary for UI-closed session', {
             sessionId: id,
           }, error);
         }
       } else {
         logger.info('SESSION', 'Session already has summary, skipping', {
           sessionId: id,
         });
       }
     } else {
       logger.info('SESSION', 'Session has no memory_session_id, skipping summary', {
         sessionId: id,
       });
     }

     // Close the session (sets status='completed')
     const closed = store.closeActiveSessionById(id);
     if (!closed) {
       this.notFound(res, 'Session not found or not active');
       return;
     }

     res.json({ success: true, summaryQueued: !!session.memory_session_id });
   });
   ```

5. **Handle `handleCloseStale` summary generation** (File: `src/services/worker/http/routes/ActiveSessionRoutes.ts`)
   - Action: For bulk stale close, we have two options: (a) iterate active sessions and queue summaries before closing, or (b) skip summaries for stale sessions since they're likely abandoned. **Recommend option (a)** for consistency.
   - Why: Stale sessions may still have valuable context worth summarizing
   - Dependencies: Steps 1-4
   - Risk: Medium -- bulk operations could queue many summaries; need to handle gracefully

   Pseudocode:
   ```typescript
   handleCloseStale = this.wrapHandler((_req: Request, res: Response): void => {
     const store = this.dbManager.getSessionStore();
     const threshold = Date.now() - STALE_THRESHOLD_MS;

     // Get stale sessions before closing (need their IDs for summary queueing)
     const activeSessions = store.getActiveSessions();
     const staleSessions = activeSessions.filter(s => s.started_at_epoch < threshold);

     let summariesQueued = 0;
     for (const session of staleSessions) {
       // Look up full session to get memory_session_id
       const fullSession = store.getSessionById(session.id);
       if (fullSession?.memory_session_id) {
         const existingSummary = store.getSummaryForSession(fullSession.memory_session_id);
         if (!existingSummary) {
           try {
             const lastObsText = store.getLastObservationTextForSession(fullSession.memory_session_id);
             this.sessionManager.queueSummarize(session.id, lastObsText ?? undefined);
             summariesQueued++;
           } catch {
             // Log but continue with other sessions
           }
         }
       }
     }

     if (summariesQueued > 0) {
       this.eventBroadcaster.broadcastSummarizeQueued();
     }

     const closedCount = store.closeStaleSessionsOlderThan(threshold);
     if (closedCount > 0) {
       logger.info('SESSION', 'Closed stale sessions', { closedCount, summariesQueued });
     }

     res.json({ closedCount, summariesQueued });
   });
   ```

### Phase 3: Wire Up Dependencies

6. **Update `WorkerService.registerRoutes()`** (File: `src/services/worker-service.ts`)
   - Action: Pass `this.sessionManager` and `this.sessionEventBroadcaster` to the `ActiveSessionRoutes` constructor
   - Why: The constructor signature changed in Step 3
   - Dependencies: Step 3
   - Risk: Low

   ```typescript
   // Before:
   this.server.registerRoutes(new ActiveSessionRoutes(this.dbManager));

   // After:
   this.server.registerRoutes(new ActiveSessionRoutes(
     this.dbManager,
     this.sessionManager,
     this.sessionEventBroadcaster,
   ));
   ```

### Phase 4: Ensure Generator Runs

7. **Ensure SDK agent processes the queued summary** (File: `src/services/worker/http/routes/ActiveSessionRoutes.ts`)
   - Action: After queueing the summary, we need to ensure the generator is running. However, `ensureGeneratorRunning` is currently a private method on `SessionRoutes`. Two approaches:
     - (a) **Extract** `ensureGeneratorRunning` logic into a shared utility/service
     - (b) **Duplicate** a simpler version that just checks if the session has a generator and emits an event if so
     - (c) **Let the existing generator infrastructure handle it** -- if the session already has a running generator (from prior observations), it will pick up the summary message. If not, the pending message store will persist it and it will be processed when the generator next starts.
   - Recommendation: Option (c) for now. The `queueSummarize` method persists to the `pending_messages` table via `getPendingStore().enqueue()`, and `initializeSession` already creates a session in memory. The generator is started by `SessionRoutes` when messages arrive. For UI-close, the session may already have a generator running, or the pending message will be picked up on next generator start.
   - **Critical insight**: After `queueSummarize`, we need to emit the queue event to wake up any waiting generator. Looking at the code, `queueSummarize` already does `emitter?.emit('message')` which wakes the `SessionQueueProcessor`. If no generator is running, the message persists in the database and will be processed when a generator starts.
   - **Problem**: If the session is about to be closed and the generator is not running, we need to start one. The simplest approach is to extract the agent-starting logic into a shared service.
   - Dependencies: Step 4
   - Risk: Medium

   **Refined approach**: Create a `SummaryService` that encapsulates the "queue summary + ensure generator" logic, reusable by both `SessionRoutes` and `ActiveSessionRoutes`. This follows SRP -- `ActiveSessionRoutes` shouldn't need to know about agent providers.

### Phase 4 (Revised): Extract Summary Queue Service

7a. **Create `SummaryQueueService`** (File: `src/services/worker/session/SummaryQueueService.ts`)
    - Action: Create a service class that encapsulates `queueSummarize()` + `ensureGeneratorRunning()` + `broadcastSummarizeQueued()` as a single operation
    - Why: Both `SessionRoutes.handleSummarize` and `ActiveSessionRoutes.handleCloseSession` need this same sequence. Extracting prevents code duplication and keeps route handlers thin
    - Dependencies: None (new file)
    - Risk: Low

    ```typescript
    import type { SessionManager } from '../SessionManager.js';
    import type { SessionEventBroadcaster } from '../events/SessionEventBroadcaster.js';
    import type { SDKAgent } from '../../sdk/SDKAgent.js';
    import type { GeminiAgent } from '../../sdk/GeminiAgent.js';
    import type { OpenAICompatAgent } from '../../sdk/OpenAICompatAgent.js';
    import type { WorkerService } from '../../worker-service.js';
    import { logger } from '../../../utils/logger.js';

    export interface SummaryQueueDeps {
      sessionManager: SessionManager;
      eventBroadcaster: SessionEventBroadcaster;
      workerService: WorkerService;
    }

    export class SummaryQueueService {
      constructor(private readonly deps: SummaryQueueDeps) {}

      /**
       * Queue a summary and ensure the generator is running to process it.
       * Returns true if summary was queued, false if skipped.
       */
      queueSummary(sessionDbId: number, lastAssistantMessage?: string): boolean {
        try {
          this.deps.sessionManager.queueSummarize(sessionDbId, lastAssistantMessage);
          this.deps.eventBroadcaster.broadcastSummarizeQueued();
          return true;
        } catch (error) {
          logger.error('SESSION', 'Failed to queue summary', {
            sessionId: sessionDbId,
          }, error);
          return false;
        }
      }
    }
    ```

    **Important note about the generator**: The `queueSummarize` method persists to the database AND emits a message event on the session's EventEmitter. If a generator is already running for this session, the `SessionQueueProcessor.waitForMessage()` will be notified and process it. If no generator is running, the message is persisted and will be picked up when a generator starts.

    For UI-closed sessions, the generator situation depends on whether the session was actively processing:
    - If the session was actively processing observations, a generator is already running and will pick up the summary
    - If the session was idle (no generator running), we need to start one

    The generator starting logic involves selecting a provider (SDK/Gemini/OpenAI) and creating a streaming iterator. This is currently embedded in `SessionRoutes`. For the initial implementation, we can rely on the fact that most UI-closed sessions had recent activity (a generator was started for observation processing). If the generator has already stopped due to idle timeout, the pending message in the database will be processed on the next observation or can be recovered by the worker's startup recovery logic.

    **Decision**: For Phase 1 of this feature, queue the summary without guaranteeing generator start. The database persistence ensures the summary request survives. Add generator-start capability as a follow-up if sessions are observed to have unprocessed summaries.

7b. **Update `ActiveSessionRoutes` to use `SummaryQueueService`** (File: `src/services/worker/http/routes/ActiveSessionRoutes.ts`)
    - Action: Replace direct `SessionManager` + `SessionEventBroadcaster` injection with `SummaryQueueService`
    - Why: Simpler constructor, less coupling
    - Dependencies: Step 7a
    - Risk: Low

    ```typescript
    constructor(
      private readonly dbManager: DatabaseManager,
      private readonly summaryQueueService: SummaryQueueService,
    ) {
      super();
    }
    ```

7c. **Wire up `SummaryQueueService` in `WorkerService`** (File: `src/services/worker-service.ts`)
    - Action: Create `SummaryQueueService` instance and pass it to `ActiveSessionRoutes`
    - Dependencies: Steps 7a, 7b
    - Risk: Low

### Phase 5: Tests

8. **Add unit test for `getLastObservationTextForSession`** (File: `tests/sqlite/observations.test.ts`)
   - Action: Test the new query function with cases: session with observations returns last one, session with no observations returns null, multiple observations returns most recent
   - Dependencies: Step 1
   - Risk: Low

9. **Update `active-session-routes.test.ts`** (File: `tests/worker/routes/active-session-routes.test.ts`)
   - Action: Update the extracted handler logic functions to include summary queueing behavior. Test cases:
     - Close session with memory_session_id and observations -> summary queued
     - Close session with memory_session_id but existing summary -> summary NOT queued
     - Close session without memory_session_id -> summary NOT queued (graceful skip)
     - Close non-existent session -> 404 (unchanged)
     - Close already-completed session -> 404 (unchanged)
     - Summary queue failure -> session still closes successfully (best-effort summary)
   - Dependencies: Steps 4, 7b
   - Risk: Medium

10. **Add unit test for `SummaryQueueService`** (File: `tests/worker/session/summary-queue-service.test.ts`)
    - Action: Test queueSummary method: success case, failure case (queueSummarize throws)
    - Dependencies: Step 7a
    - Risk: Low

11. **Add integration test for close-with-summary flow** (File: `tests/worker/routes/active-session-close-summary.test.ts`)
    - Action: Test the full flow using mocked SessionManager/EventBroadcaster: POST /api/sessions/:id/close triggers summary queue, then closes
    - Dependencies: Steps 4, 7b
    - Risk: Low

### Phase 6: UI Polish (Optional)

12. **Update response shape documentation** (File: `src/services/worker/http/routes/ActiveSessionRoutes.ts`)
    - Action: Update JSDoc to document the new `summaryQueued` field in the close response
    - Dependencies: Step 4
    - Risk: Low

13. **Update UI to show summary status** (File: `src/ui/viewer/hooks/useActiveSessions.ts`)
    - Action: Optionally show a toast or indicator that summary was queued after closing
    - Dependencies: Step 4
    - Risk: Low

## Testing Strategy

- **Unit tests**: `getLastObservationTextForSession()` query, `SummaryQueueService.queueSummary()`, handler logic functions
- **Integration tests**: Full close-with-summary flow with mocked dependencies
- **Edge case tests**: No memory_session_id, existing summary, queue failure, concurrent close + summarize

## Risks & Mitigations

- **Risk**: Summary queued but no generator running to process it
  - Mitigation: Database persistence ensures the request survives. Worker recovery logic on restart will pick up unprocessed pending messages. Document as a known limitation for Phase 1; extract generator-start logic in a follow-up if needed.

- **Risk**: Race condition between `queueSummarize` and `closeActiveSessionById`
  - Mitigation: Both operations happen synchronously in the same handler -- queue first, close second. The queue writes to `pending_messages` table which is independent of session status. The generator reads from `pending_messages`, not session status.

- **Risk**: Bulk stale close queues many summaries at once
  - Mitigation: Each summary is a lightweight database enqueue. Actual processing is async via the generator. The queue processor handles them sequentially per session.

- **Risk**: Breaking existing Stop hook summary flow
  - Mitigation: The change only modifies the UI close path. The Stop hook still calls `SessionRoutes.handleSummarize` which is untouched.

## Success Criteria

- [ ] `POST /api/sessions/:id/close` queues a summary when session has observations
- [ ] Sessions closed via UI have summaries generated (verifiable in viewer)
- [ ] Existing Stop hook summary generation continues to work
- [ ] Sessions with no observations close cleanly without errors
- [ ] Sessions with existing summaries skip duplicate summary generation
- [ ] All existing tests pass (2111+)
- [ ] New tests cover all edge cases
- [ ] 80%+ test coverage maintained

## Files Modified (Summary)

| File | Action |
|------|--------|
| `src/services/sqlite/observations/get.ts` | Add `getLastObservationTextForSession()` |
| `src/services/sqlite/SessionStore.ts` | Expose new method |
| `src/services/worker/session/SummaryQueueService.ts` | New file -- shared summary queue logic |
| `src/services/worker/http/routes/ActiveSessionRoutes.ts` | Add dependencies, modify handlers |
| `src/services/worker-service.ts` | Wire up new dependencies |
| `tests/sqlite/observations.test.ts` | Add query tests |
| `tests/worker/routes/active-session-routes.test.ts` | Update handler tests |
| `tests/worker/session/summary-queue-service.test.ts` | New file -- service tests |
