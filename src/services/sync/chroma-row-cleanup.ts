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

/**
 * Rows must already be committed gone; failures never undo durable deletion.
 *
 * A cleanup that fails is not merely logged (#5664). The SQLite row is gone, so
 * the DELETE route answers 404 from now on and no backfill walks the row again:
 * without a record, the row's documents are orphaned in Chroma for good. The
 * failures are kept in the sync checkpoint as pending row deletes and retried
 * by the next backfill sweep, the same pass that drains pending writes.
 */
export function scheduleChromaRowCleanup(
  chroma: ChromaRowDeleter,
  rows: ReadonlyArray<{ kind: IndexedRowKind; id: string | number }>,
): Promise<void> {
  if (rows.length === 0) return cleanupTail;
  const run = async (): Promise<void> => {
    const failed: PendingRowDelete[] = [];
    for (const row of rows) {
      const docType = CHROMA_DOC_TYPES[row.kind];
      const sqliteId = Number(row.id);
      try {
        await chroma.deleteRowDocuments(docType, sqliteId);
      } catch (error: unknown) {
        logger.warn('CHROMA_SYNC', 'Post-delete Chroma cleanup failed', { kind: row.kind, sqlite_id: row.id, error });
        failed.push({ docType, sqliteId });
      }
    }
    // One checkpoint write per batch: a Chroma outage during a session delete
    // would otherwise rewrite the file once per row.
    if (failed.length > 0) {
      ChromaSyncState.markPendingRowDeletes(failed);
    }
  };
  cleanupTail = cleanupTail.then(run, run);
  return cleanupTail;
}
