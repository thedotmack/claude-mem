import { Database } from 'bun:sqlite';

/**
 * Opt a *brand-new* database into incremental auto-vacuum before any table
 * exists. SQLite can only switch auto_vacuum away from NONE on an empty
 * database (otherwise a full VACUUM is required), so this must run before
 * `PRAGMA journal_mode = WAL` and schema creation — the first WAL-mode write
 * locks in whatever mode is set here.
 *
 * Freshness is gated on both an empty `sqlite_master` and `page_count <= 1`.
 * An empty table list alone is necessary-but-not-sufficient: a database that
 * once held tables and dropped them all still reports zero tables while
 * retaining committed pages, and flipping the pragma there reproduces the trap
 * below. A never-written database has `page_count === 0` (`<= 1` tolerates a
 * lone header page), which reliably distinguishes a truly fresh file.
 *
 * Existing NONE databases are deliberately left untouched. Flipping the pragma
 * on a legacy NONE database makes `PRAGMA auto_vacuum` *report* INCREMENTAL
 * without materializing the pointer-map pages, so `PRAGMA incremental_vacuum`
 * silently becomes a no-op and strands existing free pages. Leaving them at
 * NONE keeps a full `VACUUM` as the correct way to reclaim those databases.
 *
 * Returns true when incremental mode was enabled (fresh DB), false otherwise.
 */
export function enableIncrementalAutoVacuumIfFresh(db: Database): boolean {
  const { tableCount } = db
    .query("SELECT COUNT(*) AS tableCount FROM sqlite_master WHERE type = 'table'")
    .get() as { tableCount: number };
  const { page_count: pageCount } = db
    .query('PRAGMA page_count')
    .get() as { page_count: number };
  if (tableCount > 0 || pageCount > 1) {
    return false;
  }
  db.run('PRAGMA auto_vacuum = INCREMENTAL');
  return true;
}
