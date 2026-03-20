/**
 * Store session summaries in the database
 */
import type { DbAdapter } from '../adapter.js';
import { exec } from '../adapter.js';
import { logger } from '../../../utils/logger.js';
import type { SummaryInput, StoreSummaryResult } from './types.js';

/**
 * Store a session summary (from SDK parsing)
 * Assumes session already exists - will fail with FK error if not
 *
 * @param db - Database adapter
 * @param memorySessionId - SDK memory session ID
 * @param project - Project name
 * @param summary - Summary content from SDK parsing
 * @param promptNumber - Optional prompt number
 * @param discoveryTokens - Token count for discovery (default 0)
 * @param overrideTimestampEpoch - Optional timestamp override for backlog processing
 */
export async function storeSummary(
  db: DbAdapter,
  memorySessionId: string,
  project: string,
  summary: SummaryInput,
  promptNumber?: number,
  discoveryTokens: number = 0,
  overrideTimestampEpoch?: number
): Promise<StoreSummaryResult> {
  // Use override timestamp if provided (for processing backlog messages with original timestamps)
  const timestampEpoch = overrideTimestampEpoch ?? Date.now();
  const timestampIso = new Date(timestampEpoch).toISOString();

  const result = await exec(db, `
    INSERT INTO session_summaries
    (memory_session_id, project, request, investigated, learned, completed,
     next_steps, notes, prompt_number, discovery_tokens, created_at, created_at_epoch)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
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
  ]);

  return {
    id: result.lastInsertRowid,
    createdAtEpoch: timestampEpoch
  };
}
