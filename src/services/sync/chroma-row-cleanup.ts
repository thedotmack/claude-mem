import { logger } from '../../utils/logger.js';
import type { ContentKind } from './CanonicalContent.js';

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

/** Rows must already be committed gone; failures never undo durable deletion. */
export function scheduleChromaRowCleanup(
  chroma: ChromaRowDeleter,
  rows: ReadonlyArray<{ kind: IndexedRowKind; id: string | number }>,
): Promise<void> {
  if (rows.length === 0) return cleanupTail;
  const run = async (): Promise<void> => {
    for (const row of rows) {
      try {
        await chroma.deleteRowDocuments(CHROMA_DOC_TYPES[row.kind], Number(row.id));
      } catch (error: unknown) {
        logger.warn('CHROMA_SYNC', 'Post-delete Chroma cleanup failed', { kind: row.kind, sqlite_id: row.id, error });
      }
    }
  };
  cleanupTail = cleanupTail.then(run, run);
  return cleanupTail;
}
