
import { Database } from 'bun:sqlite';
import { logger } from '../../utils/logger.js';
import type { ObservationInput } from './observations/types.js';
import type { SummaryInput } from './summaries/types.js';
import { computeObservationContentHash } from './observations/store.js';

export interface StoreObservationsResult {
  observationIds: number[];
  summaryId: number | null;
  createdAtEpoch: number;
}

export type StoreAndMarkCompleteResult = StoreObservationsResult;

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
  const timestampEpoch = overrideTimestampEpoch ?? Date.now();
  const timestampIso = new Date(timestampEpoch).toISOString();

  const storeAndMarkTx = db.transaction(() => {
    const observationIds: number[] = [];

    const obsStmt = db.prepare(`
      INSERT INTO observations
      (memory_session_id, project, type, title, subtitle, facts, narrative, concepts,
       files_read, files_modified, prompt_number, discovery_tokens, agent_type, agent_id, content_hash, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(memory_session_id, content_hash) DO NOTHING
      RETURNING id
    `);
    const lookupExistingStmt = db.prepare(
      'SELECT id FROM observations WHERE memory_session_id = ? AND content_hash = ?'
    );

    for (const observation of observations) {
      const contentHash = computeObservationContentHash(memorySessionId, observation.title, observation.narrative);
      const inserted = obsStmt.get(
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
        observation.agent_type ?? null,
        observation.agent_id ?? null,
        contentHash,
        timestampIso,
        timestampEpoch
      ) as { id: number } | null;

      if (inserted) {
        observationIds.push(inserted.id);
        continue;
      }

      const existing = lookupExistingStmt.get(memorySessionId, contentHash) as { id: number } | null;
      if (!existing) {
        throw new Error(
          `storeObservationsAndMarkComplete: ON CONFLICT without existing row for content_hash=${contentHash}`
        );
      }
      observationIds.push(existing.id);
    }

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

    // Current queue rows are live work only; completed work is removed, not retained as processed.
    const deleteStmt = db.prepare(`
      DELETE FROM pending_messages
      WHERE id = ? AND status = 'processing'
    `);
    const deleteResult = deleteStmt.run(messageId);
    if (deleteResult.changes !== 1) {
      throw new Error(`storeObservationsAndMarkComplete: failed to complete pending message ${messageId}`);
    }

    return { observationIds, summaryId, createdAtEpoch: timestampEpoch };
  });

  return storeAndMarkTx();
}

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
  const timestampEpoch = overrideTimestampEpoch ?? Date.now();
  const timestampIso = new Date(timestampEpoch).toISOString();

  const storeTx = db.transaction(() => {
    const observationIds: number[] = [];

    const obsStmt = db.prepare(`
      INSERT INTO observations
      (memory_session_id, project, type, title, subtitle, facts, narrative, concepts,
       files_read, files_modified, prompt_number, discovery_tokens, agent_type, agent_id, content_hash, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(memory_session_id, content_hash) DO NOTHING
      RETURNING id
    `);
    const lookupExistingStmt = db.prepare(
      'SELECT id FROM observations WHERE memory_session_id = ? AND content_hash = ?'
    );

    for (const observation of observations) {
      const contentHash = computeObservationContentHash(memorySessionId, observation.title, observation.narrative);
      const inserted = obsStmt.get(
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
        observation.agent_type ?? null,
        observation.agent_id ?? null,
        contentHash,
        timestampIso,
        timestampEpoch
      ) as { id: number } | null;

      if (inserted) {
        observationIds.push(inserted.id);
        continue;
      }

      const existing = lookupExistingStmt.get(memorySessionId, contentHash) as { id: number } | null;
      if (!existing) {
        throw new Error(
          `storeObservations: ON CONFLICT without existing row for content_hash=${contentHash}`
        );
      }
      observationIds.push(existing.id);
    }

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

  return storeTx();
}
