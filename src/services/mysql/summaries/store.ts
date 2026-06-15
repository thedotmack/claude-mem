/**
 * Store summaries (MySQL async)
 */

import { MySQLDatabase } from '../Database.js';
import { logger } from '../../../utils/logger.js';
import type { SummaryInput, StoreSummaryResult } from './types.js';

export async function storeSummary(
  db: MySQLDatabase,
  memorySessionId: string,
  project: string,
  summary: SummaryInput,
  promptNumber?: number,
  discoveryTokens: number = 0,
  overrideTimestampEpoch?: number
): Promise<StoreSummaryResult> {
  const timestampEpoch = overrideTimestampEpoch ?? Date.now();
  const timestampIso = new Date(timestampEpoch).toISOString();

  // Dedup check: if summary exists for this (memory_session_id, prompt_number), UPDATE instead of INSERT
  const existing = await db.prepare(
    'SELECT id FROM session_summaries WHERE memory_session_id = ? AND prompt_number = ?'
  ).get(memorySessionId, promptNumber || null) as { id: number } | null;

  if (existing) {
    await db.prepare(`
      UPDATE session_summaries SET
        project = ?, \`request\` = ?, investigated = ?, learned = ?, completed = ?,
        next_steps = ?, notes = ?, discovery_tokens = ?,
        created_at = ?, created_at_epoch = ?
      WHERE id = ?
    `).run(
      project, summary.request, summary.investigated,
      summary.learned, summary.completed, summary.next_steps, summary.notes,
      discoveryTokens, timestampIso, timestampEpoch,
      existing.id
    );
    return { id: existing.id, createdAtEpoch: timestampEpoch };
  }

  const result = await db.prepare(`
    INSERT INTO session_summaries
    (memory_session_id, project, \`request\`, investigated, learned, completed,
     next_steps, notes, prompt_number, discovery_tokens, created_at, created_at_epoch)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    memorySessionId, project, summary.request, summary.investigated,
    summary.learned, summary.completed, summary.next_steps, summary.notes,
    promptNumber || null, discoveryTokens, timestampIso, timestampEpoch
  );

  return { id: result.insertId, createdAtEpoch: timestampEpoch };
}
