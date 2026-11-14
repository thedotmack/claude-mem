import { logger } from '../../utils/logger.js';
import type { ContentKind } from './CanonicalContent.js';
import { ChromaSyncState, type PendingRowDelete } from './ChromaSyncState.js';

export type IndexedRowKind = Exclude<ContentKind, 'work_state'>;

const CHROMA_DOC_TYPES: Record<IndexedRowKind, string> = {
  observation: 'observation',
  summary: 'session_summary',
  prompt: 'user_prompt',
};

interface ChromaRowDeleter {
  deleteRowDocuments(docType: string, sqliteId: number): Promise<unknown>;
}

// Local deletes and replicated tombstones share the same cleanup lane. A
// burst must not flood chroma-mcp's single stdio channel with parallel reads.
let cleanupTail: Promise<void> = Promise.resolve();
// One checkpoint entry can represent several queued deletes of the same row.
// Keep it until every live reservation has finished, even if an earlier one
// succeeds while a later restore/delete is still waiting for its turn.
const queuedRowDeletes = new Map<string, number>();

function rowDeleteKey(row: PendingRowDelete): string {
  return `${row.docType}:${row.sqliteId}`;
}

/** A retry must not consume the checkpoint of a cleanup still on this lane. */
export function isQueuedChromaRowDelete(row: PendingRowDelete): boolean {
  return queuedRowDeletes.has(rowDeleteKey(row));
}

/**
 * Run a retry pass on the lane the scheduled cleanups use, so a burst the
 * delete routes just queued cannot interleave with it. The pass owns its
 * failures: this only keeps the lane moving, like scheduleChromaRowCleanup.
 */
export function runOnChromaRowCleanupLane(operation: () => Promise<void>): Promise<void> {
  const run = cleanupTail.then(operation, operation);
  cleanupTail = run.then(() => undefined, () => undefined);
  return run;
}

/**
 * Rows must already be committed gone; failures never undo durable deletion.
 *
 * A cleanup that fails is not merely logged (#5664). The SQLite row is gone, so
 * the DELETE route answers 404 from now on and no backfill walks the row again:
 * without a record, the row's documents are orphaned in Chroma for good. The
 * failures are kept in the sync checkpoint as pending row deletes and retried
 * by the next backfill sweep, the same pass that drains pending writes, or as
 * soon as chroma-mcp comes back (see ChromaSync's recovery subscription).
 * Reserve the batch before yielding to the cleanup lane: the worker can exit
 * while it is queued or in flight, before any failure can be recorded.
 */
export function scheduleChromaRowCleanup(
  chroma: ChromaRowDeleter,
  rows: ReadonlyArray<{ kind: IndexedRowKind; id: string | number }>,
): Promise<void> {
  if (rows.length === 0) return cleanupTail;
  const pending = rows.map(row => ({
    docType: CHROMA_DOC_TYPES[row.kind], sqliteId: Number(row.id),
  }));
  for (const row of pending) {
    const key = rowDeleteKey(row);
    queuedRowDeletes.set(key, (queuedRowDeletes.get(key) ?? 0) + 1);
  }
  ChromaSyncState.markPendingRowDeletes(pending);
  const run = async (): Promise<void> => {
    const failed: PendingRowDelete[] = [];
    const finished: PendingRowDelete[] = [];
    try {
      for (let index = 0; index < pending.length; index += 1) {
        const row = pending[index];
        try {
          await chroma.deleteRowDocuments(row.docType, row.sqliteId);
          finished.push(row);
        } catch (error: unknown) {
          logger.warn('CHROMA_SYNC', 'Post-delete Chroma cleanup failed', { kind: rows[index].kind, sqlite_id: row.sqliteId, error });
          failed.push(row);
        }
      }
    } finally {
      for (const row of pending) {
        const key = rowDeleteKey(row);
        const remaining = (queuedRowDeletes.get(key) ?? 1) - 1;
        if (remaining === 0) queuedRowDeletes.delete(key);
        else queuedRowDeletes.set(key, remaining);
      }
      // Complete once per batch, leaving later reservations of the same row.
      const failedKeys = new Set(failed.map(rowDeleteKey));
      const completed = finished.filter(row =>
        !isQueuedChromaRowDelete(row) && !failedKeys.has(rowDeleteKey(row)));
      if (completed.length > 0) ChromaSyncState.clearPendingRowDeletes(completed);
      // Retry persistence if the initial reservation could not reach disk.
      if (failed.length > 0) ChromaSyncState.markPendingRowDeletes(failed);
    }
  };
  cleanupTail = cleanupTail.then(run, run);
  return cleanupTail;
}
