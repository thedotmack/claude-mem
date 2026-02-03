/**
 * ResponseProcessor: Shared response processing for all agent implementations
 *
 * Responsibility:
 * - Parse observations and summaries from agent responses
 * - Execute atomic database transactions
 * - Orchestrate Chroma sync (fire-and-forget)
 * - Broadcast to SSE clients
 * - Clean up processed messages
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

// F15 FIX: Extract magic numbers as constants
const DEDUP_WINDOW_SIZE = 5; // Number of recent observations to check for duplicates
const DEDUP_SIMILARITY_THRESHOLD = 0.8; // 80% similarity = duplicate
// F16 FIX / F8 FIX: Memory guard for Levenshtein distance calculation
// Levenshtein uses O(m*n) space. 1000 chars = 1M cells = ~4MB max memory per comparison
// This is 10x larger than typical observations (~100 chars), providing safety headroom
const MAX_LEVENSHTEIN_STRING_LENGTH = 1000;
import type { SessionManager } from '../SessionManager.js';
import type { WorkerRef, StorageResult } from './types.js';
import { broadcastObservation, broadcastSummary } from './ObservationBroadcaster.js';
import { cleanupProcessedMessages } from './SessionCleanupHelper.js';

/**
 * Process agent response text (parse XML, save to database, sync to Chroma, broadcast SSE)
 *
 * This is the unified response processor that handles:
 * 1. Adding response to conversation history (for provider interop)
 * 2. Parsing observations and summaries from XML
 * 3. Atomic database transaction to store observations + summary
 * 4. Async Chroma sync (fire-and-forget, failures are non-critical)
 * 5. SSE broadcast to web UI clients
 * 6. Session cleanup
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
  const parsedObservations = parseObservations(text, session.contentSessionId);
  const summary = parseSummary(text, session.sessionDbId);

  // Convert nullable fields to empty strings for storeSummary (if summary exists)
  const summaryForStore = normalizeSummaryForStorage(summary);

  // Get session store for atomic transaction
  const sessionStore = dbManager.getSessionStore();

  // CRITICAL: Must use memorySessionId (not contentSessionId) for FK constraint
  if (!session.memorySessionId) {
    throw new Error('Cannot store observations: memorySessionId not yet captured');
  }

  /**
   * DEDUPLICATION: Filter out similar observations to prevent storage of duplicates
   *
   * Strategy:
   * - Query last N observations for this session (configurable window, default 5)
   * - Two-pass comparison:
   *   1. Check if titles are exactly identical (strict equality, normalized for null/empty)
   *   2. If titles match, compare identity fields (title, subtitle, type) with Levenshtein
   * - Threshold: 80% similarity = duplicate (configurable via DEDUP_SIMILARITY_THRESHOLD)
   *
   * Rationale: Duplicates occur during tool use, always back-to-back with identical titles
   *
   * FIXES APPLIED (F20 documentation):
   * - F1: Compare only identity fields that both new/existing observations have
   * - F5: Use sortedStringify to ensure deterministic JSON key ordering
   * - F7: Wrapped in try-catch for fail-safe behavior (stores all observations on error)
   * - F8: Normalize null/empty string titles before comparison (SQLite inconsistency)
   * - F15: Extracted magic numbers to constants (DEDUP_WINDOW_SIZE, DEDUP_SIMILARITY_THRESHOLD)
   * - F16: Guard against memory exhaustion (max string length before Levenshtein)
   * - F17: Use > threshold (not >=) to avoid floating point precision issues
   *
   * KNOWN LIMITATIONS:
   * - F2 (Race condition): Query happens outside transaction. Acceptable for single-user usage.
   * - F11 (Null titles): Observations with null titles bypass deduplication (cannot compare).
   * - F19 (High load): 5-observation window might miss non-adjacent duplicates under extreme load.
   * - F23 (Race condition - multi-threaded): Recent observations queried before atomic transaction.
   *   In multi-threaded scenarios, two threads could query the same state and both insert duplicates.
   *   Mitigation: Worker service handles requests sequentially per session in practice.
   * - F43 (Transaction isolation): Check and insert are not in the same transaction.
   *   If another process inserts between READ and WRITE, deduplication won't catch it.
   *   Future: Consider wrapping in BEGIN/COMMIT for true atomicity.
   */
  // F7 FIX: Wrap deduplication in try-catch for fail-safe behavior
  let recentObservations: any[] = [];
  try {
    recentObservations = sessionStore.getRecentObservationsForSession(
      session.memorySessionId,
      DEDUP_WINDOW_SIZE
    );
  } catch (error) {
    logger.warn('OBS_DEDUP', 'Failed to query recent observations, skipping deduplication', {
      sessionDbId: session.sessionDbId,
      memorySessionId: session.memorySessionId
    }, error as Error);
    // Fall through with empty array - all observations will be kept
  }

  const originalCount = parsedObservations.length;
  let observations = parsedObservations;

  /**
   * PASS 1: INTRA-BATCH DEDUPLICATION
   * Filter duplicates within the current batch of observations
   * This prevents storing multiple identical observations from a single agent response
   */
  const seenInBatch = new Map<string, typeof parsedObservations[0]>();
  const uniqueNewObservations: typeof parsedObservations = [];

  for (const newObs of parsedObservations) {
    // F34 FIX: Normalize empty strings to null for consistent comparison
    const normalizedTitle = newObs.title || null;
    const normalizedSubtitle = newObs.subtitle || null;
    const normalizedType = newObs.type || null;

    // Skip deduplication for observations without titles (cannot compare)
    if (!normalizedTitle) {
      uniqueNewObservations.push(newObs);
      continue;
    }

    // Create identity key from title, subtitle, and type (using normalized values)
    const identityKey = sortedStringify({
      title: normalizedTitle,
      subtitle: normalizedSubtitle,
      type: normalizedType
    });

    // Check if we've seen this identity in the current batch
    const firstOccurrence = seenInBatch.get(identityKey);

    if (firstOccurrence) {
      // F26/F33 FIX: identityKey is already the sortedStringify of the identity object
      // If keys match exactly, the observations are identical - no need for Levenshtein
      // identityKey is deterministic, so exact match = 100% similarity = 1.0
      const similarity = 1.0; // Exact match

      if (similarity > DEDUP_SIMILARITY_THRESHOLD) {
        // This is a duplicate of an observation already in this batch
        logger.debug('OBS_DEDUP', `INTRA_BATCH_DUPLICATE | title="${newObs.title}" | similarity=${similarity.toFixed(2)} | action=filtered`, {
          sessionDbId: session.sessionDbId,
          memorySessionId: session.memorySessionId,
          newObsType: newObs.type ?? undefined,
          firstOccurrenceType: firstOccurrence.type ?? undefined
        });
        logger.info('OBS_DEDUP', `INTRA_BATCH_SKIP | title="${newObs.title}" | similarity=${similarity.toFixed(2)}`, {
          sessionDbId: session.sessionDbId,
          memorySessionId: session.memorySessionId
        });
        continue; // Skip this duplicate
      }
    }

    // This observation is unique within the batch (so far)
    seenInBatch.set(identityKey, newObs);
    uniqueNewObservations.push(newObs);
  }

  const intraBatchRemovedCount = parsedObservations.length - uniqueNewObservations.length;
  if (intraBatchRemovedCount > 0) {
    logger.info('OBS_DEDUP', `INTRA_BATCH_STATS | originalCount=${parsedObservations.length} | uniqueCount=${uniqueNewObservations.length} | removedCount=${intraBatchRemovedCount}`, {
      sessionDbId: session.sessionDbId,
      memorySessionId: session.memorySessionId
    });
  }

  try {
    // F8 FIX: Normalize null/empty string values before comparison
    // SQLite can return NULL or empty string "" depending on insertion method
    // F30 FIX: Handle both null and undefined from SQLite
    const normalizeTitle = (title: string | null | undefined) => title || null;

    observations = uniqueNewObservations.filter(newObs => {
      // Skip deduplication if title is null or empty (cannot compare)
      if (!newObs.title) {
        return true; // Keep observation
      }

      const newTitle = normalizeTitle(newObs.title);

      // Check against recent observations
      for (const existingObs of recentObservations) {
        const existingTitle = normalizeTitle(existingObs.title);

        // Pass 1: Exact title match (normalized)
        if (newTitle === existingTitle && newTitle !== null) {
        // Pass 2: Compare identity fields only (title, subtitle, type)
        // F1 FIX: Compare only the subset of fields that both objects have
        // F5 FIX: Use sortedStringify to ensure consistent key ordering
        const newObsIdentity = {
          title: newObs.title,
          subtitle: newObs.subtitle,
          type: newObs.type
        };
        const existingObsIdentity = {
          title: existingObs.title,
          subtitle: existingObs.subtitle,
          type: existingObs.type
        };

        // F16 FIX: Guard against excessive memory usage in Levenshtein
        const newObsJson = sortedStringify(newObsIdentity);
        const existingObsJson = sortedStringify(existingObsIdentity);

        // Skip comparison if strings are too large (memory guard)
        if (newObsJson.length > MAX_LEVENSHTEIN_STRING_LENGTH || existingObsJson.length > MAX_LEVENSHTEIN_STRING_LENGTH) {
          logger.warn('OBS_DEDUP', `String too large for Levenshtein (${Math.max(newObsJson.length, existingObsJson.length)} chars), skipping`, {
            sessionDbId: session.sessionDbId,
            title: newObs.title || undefined
          });
          return true; // Keep observation (cannot compare safely)
        }

        const similarity = calculateSimilarity(newObsJson, existingObsJson);

        // F17 FIX / F31 FIX: Use > threshold (strict greater-than for similarity)
        if (similarity > DEDUP_SIMILARITY_THRESHOLD) {
          logger.debug('OBS_DEDUP', `DUPLICATE_FOUND | title="${newObs.title}" | similarity=${similarity.toFixed(2)} | action=filtered`, {
            sessionDbId: session.sessionDbId,
            memorySessionId: session.memorySessionId,
            newObsType: newObs.type ?? undefined,
            existingObsType: existingObs.type ?? undefined,
            newObsJson: newObsJson.substring(0, 200), // First 200 chars for debugging
            existingObsJson: existingObsJson.substring(0, 200)
          });
          logger.info('OBS_DEDUP', `SKIPPED | title="${newObs.title}" | similarity=${similarity.toFixed(2)}`, {
            sessionDbId: session.sessionDbId,
            memorySessionId: session.memorySessionId,
            newObsType: newObs.type ?? undefined,
            existingObsType: existingObs.type ?? undefined
          });
          return false; // Filter out duplicate
        }
      }
    }

      return true; // Keep observation (no duplicate found)
    });
  } catch (error) {
    // F28 FIX: Enhanced error logging for deduplication failures
    // DECISION: Keep fail-open behavior to avoid data loss, but with better visibility
    logger.error('OBS_DEDUP', 'Deduplication filter failed - potential duplicates may be stored', {
      sessionDbId: session.sessionDbId,
      memorySessionId: session.memorySessionId,
      observationCount: parsedObservations.length
    }, error as Error);
    observations = parsedObservations; // Fail-safe: keep all observations to prevent data loss
  }

  const interBatchRemovedCount = uniqueNewObservations.length - observations.length;
  const totalRemovedCount = originalCount - observations.length;
  if (totalRemovedCount > 0) {
    logger.info('OBS_DEDUP', `TOTAL_STATS | originalCount=${originalCount} | finalCount=${observations.length} | intraBatchRemoved=${intraBatchRemovedCount} | interBatchRemoved=${interBatchRemovedCount} | totalRemoved=${totalRemovedCount}`, {
      sessionDbId: session.sessionDbId,
      memorySessionId: session.memorySessionId
    });
  }

  // Log pre-storage with session ID chain for verification
  logger.info('DB', `STORING | sessionDbId=${session.sessionDbId} | memorySessionId=${session.memorySessionId} | obsCount=${observations.length} | hasSummary=${!!summaryForStore}`, {
    sessionId: session.sessionDbId,
    memorySessionId: session.memorySessionId
  });

  // ATOMIC TRANSACTION: Store observations + summary ONCE
  // Messages are already deleted from queue on claim, so no completion tracking needed
  const result = sessionStore.storeObservations(
    session.memorySessionId,
    session.project,
    observations,
    summaryForStore,
    session.lastPromptNumber,
    discoveryTokens,
    originalTimestamp ?? undefined
  );

  // Log storage result with IDs for end-to-end traceability
  logger.info('DB', `STORED | sessionDbId=${session.sessionDbId} | memorySessionId=${session.memorySessionId} | obsCount=${result.observationIds.length} | obsIds=[${result.observationIds.join(',')}] | summaryId=${result.summaryId || 'none'}`, {
    sessionId: session.sessionDbId,
    memorySessionId: session.memorySessionId
  });

  // AFTER transaction commits - async operations (can fail safely without data loss)
  await syncAndBroadcastObservations(
    observations,
    result,
    session,
    dbManager,
    worker,
    discoveryTokens,
    agentName,
    projectRoot
  );

  // Sync and broadcast summary if present
  await syncAndBroadcastSummary(
    summary,
    summaryForStore,
    result,
    session,
    dbManager,
    worker,
    discoveryTokens,
    agentName
  );

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
 * Sync observations to Chroma and broadcast to SSE clients
 */
