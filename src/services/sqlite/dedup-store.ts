/**
 * Per-project IDF model maintenance for near-duplicate dedup (#3038).
 *
 * `token_df` is the document-frequency table (one row per project+token), and
 * `dedup_meta.doc_count` is the per-project document count. Together they define
 * IDF. Maintained FORWARD on each real observation insert (NOT on a Tier-0 merge,
 * which adds no new document) and (re)built by the opt-in dedup-scan command.
 *
 * Kept as plain functions over a Database so they're unit-testable and keep the
 * already-large SessionStore lean.
 */
import type { Database } from 'bun:sqlite';
import { tokenizeWs } from '../dedup/normalize.js';
import { buildIdfFn } from '../dedup/idf.js';

/** Record one new document: +1 df for each UNIQUE title token, +1 project doc_count. */
export function bumpTokenDf(db: Database, project: string, title: string | null | undefined): void {
  const tokens = [...new Set(tokenizeWs(title))];
  const dfStmt = db.prepare(
    'INSERT INTO token_df (project, token, df) VALUES (?, ?, 1) ' +
    'ON CONFLICT(project, token) DO UPDATE SET df = df + 1'
  );
  for (const t of tokens) dfStmt.run(project, t);
  db.prepare(
    'INSERT INTO dedup_meta (project, doc_count) VALUES (?, 1) ' +
    'ON CONFLICT(project) DO UPDATE SET doc_count = doc_count + 1'
  ).run(project);
}

/** Project document count (0 if the project has no dedup_meta row yet). */
export function getProjectDocCount(db: Database, project: string): number {
  const row = db.prepare('SELECT doc_count FROM dedup_meta WHERE project = ?').get(project) as { doc_count: number } | undefined;
  return row?.doc_count ?? 0;
}

/** Build a project-scoped `token -> idf` function plus the corpus size, from token_df. */
export function buildProjectIdf(db: Database, project: string): { idfFn: (t: string) => number; docCount: number } {
  const docCount = getProjectDocCount(db, project);
  const dfStmt = db.prepare('SELECT df FROM token_df WHERE project = ? AND token = ?');
  const dfLookup = (token: string): number => {
    const row = dfStmt.get(project, token) as { df: number } | undefined;
    return row?.df ?? 0;
  };
  return { idfFn: buildIdfFn(dfLookup, docCount), docCount };
}

/** Cold-start gate: fuzzy Tier-1 is only trustworthy once the corpus is large enough. */
export function isFuzzyReady(db: Database, project: string, minDocs: number): boolean {
  return getProjectDocCount(db, project) >= minDocs;
}
