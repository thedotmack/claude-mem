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
import { createHash } from 'crypto';
import type { Database } from 'bun:sqlite';
import { normalizeTitle, tokenizeWs } from '../dedup/normalize.js';
import { buildIdfFn, idf } from '../dedup/idf.js';
import { classifyPair, type ClassifyThresholds } from '../dedup/nearDuplicate.js';
import { logger } from '../../utils/logger.js';

/** Runtime dedup knobs resolved from settings. */
export interface DedupRuntimeConfig {
  cosineThreshold: number;
  idfVetoDf: number;
  minSharedTokens: number;
  maxScan: number;
}

/**
 * Project-scoped exact-normalized-title key for O(1) Tier-0 lookup (#3038).
 * SQLite cannot express `\p{L}`-aware normalization itself (ASCII-only lower(),
 * no regexp_replace, no bun:sqlite custom functions), so we precompute the key
 * in app code and store it in an indexed column — the same pattern as content_hash.
 *
 * Returns null when the title normalizes to empty (null/punctuation/emoji-only):
 * those must NOT collapse into each other (data-loss guard), and a NULL key never
 * matches via `title_norm_key = ?`.
 */
export function computeTitleNormKey(project: string, title: string | null | undefined): string | null {
  const norm = normalizeTitle(title);
  if (norm === '') return null;
  return createHash('sha256').update(`${project}\x00${norm}`).digest('hex').slice(0, 32);
}

/** O(1) Tier-0 lookup: the existing canonical row for this (project, normalized-title), or null. */
export function findTier0Canonical(
  db: Database,
  project: string,
  normKey: string | null
): { id: number; occurrence_count: number; created_at_epoch: number } | null {
  if (normKey === null) return null;
  return (db.prepare(
    'SELECT id, occurrence_count, created_at_epoch FROM observations ' +
    'WHERE project = ? AND title_norm_key = ? ORDER BY created_at_epoch ASC, id ASC LIMIT 1'
  ).get(project, normKey) as { id: number; occurrence_count: number; created_at_epoch: number } | undefined) ?? null;
}

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

/**
 * Tier-1 (review-only) near-duplicate scan for a freshly-inserted observation.
 * Compares its title against up to `maxScan` recent same-project titles and
 * persists any 'candidate' verdicts into observation_dedup_candidates
 * (INSERT OR IGNORE — UNIQUE(observation_id,duplicate_of_id) dedups). NEVER
 * merges. The full-corpus sweep is the offline dedup-scan command. Returns the
 * number of candidates persisted.
 */
export function recordTier1Candidates(
  db: Database,
  project: string,
  newObsId: number,
  title: string | null | undefined,
  cfg: DedupRuntimeConfig
): number {
  if (!title) return 0;
  const { idfFn, docCount } = buildProjectIdf(db, project);
  const thresholds: ClassifyThresholds = {
    cosineThreshold: cfg.cosineThreshold,
    vetoThetaIdf: idf(cfg.idfVetoDf, docCount),
    minSharedTokens: cfg.minSharedTokens,
  };
  const rows = db.prepare(
    'SELECT id, title FROM observations WHERE project = ? AND id != ? AND title IS NOT NULL ' +
    'ORDER BY created_at_epoch DESC, id DESC LIMIT ?'
  ).all(project, newObsId, cfg.maxScan) as { id: number; title: string }[];
  if (rows.length === cfg.maxScan) {
    logger.debug('DEDUP', `Tier-1 scan hit MAX_SCAN=${cfg.maxScan} for project ${project}; older rows covered by dedup-scan`);
  }
  const ins = db.prepare(
    'INSERT OR IGNORE INTO observation_dedup_candidates ' +
    '(observation_id, duplicate_of_id, project, method, score, status, created_at, created_at_epoch) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  );
  const nowIso = new Date().toISOString();
  const nowEpoch = Date.now();
  let count = 0;
  for (const r of rows) {
    const c = classifyPair(title, r.title, idfFn, thresholds);
    if (c.tier === 'candidate') {
      ins.run(newObsId, r.id, project, c.method, c.score, 'pending', nowIso, nowEpoch);
      count++;
    }
  }
  return count;
}