async function syncAndBroadcastObservations(
  observations: ParsedObservation[],
  result: StorageResult,
  session: ActiveSession,
  dbManager: DatabaseManager,
  worker: WorkerRef | undefined,
  discoveryTokens: number,
  agentName: string,
  projectRoot?: string
): Promise<void> {
  for (let i = 0; i < observations.length; i++) {
    const obsId = result.observationIds[i];
    const obs = observations[i];
    const chromaStart = Date.now();

    // Sync to Chroma (fire-and-forget)
    dbManager.getChromaSync().syncObservation(
      obsId,
      session.contentSessionId,
      session.project,
      obs,
      session.lastPromptNumber,
      result.createdAtEpoch,
      discoveryTokens
    ).then(() => {
      const chromaDuration = Date.now() - chromaStart;
      logger.debug('CHROMA', 'Observation synced', {
        obsId,
        duration: `${chromaDuration}ms`,
        type: obs.type,
        title: obs.title || '(untitled)'
      });
    }).catch((error) => {
      logger.error('CHROMA', `${agentName} chroma sync failed, continuing without vector search`, {
        obsId,
        type: obs.type,
        title: obs.title || '(untitled)'
      }, error);
    });

    // Broadcast to SSE clients (for web UI)
    // BUGFIX: Use obs.files_read and obs.files_modified (not obs.files)
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

  // Update folder CLAUDE.md files for touched folders (fire-and-forget)
  // This runs per-observation batch to ensure folders are updated as work happens
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

/**
 * Sync summary to Chroma and broadcast to SSE clients
 */
async function syncAndBroadcastSummary(
  summary: ParsedSummary | null,
  summaryForStore: { request: string; investigated: string; learned: string; completed: string; next_steps: string; notes: string | null } | null,
  result: StorageResult,
  session: ActiveSession,
  dbManager: DatabaseManager,
  worker: WorkerRef | undefined,
  discoveryTokens: number,
  agentName: string
): Promise<void> {
  if (!summaryForStore || !result.summaryId) {
    return;
  }

  const chromaStart = Date.now();

  // Sync to Chroma (fire-and-forget)
  dbManager.getChromaSync().syncSummary(
    result.summaryId,
    session.contentSessionId,
    session.project,
    summaryForStore,
    session.lastPromptNumber,
    result.createdAtEpoch,
    discoveryTokens
  ).then(() => {
    const chromaDuration = Date.now() - chromaStart;
    logger.debug('CHROMA', 'Summary synced', {
      summaryId: result.summaryId,
      duration: `${chromaDuration}ms`,
      request: summaryForStore.request || '(no request)'
    });
  }).catch((error) => {
    logger.error('CHROMA', `${agentName} chroma sync failed, continuing without vector search`, {
      summaryId: result.summaryId,
      request: summaryForStore.request || '(no request)'
    }, error);
  });

  // Broadcast to SSE clients (for web UI)
  broadcastSummary(worker, {
    id: result.summaryId,
    session_id: session.contentSessionId,
    request: summary!.request,
    investigated: summary!.investigated,
    learned: summary!.learned,
    completed: summary!.completed,
    next_steps: summary!.next_steps,
    notes: summary!.notes,
    project: session.project,
    prompt_number: session.lastPromptNumber,
    created_at_epoch: result.createdAtEpoch
  });

  // Update Cursor context file for registered projects (fire-and-forget)
  updateCursorContextForProject(session.project, getWorkerPort()).catch(error => {
    logger.warn('CURSOR', 'Context update failed (non-critical)', { project: session.project }, error as Error);
  });
}

/**
 * Calculate Levenshtein distance between two strings
 * Returns the minimum number of single-character edits required to change s1 into s2
 * @internal - Exported for testing
 */
export function levenshteinDistance(s1: string, s2: string): number {
  const len1 = s1.length;
  const len2 = s2.length;
  const matrix: number[][] = [];

  // Initialize matrix
  for (let i = 0; i <= len1; i++) {
    matrix[i] = [i];
  }
  for (let j = 0; j <= len2; j++) {
    matrix[0][j] = j;
  }

  // Fill matrix
  for (let i = 1; i <= len1; i++) {
    for (let j = 1; j <= len2; j++) {
      if (s1[i - 1] === s2[j - 1]) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1, // substitution
          matrix[i][j - 1] + 1,     // insertion
          matrix[i - 1][j] + 1      // deletion
        );
      }
    }
  }

  return matrix[len1][len2];
}

/**
 * Calculate similarity score between two strings (0-1 range)
 * 1.0 = identical, 0.0 = completely different
 * @internal - Exported for testing
 */
export function calculateSimilarity(s1: string, s2: string): number {
  if (s1 === s2) return 1.0;
  if (s1.length === 0 && s2.length === 0) return 1.0;
  if (s1.length === 0 || s2.length === 0) return 0.0;

  const distance = levenshteinDistance(s1, s2);
  const maxLength = Math.max(s1.length, s2.length);
  return 1 - (distance / maxLength);
}

/**
 * Stringify object with sorted keys to ensure deterministic JSON output
 *
 * F5 FIX: JSON.stringify() does not guarantee property order. This ensures
 * two objects with identical content but different key order produce the same string.
 *
 * @param obj - Object to stringify
 * @returns JSON string with keys in alphabetical order
 * @internal - Exported for testing
 */
export function sortedStringify(obj: Record<string, any>): string {
  const sorted: Record<string, any> = {};
  Object.keys(obj).sort().forEach(key => {
    sorted[key] = obj[key];
  });
  return JSON.stringify(sorted);
}
