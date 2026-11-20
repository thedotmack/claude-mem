import type { Database } from 'bun:sqlite';

/** Observe a live SQLite reader, not just a spawned process. Attribution is
 * valid only when the fixture gives the target child exclusive read access.
 * A connection in autocommit does not pin a snapshot between statements. */
export function readSnapshotProbe(db: Database): () => boolean {
  db.run('CREATE TABLE IF NOT EXISTS deep_test_probe(n INTEGER)');
  db.run('INSERT INTO deep_test_probe SELECT 0 WHERE NOT EXISTS(SELECT 1 FROM deep_test_probe)');
  db.run('PRAGMA busy_timeout=0; PRAGMA wal_checkpoint(TRUNCATE)');
  return () => {
    try {
      db.run('UPDATE deep_test_probe SET n=n+1');
      const row = db.query('PRAGMA wal_checkpoint(PASSIVE)').get() as { log: number; checkpointed: number };
      return row.log > row.checkpointed;
    } catch (error) {
      // A competing writer is inconclusive, not evidence of a reader. The
      // bounded async observer retries without blocking its event loop.
      if (['SQLITE_BUSY', 'SQLITE_LOCKED'].includes((error as { code?: string }).code ?? '')) return false;
      throw error;
    }
  };
}

export async function waitForReadSnapshot(pinned: () => boolean, ended: () => boolean, budgetMs: number): Promise<void> {
  const expires = performance.now() + budgetMs;
  while (!ended() && performance.now() < expires) {
    if (pinned()) return;
    await Bun.sleep(5);
  }
  throw new Error('No active SQLite snapshot observed before the request ended');
}
