import { logger } from '../../utils/logger.js';

/** The part of a bun:sqlite prepared statement these helpers read rows through. */
interface RowStatement {
  iterate?: (...params: any[]) => Iterable<unknown>;
  all: (...params: any[]) => unknown[];
}

let warnedMissingIterate = false;

/**
 * Iterate a prepared statement's rows, preferring the streaming `.iterate()`
 * added in Bun v1.1.31 and falling back to the materializing `.all()` on
 * older runtimes.
 *
 * package.json declares `engines.bun >= 1.1.31`, but engines is advisory —
 * nothing enforces it when the plugin is installed through the Claude Code
 * marketplace. On an older Bun the bare `.iterate()` call threw
 * "…iterate is not a function" from inside schema migration v46, which runs
 * during background init. That rejection left the worker permanently
 * `initialized:false` while still serving 200 on /api/health, so every hook
 * silently skipped until the failure counter began blocking them outright.
 *
 * Falling back keeps every caller correct on old runtimes (it only costs peak
 * memory) and the one-time warning names the real cause instead of a cryptic
 * TypeError.
 */
export function streamRows(statement: RowStatement, ...params: any[]): Iterable<unknown> {
  if (typeof statement.iterate === 'function') return statement.iterate(...params);
  if (!warnedMissingIterate) {
    warnedMissingIterate = true;
    logger.warn('DB', 'bun:sqlite lacks Statement.iterate(); falling back to .all()', {
      bunVersion: typeof Bun !== 'undefined' ? Bun.version : 'unknown',
      requiredBunVersion: '>=1.1.31',
      impact: 'rows are materialized in memory; upgrade Bun to restore streaming',
    });
  }
  return statement.all(...params);
}

/**
 * One page of the rows `statement` returns that satisfy `matches`. `offset`
 * and `limit` count matching rows only, so rows the predicate rejects never
 * shift or shrink a page, and reading stops as soon as the page is full.
 *
 * Takes ownership of `statement` (pass one from `prepare()`, never the cached
 * `query()`): it is finalized before returning. bun:sqlite keeps an
 * `iterate()` cursor open after an early `break` until garbage collection,
 * and SQLite refuses `DROP TABLE` while any statement on the connection is
 * still reading.
 */
export function pageMatchingRows<T>(
  statement: RowStatement & { finalize: () => void },
  params: any[],
  matches: (row: T) => boolean,
  page: { limit: unknown; offset?: unknown },
): T[] {
  try {
    const limit = Number(page.limit);
    if (!Number.isInteger(limit) || limit < 0) {
      throw new Error('Page limit must be a non-negative integer');
    }
    const offset = Number(page.offset ?? 0);
    if (!Number.isInteger(offset)) {
      throw new Error('Page offset must be an integer');
    }
    const rows: T[] = [];
    if (limit === 0) return rows;
    // A negative offset reads from the start, as SQLite's OFFSET does.
    let toSkip = Math.max(0, offset);
    for (const row of streamRows(statement, ...params) as Iterable<T>) {
      if (!matches(row)) continue;
      if (toSkip > 0) {
        toSkip--;
        continue;
      }
      rows.push(row);
      if (rows.length === limit) break;
    }
    return rows;
  } finally {
    statement.finalize();
  }
}
