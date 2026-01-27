/**
 * ResponseProcessor: Shared response processing for all agent implementations
 *
 * Responsibility:
 * - Parse observations and summaries from agent responses
 * - Execute atomic database transactions (SQLite for Free, Cloud for Pro)
 * - Orchestrate vector sync (Chroma for Free, Pinecone via CloudSync for Pro)
 * - Broadcast to SSE clients
 * - Clean up processed messages
 *
 * Storage modes:
 * - Free users: SQLite (primary) + ChromaDB (vector sync)
 * - Pro users: Supabase/Pinecone (cloud-primary, no SQLite)
 *
 * This module extracts 150+ lines of duplicate code from SDKAgent, GeminiAgent, and OpenRouterAgent.
 */

import { logger } from '../../../utils/logger.js';
import { parseObservations, parseSummary, type ParsedObservation, type ParsedSummary } from '../../../sdk/parser.js';
import { updateCursorContextForProject } from '../../integrations/CursorHooksInstaller.js';
import { updateFolderClaudeMdFiles } from '../../../utils/claude-md-utils.js';
import { getWorkerPort } from '../../../shared/worker-utils.js';
import type { ActiveSession } from '../../worker-types.js';
import type { DatabaseManager } from '../DatabaseManager.js';
import type { SessionManager } from '../SessionManager.js';
import type { WorkerRef, StorageResult } from './types.js';
import { broadcastObservation, broadcastSummary } from './ObservationBroadcaster.js';
import { cleanupProcessedMessages } from './SessionCleanupHelper.js';

/**
 * Process agent response text (parse XML, save to database, sync to vector store, broadcast SSE)
 *
 * This is the unified response processor that handles:
 * 1. Adding response to conversation history (for provider interop)
 * 2. Parsing observations and summaries from XML
 * 3. Atomic storage:
 *    - Pro (cloud-primary): Store directly in Supabase/Pinecone via CloudSync
 *    - Free: Store in SQLite then sync to ChromaDB
 * 4. SSE broadcast to web UI clients
 * 5. Session cleanup
 *
 * @param text - Response text from the agent
 * @param session - Active session being processed
 * @param dbManager - Database manager for storage operations
 * @param sessionManager - Session manager for message tracking
 * @param worker - Worker reference for SSE broadcasting (optional)
 * @param discoveryTokens - Token cost delta for this response
 * @param originalTimestamp - Original epoch when message was queued (for accurate timestamps)
 * @param agentName - Name of the agent for logging (e.g., 'SDK', 'Gemini', 'OpenRouter')
 */
