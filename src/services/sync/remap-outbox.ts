// remap_project mutation emission for the two OWN-CONNECTION remap sites
// (plan Phase 3 task 2): WorktreeAdoption.ts (merged_into_project adoption)
// and ProcessManager.ts (one-time cwd-based project remap). Both open their
// own bun:sqlite connections and cannot reach CloudSync.notify(), so
// everything here is pure SQL — the worker's next startup drain or next
// notify() picks the queued op up from sync_outbox.
//
// Contract implemented verbatim from SyncApply.ts REV MINTING RULES:
//   remap_project: compute R = 1 + COALESCE(MAX(sync_rev) over the rows the
//   where-predicate matches on the emitting device, 0); stamp sync_rev = R on
//   those matched rows in the same transaction, and emit rev = R.
//
// The predicate spans observations AND session_summaries (the two tables
// SyncApply.applyRemapProject touches). NATIVE matched rows additionally get
// synced_at re-nulled so the corrected row bodies re-push at rev R (replicas
// that applied the mutation first skip them via the row-op rev guard).
// REPLICA matched rows (origin_device_id NOT NULL) keep their synced_at:
// they are another device's corpus — the push drain must never re-push them
// under this device's identity, and leaving them stamped keeps the pending
// counters honest.
//
// CALLER CONTRACT: emitRemapProject must run INSIDE the caller's transaction
// (both sites already wrap their remap in one), so the rev stamp, the row
// updates, and the outbox insert commit or roll back together. The op UUID is
// minted here, once, at enqueue (stable across push retries — the hub dedupes
// on it).

import type { Database } from 'bun:sqlite';
import { randomUUID } from 'crypto';
import { logger } from '../../utils/logger.js';
import {
  compareCanonicalDecimals,
  incrementCanonicalDecimal,
  validateCanonicalMutation,
  type CanonicalMutation,
} from './CanonicalContent.js';

export interface RemapWhere {
  /** Match rows by project (the worktree-adoption shape). */
  project?: string;
  /** Match rows by memory_session_id (the cwd-remap shape). */
  memory_session_id?: string;
  /** Additionally require merged_into_project IS NULL. */
  merged_into_project_is_null?: boolean;
}

export interface RemapFields {
  project?: string;
  merged_into_project?: string;
}

export interface RemapResult {
  /** Rows the predicate matched (and stamped) in observations. */
  observations: number;
  /** Rows the predicate matched (and stamped) in session_summaries. */
  summaries: number;
  /** The rev R the op was emitted at (0 when nothing matched — no op). */
  rev: string;
}

const REMAP_TABLES = ['observations', 'session_summaries'] as const;

/**
 * True when this database carries the two-lane sync machinery (migration
 * v41's sync_rev columns + v42's sync_outbox table). The remap sites run
 * against DBs the worker may not have migrated yet (they open the file
 * directly), so callers fall back to their legacy plain UPDATEs when this
 * is false — such a DB has never synced through the hub, so there is no
 * replica state to keep converged.
 */
export function hasSyncLane(db: Database): boolean {
  const outbox = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='sync_outbox'"
  ).get() as { name: string } | undefined;
  if (!outbox) return false;
  for (const table of REMAP_TABLES) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    const names = new Set(cols.map(c => c.name));
    if (!names.has('sync_rev') || !names.has('origin_device_id') || !names.has('synced_at')) {
      return false;
    }
  }
  return true;
}

function buildWhere(where: RemapWhere): { sql: string; params: string[] } {
  const clauses: string[] = [];
  const params: string[] = [];
  if (where.project !== undefined) {
    clauses.push('project = ?');
    params.push(where.project);
  }
  if (where.memory_session_id !== undefined) {
    clauses.push('memory_session_id = ?');
    params.push(where.memory_session_id);
  }
  if (where.merged_into_project_is_null === true) {
    clauses.push('merged_into_project IS NULL');
  }
  if (clauses.length === 0) {
    // Mirrors SyncApply.applyRemapProject: an unbounded remap is never
    // intentional — refuse before touching anything.
    throw new Error('emitRemapProject: empty where predicate');
  }
  return { sql: clauses.join(' AND '), params };
}

/**
 * Apply a project remap locally AND queue the matching remap_project
 * mutation op. Returns per-table matched counts (COUNT-then-UPDATE — the
 * outcome never derives from `.run().changes`, per the bun:sqlite trap
 * documented in SyncApply.ts) and the emitted rev.
 *
 * When nothing matches, nothing is written and no op is emitted (rev 0).
 */
export function emitRemapProject(
  db: Database,
  where: RemapWhere,
  fields: RemapFields
): RemapResult {
  const setClauses: string[] = [];
  const setParams: string[] = [];
  if (fields.project !== undefined) {
    setClauses.push('project = ?');
    setParams.push(fields.project);
  }
  if (fields.merged_into_project !== undefined) {
    setClauses.push('merged_into_project = ?');
    setParams.push(fields.merged_into_project);
  }
  if (setClauses.length === 0) {
    throw new Error('emitRemapProject: fields must set project and/or merged_into_project');
  }

  const { sql: whereSql, params: whereParams } = buildWhere(where);

  const counts: Record<(typeof REMAP_TABLES)[number], number> = {
    observations: 0,
    session_summaries: 0,
  };
  for (const table of REMAP_TABLES) {
    counts[table] = (db.prepare(
      `SELECT COUNT(*) AS n FROM ${table} WHERE ${whereSql}`
    ).get(...whereParams) as { n: number }).n;
  }
  const matched = counts.observations + counts.session_summaries;
  if (matched === 0) {
    return { observations: 0, summaries: 0, rev: '0' };
  }

  // R = 1 + MAX(sync_rev) over the matched rows across both tables. Keep the
  // comparison in canonical decimal TEXT so uint64 revisions never pass
  // through SQLite INTEGER affinity or a JavaScript Number.
  let maxRev = '0';
  for (const table of REMAP_TABLES) {
    const revisions = db.prepare(
      `SELECT CAST(sync_rev AS TEXT) AS sync_rev FROM ${table} WHERE ${whereSql}`
    ).all(...whereParams) as Array<{ sync_rev: string }>;
    for (const row of revisions) {
      if (compareCanonicalDecimals(row.sync_rev, maxRev) > 0) maxRev = row.sync_rev;
    }
  }
  const rev = incrementCanonicalDecimal(maxRev);
  const mutation: CanonicalMutation = {
    op: 'remap_project',
    where: { ...where },
    fields: { ...fields },
  };
  validateCanonicalMutation(mutation);

  for (const table of REMAP_TABLES) {
    if (counts[table] === 0) continue;
    db.prepare(`
      UPDATE ${table}
      SET ${setClauses.join(', ')},
          sync_rev = ?,
          synced_at = CASE WHEN origin_device_id IS NULL THEN NULL ELSE synced_at END
      WHERE ${whereSql}
    `).run(...setParams, rev, ...whereParams);
  }

  const opUuid = randomUUID();
  db.prepare(`
    INSERT INTO sync_outbox (op_uuid, rev, body, created_at_epoch)
    VALUES (?, ?, ?, ?)
  `).run(
    opUuid,
    rev,
    JSON.stringify(mutation),
    Date.now()
  );

  logger.debug('CLOUD_SYNC', 'Queued remap_project mutation op', {
    opUuid,
    rev,
    observations: counts.observations,
    summaries: counts.session_summaries,
  });

  return { observations: counts.observations, summaries: counts.session_summaries, rev };
}
