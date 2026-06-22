import type { Database } from 'bun:sqlite';
import { logger } from '../../../utils/logger.js';
import type { SummaryInput, StoreSummaryResult } from './types.js';
import { isCloudEnabled } from '../../cloud/config.js';
import { enqueueOutbox, notifyEnqueued } from '../../cloud/outbox.js';

export function storeSummary(
  db: Database,
  memorySessionId: string,
  project: string,
  summary: SummaryInput,
  promptNumber?: number,
  discoveryTokens: number = 0,
  overrideTimestampEpoch?: number
): StoreSummaryResult {
  const timestampEpoch = overrideTimestampEpoch ?? Date.now();
  const timestampIso = new Date(timestampEpoch).toISOString();

  // Read the cloud gate ONCE, before the transaction (default off => no-op).
  const cloudEnabled = isCloudEnabled();

  const stmt = db.prepare(`
    INSERT INTO session_summaries
    (memory_session_id, project, request, investigated, learned, completed,
     next_steps, notes, prompt_number, discovery_tokens, created_at, created_at_epoch)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  // Wrap the base insert + outbox enqueue in one transaction so they commit
  // atomically (all-or-nothing). When cloud is disabled this is a single insert.
  const writeTx = db.transaction(() => {
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
    const id = Number(result.lastInsertRowid);
    if (cloudEnabled) {
      enqueueOutbox(db, { kind: 'summary', localId: id, lane: 'live', createdAtEpoch: timestampEpoch });
    }
    return id;
  });

  const id = writeTx();
  // Wake the pusher AFTER commit, never inside the txn.
  if (cloudEnabled) notifyEnqueued();

  return {
    id,
    createdAtEpoch: timestampEpoch
  };
}
