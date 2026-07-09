/**
 * Cross-boundary database transactions (MySQL async)
 */

import { MySQLDatabase } from './Database.js';
import { logger } from '../../utils/logger.js';
import type { ObservationInput } from './observations/types.js';
import type { SummaryInput } from './summaries/types.js';
import { computeObservationContentHash, findDuplicateByTitle } from './observations/store.js';

export interface StoreObservationsResult {
  observationIds: number[];
  summaryId: number | null;
  createdAtEpoch: number;
}

export type StoreAndMarkCompleteResult = StoreObservationsResult;

/**
 * ATOMIC: Store observations + summary + mark pending message as processed
 */
export async function storeObservationsAndMarkComplete(
  db: MySQLDatabase,
  memorySessionId: string,
  project: string,
  observations: ObservationInput[],
  summary: SummaryInput | null,
  messageId: number,
  promptNumber?: number,
  discoveryTokens: number = 0,
  overrideTimestampEpoch?: number
): Promise<StoreAndMarkCompleteResult> {
  const timestampEpoch = overrideTimestampEpoch ?? Date.now();
  const timestampIso = new Date(timestampEpoch).toISOString();

  return await db.transactionAsync(async (txDb) => {
    const observationIds: number[] = [];

    for (const observation of observations) {
      const contentHash = computeObservationContentHash(memorySessionId, observation.title, observation.narrative);
      // Level 1: Check duplicate by content_hash within transaction
      const existing = await txDb.prepare(
        'SELECT id, created_at_epoch FROM observations WHERE content_hash = ? AND created_at_epoch > ?'
      ).get(contentHash, timestampEpoch - 30000) as { id: number; created_at_epoch: number } | null;

      if (existing) {
        observationIds.push(existing.id);
        continue;
      }

      // Level 2: Check duplicate by title within same session
      const existingByTitle = await txDb.prepare(
        'SELECT id, created_at_epoch FROM observations WHERE memory_session_id = ? AND title = ? ORDER BY id DESC LIMIT 1'
      ).get(memorySessionId, observation.title) as { id: number; created_at_epoch: number } | null;

      if (existingByTitle) {
        logger.debug('DB', `Skipped duplicate observation by title | title=${observation.title?.substring(0, 50)} | existingId=${existingByTitle.id}`);
        observationIds.push(existingByTitle.id);
        continue;
      }

      const result = await txDb.prepare(`
        INSERT INTO observations
        (memory_session_id, project, type, title, subtitle, facts, narrative, concepts,
         files_read, files_modified, prompt_number, discovery_tokens, content_hash, created_at, created_at_epoch)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        memorySessionId, project, observation.type, observation.title, observation.subtitle,
        JSON.stringify(observation.facts), observation.narrative,
        JSON.stringify(observation.concepts), JSON.stringify(observation.files_read),
        JSON.stringify(observation.files_modified), promptNumber || null,
        discoveryTokens, contentHash, timestampIso, timestampEpoch
      );
      observationIds.push(result.insertId);
    }

    let summaryId: number | null = null;
    if (summary) {
      // Dedup check: if summary exists for this (memory_session_id, prompt_number), UPDATE instead of INSERT
      const existing = await txDb.prepare(
        'SELECT id FROM session_summaries WHERE memory_session_id = ? AND prompt_number = ?'
      ).get(memorySessionId, promptNumber || null) as { id: number } | null;

      if (existing) {
        await txDb.prepare(`
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
        summaryId = existing.id;
      } else {
        const result = await txDb.prepare(`
          INSERT INTO session_summaries
          (memory_session_id, project, \`request\`, investigated, learned, completed,
           next_steps, notes, prompt_number, discovery_tokens, created_at, created_at_epoch)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          memorySessionId, project, summary.request, summary.investigated,
          summary.learned, summary.completed, summary.next_steps, summary.notes,
          promptNumber || null, discoveryTokens, timestampIso, timestampEpoch
        );
        summaryId = result.insertId;
      }
    }

    await txDb.prepare(`
      UPDATE pending_messages SET status = 'processed', completed_at_epoch = ?,
        tool_input = NULL, tool_response = NULL
      WHERE id = ? AND status = 'processing'
    `).run(timestampEpoch, messageId);

    return { observationIds, summaryId, createdAtEpoch: timestampEpoch };
  });
}

/**
 * ATOMIC: Store observations + summary (no message tracking)
 */
export async function storeObservations(
  db: MySQLDatabase,
  memorySessionId: string,
  project: string,
  observations: ObservationInput[],
  summary: SummaryInput | null,
  promptNumber?: number,
  discoveryTokens: number = 0,
  overrideTimestampEpoch?: number
): Promise<StoreObservationsResult> {
  const timestampEpoch = overrideTimestampEpoch ?? Date.now();
  const timestampIso = new Date(timestampEpoch).toISOString();

  return await db.transactionAsync(async (txDb) => {
    const observationIds: number[] = [];

    for (const observation of observations) {
      const contentHash = computeObservationContentHash(memorySessionId, observation.title, observation.narrative);
      const existing = await txDb.prepare(
        'SELECT id, created_at_epoch FROM observations WHERE content_hash = ? AND created_at_epoch > ?'
      ).get(contentHash, timestampEpoch - 30000) as { id: number; created_at_epoch: number } | null;

      if (existing) {
        observationIds.push(existing.id);
        continue;
      }

      const result = await txDb.prepare(`
        INSERT INTO observations
        (memory_session_id, project, type, title, subtitle, facts, narrative, concepts,
         files_read, files_modified, prompt_number, discovery_tokens, content_hash, created_at, created_at_epoch)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        memorySessionId, project, observation.type, observation.title, observation.subtitle,
        JSON.stringify(observation.facts), observation.narrative,
        JSON.stringify(observation.concepts), JSON.stringify(observation.files_read),
        JSON.stringify(observation.files_modified), promptNumber || null,
        discoveryTokens, contentHash, timestampIso, timestampEpoch
      );
      observationIds.push(result.insertId);
    }

    let summaryId: number | null = null;
    if (summary) {
      // Dedup check: if summary exists for this (memory_session_id, prompt_number), UPDATE instead of INSERT
      const existing = await txDb.prepare(
        'SELECT id FROM session_summaries WHERE memory_session_id = ? AND prompt_number = ?'
      ).get(memorySessionId, promptNumber || null) as { id: number } | null;

      if (existing) {
        await txDb.prepare(`
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
        summaryId = existing.id;
      } else {
        const result = await txDb.prepare(`
          INSERT INTO session_summaries
          (memory_session_id, project, \`request\`, investigated, learned, completed,
           next_steps, notes, prompt_number, discovery_tokens, created_at, created_at_epoch)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          memorySessionId, project, summary.request, summary.investigated,
          summary.learned, summary.completed, summary.next_steps, summary.notes,
          promptNumber || null, discoveryTokens, timestampIso, timestampEpoch
        );
        summaryId = result.insertId;
      }
    }

    return { observationIds, summaryId, createdAtEpoch: timestampEpoch };
  });
}
