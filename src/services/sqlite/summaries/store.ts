/**
 * Store session summaries in the database
 */
import type { Database } from 'bun:sqlite';
import { logger } from '../../../utils/logger.js';
import type { SummaryInput, StoreSummaryResult } from './types.js';

/**
 * Store a session summary (from SDK parsing)
 * Assumes session already exists - will fail with FK error if not
 *
 * @param db - Database instance
 * @param memorySessionId - SDK memory session ID
 * @param project - Project name
 * @param summary - Summary content from SDK parsing
 * @param promptNumber - Optional prompt number
 * @param discoveryTokens - Token count for discovery (default 0)
 * @param overrideTimestampEpoch - Optional timestamp override for backlog processing
 */
export function storeSummary(
  db: Database,
  memorySessionId: string,
  project: string,
  summary: SummaryInput,
  promptNumber?: number,
  discoveryTokens: number = 0,
  overrideTimestampEpoch?: number
): StoreSummaryResult {
  // Use override timestamp if provided (for processing backlog messages with original timestamps)
  const timestampEpoch = overrideTimestampEpoch ?? Date.now();
  const timestampIso = new Date(timestampEpoch).toISOString();

  const stmt = db.prepare(`
    INSERT INTO session_summaries
    (memory_session_id, project, request, investigated, learned, completed,
     next_steps, notes, prompt_number, discovery_tokens, created_at, created_at_epoch)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const result = stmt.run(
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

  return {
    id: Number(result.lastInsertRowid),
    createdAtEpoch: timestampEpoch
  };
}
