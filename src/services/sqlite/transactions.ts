/**
 * Cross-boundary database transactions
 *
 * This module contains atomic transactions that span multiple domains
 * (observations, summaries, pending messages). These functions ensure
 * data consistency across domain boundaries.
 */

import { Database } from 'bun:sqlite';
import { logger } from '../../utils/logger.js';
import type { ObservationInput } from './observations/types.js';
import type { SummaryInput } from './summaries/types.js';

/**
 * Result from storeObservations / storeObservationsAndMarkComplete transaction
 */
export interface StoreObservationsResult {
  observationIds: number[];
  summaryId: number | null;
  createdAtEpoch: number;
}

// Legacy alias for backwards compatibility
export type StoreAndMarkCompleteResult = StoreObservationsResult;

/**
 * ATOMIC: Store observations + summary + mark pending message as processed
 *
 * This function wraps observation storage, summary storage, and message completion
 * in a single database transaction to prevent race conditions. If the worker crashes
 * during processing, either all operations succeed together or all fail together.
 *
 * This fixes the observation duplication bug where observations were stored but
 * the message wasn't marked complete, causing reprocessing on crash recovery.
 *
 * @param db - Database instance
 * @param memorySessionId - SDK memory session ID
 * @param project - Project name
 * @param observations - Array of observations to store (can be empty)
 * @param summary - Optional summary to store
 * @param messageId - Pending message ID to mark as processed
 * @param promptNumber - Optional prompt number
 * @param discoveryTokens - Discovery tokens count
 * @param overrideTimestampEpoch - Optional override timestamp
 * @returns Object with observation IDs, optional summary ID, and timestamp
 */
export function storeObservationsAndMarkComplete(
  db: Database,
  memorySessionId: string,
  project: string,
  observations: ObservationInput[],
  summary: SummaryInput | null,
  messageId: number,
  promptNumber?: number,
  discoveryTokens: number = 0,
  overrideTimestampEpoch?: number
): StoreAndMarkCompleteResult {
  // Use override timestamp if provided
  const timestampEpoch = overrideTimestampEpoch ?? Date.now();
  const timestampIso = new Date(timestampEpoch).toISOString();

  // Create transaction that wraps all operations
  const storeAndMarkTx = db.transaction(() => {
    const observationIds: number[] = [];

    // 1. Store all observations
    const obsStmt = db.prepare(`
      INSERT INTO observations
      (memory_session_id, project, type, title, subtitle, facts, narrative, concepts,
       files_read, files_modified, prompt_number, discovery_tokens, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const observation of observations) {
      const result = obsStmt.run(
        memorySessionId,
        project,
        observation.type,
        observation.title,
        observation.subtitle,
        JSON.stringify(observation.facts),
        observation.narrative,
        JSON.stringify(observation.concepts),
        JSON.stringify(observation.files_read),
        JSON.stringify(observation.files_modified),
        promptNumber || null,
        discoveryTokens,
        timestampIso,
        timestampEpoch
      );
      observationIds.push(Number(result.lastInsertRowid));
    }

    // 2. Store summary if provided
    let summaryId: number | null = null;
    if (summary) {
      const summaryStmt = db.prepare(`
        INSERT INTO session_summaries
        (memory_session_id, project, request, investigated, learned, completed,
         next_steps, notes, prompt_number, discovery_tokens, created_at, created_at_epoch)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const result = summaryStmt.run(
        memorySessionId,
        project,
        summary.request,
        summary.investigated,
        summary.learned,
        summary.completed,
        summary.next_steps,
        summary.notes,
        promptNumber || null,
        discoveryTokens,
        timestampIso,
        timestampEpoch
      );
      summaryId = Number(result.lastInsertRowid);
    }

    // 3. Mark pending message as processed
    // This UPDATE is part of the same transaction, so if it fails,
    // observations and summary will be rolled back
    const updateStmt = db.prepare(`
      UPDATE pending_messages
      SET
        status = 'processed',
        completed_at_epoch = ?,
        tool_input = NULL,
        tool_response = NULL
      WHERE id = ? AND status = 'processing'
    `);
    updateStmt.run(timestampEpoch, messageId);

    return { observationIds, summaryId, createdAtEpoch: timestampEpoch };
  });

  // Execute the transaction and return results
  return storeAndMarkTx();
}

/**
 * ATOMIC: Store observations + summary (no message tracking)
 *
 * Simplified version for use with claim-and-delete queue pattern.
 * Messages are deleted from queue immediately on claim, so there's no
 * message completion to track. This just stores observations and summary.
 *
 * @param db - Database instance
 * @param memorySessionId - SDK memory session ID
 * @param project - Project name
 * @param observations - Array of observations to store (can be empty)
 * @param summary - Optional summary to store
 * @param promptNumber - Optional prompt number
 * @param discoveryTokens - Discovery tokens count
 * @param overrideTimestampEpoch - Optional override timestamp
 * @returns Object with observation IDs, optional summary ID, and timestamp
 */
export function storeObservations(
  db: Database,
  memorySessionId: string,
  project: string,
  observations: ObservationInput[],
  summary: SummaryInput | null,
  promptNumber?: number,
  discoveryTokens: number = 0,
  overrideTimestampEpoch?: number
): StoreObservationsResult {
  // Use override timestamp if provided
  const timestampEpoch = overrideTimestampEpoch ?? Date.now();
  const timestampIso = new Date(timestampEpoch).toISOString();

  // Create transaction that wraps all operations
  const storeTx = db.transaction(() => {
    const observationIds: number[] = [];

    // 1. Store all observations
    const obsStmt = db.prepare(`
      INSERT INTO observations
      (memory_session_id, project, type, title, subtitle, facts, narrative, concepts,
       files_read, files_modified, prompt_number, discovery_tokens, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const observation of observations) {
      const result = obsStmt.run(
        memorySessionId,
        project,
        observation.type,
        observation.title,
        observation.subtitle,
        JSON.stringify(observation.facts),
        observation.narrative,
        JSON.stringify(observation.concepts),
        JSON.stringify(observation.files_read),
        JSON.stringify(observation.files_modified),
        promptNumber || null,
        discoveryTokens,
        timestampIso,
        timestampEpoch
      );
      observationIds.push(Number(result.lastInsertRowid));
    }

    // 2. Store summary if provided
    let summaryId: number | null = null;
    if (summary) {
      const summaryStmt = db.prepare(`
        INSERT INTO session_summaries
        (memory_session_id, project, request, investigated, learned, completed,
         next_steps, notes, prompt_number, discovery_tokens, created_at, created_at_epoch)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const result = summaryStmt.run(
        memorySessionId,
        project,
        summary.request,
        summary.investigated,
        summary.learned,
        summary.completed,
        summary.next_steps,
        summary.notes,
        promptNumber || null,
        discoveryTokens,
        timestampIso,
        timestampEpoch
      );
      summaryId = Number(result.lastInsertRowid);
    }

    return { observationIds, summaryId, createdAtEpoch: timestampEpoch };
  });

  // Execute the transaction and return results
  return storeTx();
}
