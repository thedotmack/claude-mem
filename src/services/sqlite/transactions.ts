
import type { IDatabaseClient } from './database-client.js';
import type { ObservationInput } from './observations/types.js';
import type { SummaryInput } from './summaries/types.js';
import { computeObservationContentHash } from './observations/store.js';

export interface StoreObservationsResult {
  observationIds: number[];
  summaryId: number | null;
  createdAtEpoch: number;
}

export type StoreAndMarkCompleteResult = StoreObservationsResult;

// SQL constants — `@libsql/client` does not expose a Statement object that
// can be cached/reused across calls (queries are planned server-side). Lifting
// the SQL strings to module scope keeps the bodies readable and avoids
// re-allocating the string on every iteration of the per-row loop. See
// PHASE_1_HANDOFF.md §4 conversion patterns.
const INSERT_OBSERVATION_SQL = `
  INSERT INTO observations
  (memory_session_id, project, type, title, subtitle, facts, narrative, concepts,
   files_read, files_modified, prompt_number, discovery_tokens, agent_type, agent_id, content_hash, created_at, created_at_epoch)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(memory_session_id, content_hash) DO NOTHING
  RETURNING id
`;

const LOOKUP_EXISTING_OBSERVATION_SQL =
  'SELECT id FROM observations WHERE memory_session_id = ? AND content_hash = ?';

const INSERT_SUMMARY_SQL = `
  INSERT INTO session_summaries
  (memory_session_id, project, request, investigated, learned, completed,
   next_steps, notes, prompt_number, discovery_tokens, created_at, created_at_epoch)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

const MARK_PENDING_PROCESSED_SQL = `
  UPDATE pending_messages
  SET
    status = 'processed',
    completed_at_epoch = ?,
    tool_input = NULL,
    tool_response = NULL
  WHERE id = ? AND status = 'processing'
`;

export async function storeObservationsAndMarkComplete(
  db: IDatabaseClient,
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

  const tx = await db.transaction('write');
  try {
    const observationIds: number[] = [];

    for (const observation of observations) {
      const contentHash = computeObservationContentHash(memorySessionId, observation.title, observation.narrative);
      const insertResult = await tx.execute({
        sql: INSERT_OBSERVATION_SQL,
        args: [
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
          timestampEpoch,
        ],
      });

      if (insertResult.rows.length > 0) {
        observationIds.push(Number((insertResult.rows[0] as { id: number | bigint }).id));
        continue;
      }

      const lookupResult = await tx.execute({
        sql: LOOKUP_EXISTING_OBSERVATION_SQL,
        args: [memorySessionId, contentHash],
      });
      if (lookupResult.rows.length === 0) {
        throw new Error(
          `storeObservationsAndMarkComplete: ON CONFLICT without existing row for content_hash=${contentHash}`
        );
      }
      observationIds.push(Number((lookupResult.rows[0] as { id: number | bigint }).id));
    }

    let summaryId: number | null = null;
    if (summary) {
      const summaryResult = await tx.execute({
        sql: INSERT_SUMMARY_SQL,
        args: [
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
          timestampEpoch,
        ],
      });
      // `lastInsertRowid` is BigInt | undefined per the IDatabaseClient
      // contract — cast to Number at every use site (gotcha #4 in
      // PHASE_1_HANDOFF.md §5).
      if (summaryResult.lastInsertRowid === undefined) {
        throw new Error(
          'storeObservationsAndMarkComplete: summary INSERT returned no lastInsertRowid'
        );
      }
      summaryId = Number(summaryResult.lastInsertRowid);
    }

    await tx.execute({
      sql: MARK_PENDING_PROCESSED_SQL,
      args: [timestampEpoch, messageId],
    });

    await tx.commit();
    return { observationIds, summaryId, createdAtEpoch: timestampEpoch };
  } catch (err) {
    await tx.rollback();
    throw err;
  }
}

export async function storeObservations(
  db: IDatabaseClient,
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

  const tx = await db.transaction('write');
  try {
    const observationIds: number[] = [];

    for (const observation of observations) {
      const contentHash = computeObservationContentHash(memorySessionId, observation.title, observation.narrative);
      const insertResult = await tx.execute({
        sql: INSERT_OBSERVATION_SQL,
        args: [
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
          timestampEpoch,
        ],
      });

      if (insertResult.rows.length > 0) {
        observationIds.push(Number((insertResult.rows[0] as { id: number | bigint }).id));
        continue;
      }

      const lookupResult = await tx.execute({
        sql: LOOKUP_EXISTING_OBSERVATION_SQL,
        args: [memorySessionId, contentHash],
      });
      if (lookupResult.rows.length === 0) {
        throw new Error(
          `storeObservations: ON CONFLICT without existing row for content_hash=${contentHash}`
        );
      }
      observationIds.push(Number((lookupResult.rows[0] as { id: number | bigint }).id));
    }

    let summaryId: number | null = null;
    if (summary) {
      const summaryResult = await tx.execute({
        sql: INSERT_SUMMARY_SQL,
        args: [
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
          timestampEpoch,
        ],
      });
      if (summaryResult.lastInsertRowid === undefined) {
        throw new Error(
          'storeObservations: summary INSERT returned no lastInsertRowid'
        );
      }
      summaryId = Number(summaryResult.lastInsertRowid);
    }

    await tx.commit();
    return { observationIds, summaryId, createdAtEpoch: timestampEpoch };
  } catch (err) {
    await tx.rollback();
    throw err;
  }
}