export async function processAgentResponse(
  text: string,
  session: ActiveSession,
  dbManager: DatabaseManager,
  sessionManager: SessionManager,
  worker: WorkerRef | undefined,
  discoveryTokens: number,
  originalTimestamp: number | null,
  agentName: string,
  projectRoot?: string
): Promise<void> {
  // Add assistant response to shared conversation history for provider interop
  if (text) {
    session.conversationHistory.push({ role: 'assistant', content: text });
  }

  // Parse observations and summary
  const observations = parseObservations(text, session.contentSessionId);
  const summary = parseSummary(text, session.sessionDbId);

  // Convert nullable fields to empty strings for storeSummary (if summary exists)
  const summaryForStore = normalizeSummaryForStorage(summary);

  // CRITICAL: Must use memorySessionId (not contentSessionId) for FK constraint
  if (!session.memorySessionId) {
    throw new Error('Cannot store observations: memorySessionId not yet captured');
  }

  // Log pre-storage with session ID chain for verification
  logger.info('DB', `STORING | sessionDbId=${session.sessionDbId} | memorySessionId=${session.memorySessionId} | obsCount=${observations.length} | hasSummary=${!!summaryForStore}`, {
    sessionId: session.sessionDbId,
    memorySessionId: session.memorySessionId
  });

  // Get sync provider to determine storage mode
  const syncProvider = dbManager.getActiveSyncProvider();
  let result: StorageResult;

  // Check if we should use cloud-primary storage (Pro users)
  if (syncProvider.isCloudPrimary()) {
    // PRO MODE: Store directly in cloud (Supabase/Pinecone)
    // Data is NOT stored in SQLite - cloud is the source of truth
    logger.info('DB', 'Using cloud-primary storage (Pro mode)', {
      sessionId: session.sessionDbId,
      project: session.project
    });

    try {
      const cloudResult = await syncProvider.storeObservationsAndSummary(
        session.memorySessionId,
        session.project,
        observations,
        summaryForStore,
        session.lastPromptNumber,
        discoveryTokens,
        originalTimestamp ?? undefined
      );

      result = {
        observationIds: cloudResult.observationIds,
        summaryId: cloudResult.summaryId,
        createdAtEpoch: cloudResult.createdAtEpoch
      };

      logger.info('DB', `STORED (cloud) | sessionDbId=${session.sessionDbId} | memorySessionId=${session.memorySessionId} | obsCount=${result.observationIds.length} | obsIds=[${result.observationIds.join(',')}] | summaryId=${result.summaryId || 'none'}`, {
        sessionId: session.sessionDbId,
        memorySessionId: session.memorySessionId
      });
    } catch (error) {
      logger.error('DB', 'Cloud storage failed - falling back to SQLite', {
        sessionId: session.sessionDbId,
        project: session.project
      }, error as Error);

      // FALLBACK: Save to SQLite so data is not lost
      // Data can be synced to cloud later via backfill
      const sessionStore = dbManager.getSessionStore();
      result = sessionStore.storeObservations(
        session.memorySessionId,
        session.project,
        observations,
        summaryForStore,
        session.lastPromptNumber,
        discoveryTokens,
        originalTimestamp ?? undefined
      );

      logger.info('DB', `STORED (SQLite fallback) | sessionDbId=${session.sessionDbId} | memorySessionId=${session.memorySessionId} | obsCount=${result.observationIds.length} | obsIds=[${result.observationIds.join(',')}] | summaryId=${result.summaryId || 'none'}`, {
        sessionId: session.sessionDbId,
        memorySessionId: session.memorySessionId,
        fallbackReason: 'cloud_storage_failed'
      });

      // IMPORTANT: Data saved to SQLite as fallback for Pro users.
      // This data is only available on this device until cloud sync succeeds.
      // The CloudSync.ensureBackfilled() method will sync this data when:
      // 1. Cloud connectivity is restored
      // 2. User triggers manual sync via /pro-setup or dashboard
      // Cross-device access will not see this data until synced.
      logger.warn('DB', 'Pro user data saved locally - will sync to cloud on next backfill', {
        sessionId: session.sessionDbId,
        observationIds: result.observationIds,
        action: 'Run ensureBackfilled() when cloud is available'
      });
    }
  } else {
    // FREE MODE: Store in SQLite then sync to vector store (Chroma)
    const sessionStore = dbManager.getSessionStore();

    // ATOMIC TRANSACTION: Store observations + summary ONCE
    result = sessionStore.storeObservations(
      session.memorySessionId,
      session.project,
      observations,
      summaryForStore,
      session.lastPromptNumber,
      discoveryTokens,
      originalTimestamp ?? undefined
    );

    // Log storage result with IDs for end-to-end traceability
    logger.info('DB', `STORED (SQLite) | sessionDbId=${session.sessionDbId} | memorySessionId=${session.memorySessionId} | obsCount=${result.observationIds.length} | obsIds=[${result.observationIds.join(',')}] | summaryId=${result.summaryId || 'none'}`, {
      sessionId: session.sessionDbId,
      memorySessionId: session.memorySessionId
    });

    // AFTER transaction commits - sync to vector store (fire-and-forget for Free users)
    await syncObservationsToVectorStore(
      observations,
      result,
      session,
      dbManager,
      discoveryTokens,
      agentName
    );

    await syncSummaryToVectorStore(
      summaryForStore,
      result,
      session,
      dbManager,
      discoveryTokens,
      agentName
    );
  }

  // Broadcast to SSE clients (same for both Free and Pro)
  broadcastObservationsToSSE(observations, result, session, worker);
  broadcastSummaryToSSE(summary, summaryForStore, result, session, worker);

  // Update folder CLAUDE.md files (same for both Free and Pro)
  updateFolderIndexes(observations, session, projectRoot);

  // Update Cursor context if summary present
  if (summaryForStore && result.summaryId) {
    updateCursorContextForProject(session.project, getWorkerPort()).catch(error => {
      logger.warn('CURSOR', 'Context update failed (non-critical)', { project: session.project }, error as Error);
    });
  }

  // Clean up session state
  cleanupProcessedMessages(session, worker);
}

/**
 * Normalize summary for storage (convert null fields to empty strings)
 */
function normalizeSummaryForStorage(summary: ParsedSummary | null): {
  request: string;
  investigated: string;
  learned: string;
  completed: string;
  next_steps: string;
  notes: string | null;
} | null {
  if (!summary) return null;

  return {
    request: summary.request || '',
    investigated: summary.investigated || '',
    learned: summary.learned || '',
    completed: summary.completed || '',
    next_steps: summary.next_steps || '',
    notes: summary.notes
  };
}

/**
 * Sync observations to vector store (Free users only - Chroma)
 * Fire-and-forget: failures are logged but don't break the flow
 */
