⏺ Based on the code quality reviews across all phases, here are the issues that may need to be addressed:

  Critical Issues (Block Deployment)

  1. Type Safety: Unvalidated Message Shape

  File: src/services/worker/SDKAgent.ts (lines 181, 203-207, 215)
  Problem:
  - handleSDKMessage parameter typed as any
  - Direct property access without validation (message.message.content, message.message.usage)
  - Could throw TypeError if SDK returns different message format

  Recommendation:
  interface SDKMessage {
    type: string;
    subtype?: string;
    session_id?: string;
    message?: { content?: any; usage?: any };
  }

  private async handleSDKMessage(
    message: SDKMessage,
    session: ActiveSession,
    worker?: any,
    originalTimestamp?: number | null
  ): Promise<void> {
    // Add validation at entry point
    if (!message?.type) {
      logger.failure('SDK', 'Invalid message structure: missing type', {
        sessionId: session.sessionDbId
      }, new Error('Message type is required'));
      return;
    }

    if (message.type === 'assistant' && message.message?.content) {
      const content = message.message.content;
      // ... safe to proceed
    }
  }

  2. SSE Broadcast Silent Failures

  Files: src/services/worker/SDKAgent.ts (lines 325-346, 397-415)
  Problem:
  - No error handling on sseBroadcaster.broadcast() calls
  - If broadcast throws, observation is saved to DB but never reaches UI
  - Creates silent failures where users see incomplete data

  Recommendation:
  if (worker && worker.sseBroadcaster) {
    try {
      worker.sseBroadcaster.broadcast({
        type: 'new_observation',
        observation: { /* ... */ }
      });
    } catch (broadcastError) {
      logger.warn('SSE', 'Failed to broadcast observation to UI', {
        sessionId: session.sessionDbId,
        obsId,
        type: obs.type
      }, broadcastError);
    }
  }

  High-Priority Issues (Should Fix Before Merge)

  3. DRY Violation: Duplicated Observation/Summary Processing

  File: src/services/worker/SDKAgent.ts (lines 275-347 vs 354-419)
  Problem:
  - Nearly identical 70+ line blocks for observations and summaries
  - Database storage, Chroma sync, SSE broadcast, logging all duplicated
  - Maintenance burden

  Recommendation:
  Extract common pattern into helper method:
  private async broadcastAndSyncDiscovery(
    discoveryId: string,
    discoveryType: 'observation' | 'summary',
    session: ActiveSession,
    discoveryData: any,
    worker: any | undefined,
    createdAtEpoch: number,
    discoveryTokens: number
  ): Promise<void> {
    // 1. Sync to Chroma with error handling
    // 2. Broadcast to SSE with error handling
    // 3. Update Cursor context (observations only)
  }

  4. Promise Chain Error Handling (Fire-and-Forget Pattern)

  Files: src/services/worker/SDKAgent.ts (lines 308-322, 375-395)
  Problem:
  - Chroma sync promises not awaited
  - Errors logged but app continues
  - No indication that vector search won't work
  - No retry logic or circuit breaker

  Recommendation:
  // Check Chroma availability once per session
  if (!session.chromaAvailable) {
    logger.warn('CHROMA', 'Skipping Chroma sync - service unavailable', {
      sessionId: session.sessionDbId
    });
  } else {
    this.dbManager.getChromaSync().syncObservation(/* ... */)
      .catch((error) => {
        logger.failure('CHROMA', 'Observation sync failed', { obsId }, error);
        session.chromaAvailable = false; // Mark as down for session
      });
  }

  Medium-Priority Issues (Nice to Have)

  5. Loose Type Annotation on Message Parameter

  File: src/services/worker/SDKAgent.ts (line 181)
  Problem: Message parameter uses any type

  Recommendation:
  Create discriminated union type:
  type SDKMessage =
    | { type: 'system'; subtype: 'init'; session_id: string; message?: any }
    | { type: 'assistant'; message: { content: any; usage?: any } }
    | { type: string; [key: string]: any };

  6. AbortError Logging Could Be More Descriptive

  File: src/services/worker/SDKAgent.ts (line 167)
  Problem: Limited context in abort logs

  Recommendation:
  if (error.name === 'AbortError') {
    logger.warn('SDK', 'Agent aborted by user', {
      sessionId: session.sessionDbId,
      lastPromptNumber: session.lastPromptNumber,
      tokensUsed: session.cumulativeInputTokens + session.cumulativeOutputTokens
    });
  }

  7. Console.log Usage in Background Services

  File: src/services/worker-service.ts (85+ instances)
  Problem:
  - Console.log calls in background services are invisible
  - Logs go nowhere when running as daemon
  - Test suite explicitly fails on this

  Recommendation:
  Replace all console.log/error with appropriate logger.debug/info/warn/error calls

  Pre-Existing Issues (Not V2-Related)

  These exist on main branch and are unrelated to the V2 migration:
  - TypeScript errors for bun:sqlite module imports
  - Logger component type mismatches
  - Hook result type issues ('initResult' is of type 'unknown')
  - Module initialization order issues

  ---
  Priority Recommendations

  Before Merge:
  1. Add message structure validation (type guard)
  2. Add error handling to SSE broadcast
  3. Address fire-and-forget Chroma sync pattern

  After Merge (Technical Debt):
  4. Extract DRY observation/summary processing pattern
  5. Improve type annotations
  6. Replace console.log with logger calls
  7. Enhance AbortError logging

  The V2 migration itself is functionally sound - the issues identified are mostly about error handling robustness and code organization, not the core V2 API usage.