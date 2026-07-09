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
  maxBackfillRows: number;
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

/**
 * Build a project-scoped `token -> idf` function plus the corpus size, from token_df.
 * Loads the whole project DF table into a Map ONCE (not a per-token SQLite round-trip),
 * so a scan classifying thousands of pairs does one query, not thousands.
 */
export function buildProjectIdf(db: Database, project: string): { idfFn: (t: string) => number; docCount: number } {
  const docCount = getProjectDocCount(db, project);
  const dfRows = db.prepare('SELECT token, df FROM token_df WHERE project = ?').all(project) as { token: string; df: number }[];
  const dfMap = new Map<string, number>(dfRows.map(r => [r.token, r.df]));
  return { idfFn: buildIdfFn((token: string) => dfMap.get(token) ?? 0, docCount), docCount };
}

/** Shared prepared-statement factory for persisting a review-only candidate (DRY). */
function candidateInsert(db: Database) {
  return db.prepare(
    'INSERT OR IGNORE INTO observation_dedup_candidates ' +
    '(observation_id, duplicate_of_id, project, method, score, status, created_at, created_at_epoch) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  );
}

/** Cold-start gate: fuzzy Tier-1 is only trustworthy once the corpus is large enough. */
export function isFuzzyReady(db: Database, project: string, minDocs: number): boolean {
  return getProjectDocCount(db, project) >= minDocs;
}

/**
 * Idempotent backfill = the canonical "rebuild" for a project's IDF model (#3038,
 * research Q-A/Q-C). Recomputes title_norm_key for every row (SQLite can't), then
 * DELETE+INSERT rebuilds token_df and resets dedup_meta — all in one transaction,
 * safe to re-run. This is how an EXISTING DB starts participating in dedup, and how
 * post-deletion DF drift is reclaimed. Returns the project doc count.
 */
export function backfillProjectDedup(db: Database, project: string, maxRows: number = Number.POSITIVE_INFINITY): number {
  const total = (db.prepare('SELECT COUNT(*) c FROM observations WHERE project = ?').get(project) as { c: number }).c;
  if (total > maxRows) {
    logger.warn('DEDUP', `Skipping dedup backfill for project ${project}: ${total} rows exceeds cap ${maxRows} (CLAUDE_MEM_DEDUP_MAX_BACKFILL_ROWS)`);
    return 0;
  }
  // NOTE: dedup_meta.deleted_since_rebuild / last_rebuild_doc_count are reset here and are
  // RESERVED for a future delete-hook-driven auto-rebuild; today the scan always does a full
  // rebuild, so nothing increments deleted_since_rebuild (no runtime observation-delete path).
  const rows = db.prepare('SELECT id, title FROM observations WHERE project = ?').all(project) as { id: number; title: string | null }[];
  const updKey = db.prepare('UPDATE observations SET title_norm_key = ? WHERE id = ?');
  const insDf = db.prepare('INSERT INTO token_df (project, token, df) VALUES (?, ?, ?)');
  const tx = db.transaction(() => {
    const dfMap = new Map<string, number>();
    for (const r of rows) {
      updKey.run(computeTitleNormKey(project, r.title), r.id);
      for (const t of new Set(tokenizeWs(r.title))) dfMap.set(t, (dfMap.get(t) ?? 0) + 1);
    }
    db.prepare('DELETE FROM token_df WHERE project = ?').run(project);
    for (const [t, df] of dfMap) insDf.run(project, t, df);
    db.prepare(
      'INSERT INTO dedup_meta (project, doc_count, last_rebuild_doc_count, deleted_since_rebuild) VALUES (?, ?, ?, 0) ' +
      'ON CONFLICT(project) DO UPDATE SET doc_count = excluded.doc_count, last_rebuild_doc_count = excluded.last_rebuild_doc_count, deleted_since_rebuild = 0'
    ).run(project, rows.length, rows.length);
  });
  tx();
  return rows.length;
}

/**
 * Full-corpus Tier-1 candidate sweep for an EXISTING project, via a bounded
 * inverted index (research Q-C — NOT O(N^2)): only tokens appearing in 2..maxPostingDf
 * rows form postings; pairs sharing >= minSharedTokens of them are classified.
 * Persists review-only candidates (INSERT OR IGNORE). Returns the count persisted.
 */
export function sweepProjectCandidates(db: Database, project: string, cfg: DedupRuntimeConfig): number {
  const rows = db.prepare(
    'SELECT id, title FROM observations WHERE project = ? AND title IS NOT NULL ORDER BY id ASC'
  ).all(project) as { id: number; title: string }[];
  if (rows.length < 2) return 0;
  if (rows.length > cfg.maxBackfillRows) {
    logger.warn('DEDUP', `Skipping dedup sweep for project ${project}: ${rows.length} rows exceeds cap ${cfg.maxBackfillRows}`);
    return 0;
  }
  const { idfFn, docCount } = buildProjectIdf(db, project);
  const thresholds: ClassifyThresholds = {
    cosineThreshold: cfg.cosineThreshold,
    vetoThetaIdf: idf(cfg.idfVetoDf, docCount),
    minSharedTokens: cfg.minSharedTokens,
  };
  const tokensPerRow = rows.map(r => new Set(tokenizeWs(r.title)));
  const df = new Map<string, number>();
  for (const set of tokensPerRow) for (const t of set) df.set(t, (df.get(t) ?? 0) + 1);
  const maxPostingDf = Math.max(2, Math.ceil(Math.sqrt(rows.length)) * 4); // bound postings (skip ultra-common tokens)
  const postings = new Map<string, number[]>();
  tokensPerRow.forEach((set, i) => {
    for (const t of set) {
      const d = df.get(t)!;
      if (d < 2 || d > maxPostingDf) continue;
      let list = postings.get(t);
      if (!list) { list = []; postings.set(t, list); }
      list.push(i);
    }
  });
  const shared = new Map<string, number>(); // "i:j" (i<j) -> shared discriminating-token count
  for (const ids of postings.values()) {
    for (let x = 0; x < ids.length; x++) for (let y = x + 1; y < ids.length; y++) {
      const key = `${ids[x]}:${ids[y]}`;
      shared.set(key, (shared.get(key) ?? 0) + 1);
    }
  }
  const ins = candidateInsert(db);
  const nowIso = new Date().toISOString();
  const nowEpoch = Date.now();
  let count = 0;
  for (const [key, sh] of shared) {
    if (sh < cfg.minSharedTokens) continue;
    const [i, j] = key.split(':').map(Number);
    const c = classifyPair(rows[i].title, rows[j].title, idfFn, thresholds);
    if (c.tier === 'candidate') {
      // Count only rows actually persisted — INSERT OR IGNORE returns changes=0 on a
      // UNIQUE conflict (already-flagged pair), so re-runs report 0, not a phantom count.
      count += ins.run(rows[j].id, rows[i].id, project, c.method, c.score, 'pending', nowIso, nowEpoch).changes;
    }
  }
  return count;
}

/** Run a full dedup-scan (backfill + sweep) over every project. Idempotent. */
export function runDedupScan(db: Database, cfg: DedupRuntimeConfig): { project: string; docs: number; candidates: number }[] {
  const projects = (db.prepare('SELECT DISTINCT project FROM observations').all() as { project: string }[]).map(r => r.project);
  return projects.map(project => {
    const docs = backfillProjectDedup(db, project, cfg.maxBackfillRows);
    const candidates = sweepProjectCandidates(db, project, cfg);
    return { project, docs, candidates };
  });
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
  const ins = candidateInsert(db);
  const nowIso = new Date().toISOString();
  const nowEpoch = Date.now();
  let count = 0;
  for (const r of rows) {
    const c = classifyPair(title, r.title, idfFn, thresholds);
    if (c.tier === 'candidate') {
      // Count only newly-persisted rows (INSERT OR IGNORE → changes=0 on a UNIQUE conflict).
      count += ins.run(newObsId, r.id, project, c.method, c.score, 'pending', nowIso, nowEpoch).changes;
    }
  }
  return count;
}