async function syncObservationsToVectorStore(
  observations: ParsedObservation[],
  result: StorageResult,
  session: ActiveSession,
  dbManager: DatabaseManager,
  discoveryTokens: number,
  agentName: string
): Promise<void> {
  const syncProvider = dbManager.getActiveSyncProvider();

  for (let i = 0; i < observations.length; i++) {
    const obsId = result.observationIds[i];
    const obs = observations[i];
    const syncStart = Date.now();

    syncProvider.syncObservation(
      obsId,
      session.contentSessionId,
      session.project,
      obs,
      session.lastPromptNumber,
      result.createdAtEpoch,
      discoveryTokens
    ).then(() => {
      const syncDuration = Date.now() - syncStart;
      logger.debug('VECTOR', 'Observation synced to vector store', {
        obsId,
        duration: `${syncDuration}ms`,
        type: obs.type,
        title: obs.title || '(untitled)'
      });
    }).catch((error) => {
      logger.error('VECTOR', `${agentName} vector sync failed, continuing without vector search`, {
        obsId,
        type: obs.type,
        title: obs.title || '(untitled)'
      }, error);
    });
  }
}

/**
 * Sync summary to vector store (Free users only - Chroma)
 * Fire-and-forget: failures are logged but don't break the flow
 */
async function syncSummaryToVectorStore(
  summaryForStore: { request: string; investigated: string; learned: string; completed: string; next_steps: string; notes: string | null } | null,
  result: StorageResult,
  session: ActiveSession,
  dbManager: DatabaseManager,
  discoveryTokens: number,
  agentName: string
): Promise<void> {
  if (!summaryForStore || !result.summaryId) {
    return;
  }

  const syncProvider = dbManager.getActiveSyncProvider();
  const syncStart = Date.now();

  syncProvider.syncSummary(
    result.summaryId,
    session.contentSessionId,
    session.project,
    summaryForStore,
    session.lastPromptNumber,
    result.createdAtEpoch,
    discoveryTokens
  ).then(() => {
    const syncDuration = Date.now() - syncStart;
    logger.debug('VECTOR', 'Summary synced to vector store', {
      summaryId: result.summaryId,
      duration: `${syncDuration}ms`,
      request: summaryForStore.request || '(no request)'
    });
  }).catch((error) => {
    logger.error('VECTOR', `${agentName} vector sync failed, continuing without vector search`, {
      summaryId: result.summaryId,
      request: summaryForStore.request || '(no request)'
    }, error);
  });
}

/**
 * Broadcast observations to SSE clients (web UI)
 */
function broadcastObservationsToSSE(
  observations: ParsedObservation[],
  result: StorageResult,
  session: ActiveSession,
  worker: WorkerRef | undefined
): void {
  for (let i = 0; i < observations.length; i++) {
    const obsId = result.observationIds[i];
    const obs = observations[i];

    broadcastObservation(worker, {
      id: obsId,
      memory_session_id: session.memorySessionId,
      session_id: session.contentSessionId,
      type: obs.type,
      title: obs.title,
      subtitle: obs.subtitle,
      text: null,  // text field is not in ParsedObservation
      narrative: obs.narrative || null,
      facts: JSON.stringify(obs.facts || []),
      concepts: JSON.stringify(obs.concepts || []),
      files_read: JSON.stringify(obs.files_read || []),
      files_modified: JSON.stringify(obs.files_modified || []),
      project: session.project,
      prompt_number: session.lastPromptNumber,
      created_at_epoch: result.createdAtEpoch
    });
  }
}

/**
 * Broadcast summary to SSE clients (web UI)
 */
function broadcastSummaryToSSE(
  summary: ParsedSummary | null,
  summaryForStore: { request: string; investigated: string; learned: string; completed: string; next_steps: string; notes: string | null } | null,
  result: StorageResult,
  session: ActiveSession,
  worker: WorkerRef | undefined
): void {
  if (!summaryForStore || !result.summaryId || !summary) {
    return;
  }

  broadcastSummary(worker, {
    id: result.summaryId,
    session_id: session.contentSessionId,
    request: summary.request,
    investigated: summary.investigated,
    learned: summary.learned,
    completed: summary.completed,
    next_steps: summary.next_steps,
    notes: summary.notes,
    project: session.project,
    prompt_number: session.lastPromptNumber,
    created_at_epoch: result.createdAtEpoch
  });
}

/**
 * Update folder CLAUDE.md files for touched folders (fire-and-forget)
 */
function updateFolderIndexes(
  observations: ParsedObservation[],
  session: ActiveSession,
  projectRoot?: string
): void {
  const allFilePaths: string[] = [];
  for (const obs of observations) {
    allFilePaths.push(...(obs.files_modified || []));
    allFilePaths.push(...(obs.files_read || []));
  }

  if (allFilePaths.length > 0) {
    updateFolderClaudeMdFiles(
      allFilePaths,
      session.project,
      getWorkerPort(),
      projectRoot
    ).catch(error => {
      logger.warn('FOLDER_INDEX', 'CLAUDE.md update failed (non-critical)', { project: session.project }, error as Error);
    });
  }
}
