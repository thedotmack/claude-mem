// SPDX-License-Identifier: Apache-2.0

import type { Database } from 'bun:sqlite';
import { logger } from '../../../utils/logger.js';
import { parseReinforcementDates } from '../../reinforcement/strength.js';
import {
  getFactsByIds,
  parseSourceObservationIds,
  type SemanticFactRow,
} from './store.js';

/**
 * Provenance audit + temporal belief queries (memory-review audit G6).
 *
 * No system in the agent-memory corpus exposes "where did this belief come
 * from" or "what did I believe at time X", and the review calls both out as
 * untrodden ground we can own — our bi-temporal columns
 * (valid_from/valid_to, superseded_by, invalidated_at) and
 * source_observation_ids pointers make both mechanically answerable.
 *
 * Read-only query surface: nothing here mutates the store.
 */

/** Lifecycle status of a fact row as of TODAY (not as of a queried instant). */
export type FactLifecycleStatus = 'active' | 'superseded_later' | 'invalidated_later';

export function factLifecycleStatus(
  row: Pick<SemanticFactRow, 'superseded_by' | 'invalidated_at'>,
): FactLifecycleStatus {
  if (row.superseded_by != null) return 'superseded_later';
  if (row.invalidated_at != null) return 'invalidated_later';
  return 'active';
}

export interface ProvenanceSource {
  id: number;
  type: string | null;
  title: string | null;
  created_at: string | null;
  superseded_by: number | null;
  /** True when the source observation was itself superseded — the belief rests on a stale trace. */
  stale: boolean;
}

export interface FactChainEntry {
  id: number;
  kind: string;
  fact: string;
  valid_from: string | null;
  valid_to: string | null;
  status: FactLifecycleStatus;
}

export interface FactProvenanceReport {
  fact: {
    id: number;
    project: string;
    kind: string;
    fact: string;
    valid_from: string | null;
    valid_to: string | null;
    superseded_by: number | null;
    invalidated_at: string | null;
    reinforcement_dates: string[];
    created_at: string;
    status: FactLifecycleStatus;
  };
  provenance: ProvenanceSource[];
  /** Present when the fact carries no source ids (legacy rows). */
  note?: string;
  supersession: {
    /** Who replaced this fact: superseded_by followed recursively up to the active head. Empty for an active fact. */
    superseded_by_chain: FactChainEntry[];
    /** Rows this fact superseded (one level down). */
    replaces: FactChainEntry[];
    /** True when any replaced row is itself the successor of an older row — the chain continues below. */
    replaces_chain_continues: boolean;
  };
}

/** Hard cap on chain walks — a corrupt cycle must not spin the query. */
const MAX_CHAIN_DEPTH = 100;

function toChainEntry(row: SemanticFactRow): FactChainEntry {
  return {
    id: row.id,
    kind: row.kind,
    fact: row.fact,
    valid_from: row.valid_from,
    valid_to: row.valid_to,
    status: factLifecycleStatus(row),
  };
}

/**
 * Full provenance report for one fact: the row itself, its source
 * observations (with a stale flag when a source was superseded), the
 * supersession chain upward to the active head, and the rows it replaced
 * (one level down + a continuation flag). Returns null when the fact does
 * not exist.
 */
export function getFactProvenance(db: Database, id: number): FactProvenanceReport | null {
  const row = getFactsByIds(db, [id])[0];
  if (!row) return null;

  const sourceIds = parseSourceObservationIds(row.source_observation_ids);
  let provenance: ProvenanceSource[] = [];
  if (sourceIds.length > 0) {
    const placeholders = sourceIds.map(() => '?').join(',');
    const rows = db.prepare(`
      SELECT id, type, title, created_at, superseded_by
      FROM observations
      WHERE id IN (${placeholders})
    `).all(...sourceIds) as Array<Omit<ProvenanceSource, 'stale'>>;
    const byId = new Map(rows.map(r => [r.id, r]));
    provenance = sourceIds
      .map(sourceId => byId.get(sourceId))
      .filter((r): r is Omit<ProvenanceSource, 'stale'> => r !== undefined)
      .map(r => ({ ...r, stale: r.superseded_by != null }));
  }

  // Upward: who replaced this fact, followed to the active head.
  const supersededByChain: FactChainEntry[] = [];
  const seen = new Set<number>([id]);
  let cursor = row.superseded_by;
  while (cursor != null && !seen.has(cursor) && supersededByChain.length < MAX_CHAIN_DEPTH) {
    seen.add(cursor);
    const next = getFactsByIds(db, [cursor])[0];
    if (!next) break;
    supersededByChain.push(toChainEntry(next));
    cursor = next.superseded_by;
  }
  if (cursor != null) {
    // Chain ended without reaching an active head: a superseded_by cycle or
    // a pathologically long chain. The report is still honest — it just stops here.
    logger.debug('DB', `Fact provenance chain walk stopped early for #${id}`, {
      chainLength: supersededByChain.length,
      cycled: seen.has(cursor),
    });
  }

  // Down one level: rows this fact superseded, plus a continuation flag.
  const replacedRows = db.prepare(
    'SELECT * FROM semantic_facts WHERE superseded_by = ? ORDER BY created_at_epoch DESC',
  ).all(id) as SemanticFactRow[];
  const replacesChainContinues = replacedRows.some(r =>
    db.prepare('SELECT 1 AS found FROM semantic_facts WHERE superseded_by = ? LIMIT 1').get(r.id) != null,
  );

  return {
    fact: {
      id: row.id,
      project: row.project,
      kind: row.kind,
      fact: row.fact,
      valid_from: row.valid_from,
      valid_to: row.valid_to,
      superseded_by: row.superseded_by,
      invalidated_at: row.invalidated_at,
      reinforcement_dates: parseReinforcementDates(row.reinforcement_dates),
      created_at: row.created_at,
      status: factLifecycleStatus(row),
    },
    provenance,
    ...(sourceIds.length === 0 ? { note: 'no source ids recorded' } : {}),
    supersession: {
      superseded_by_chain: supersededByChain,
      replaces: replacedRows.map(toChainEntry),
      replaces_chain_continues: replacesChainContinues,
    },
  };
}

/**
 * Parse a temporal query instant: epoch milliseconds (number or numeric
 * string) or an ISO 8601 date string. Returns null on anything else.
 */
export function parseTemporalTs(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string' && raw.trim().length > 0) {
    const trimmed = raw.trim();
    if (/^-?\d+$/.test(trimmed)) {
      const asNumber = Number(trimmed);
      return Number.isFinite(asNumber) ? asNumber : null;
    }
    const parsed = Date.parse(trimmed);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

export interface FactsAtOptions {
  /** Include rows that are still active today (default true). */
  includeActive?: boolean;
  /** Row cap (default 50, max 100). */
  limit?: number;
}

export interface FactAtRow {
  id: number;
  kind: string;
  fact: string;
  valid_from: string | null;
  valid_to: string | null;
  superseded_by: number | null;
  invalidated_at: string | null;
  status: FactLifecycleStatus;
}

/**
 * Temporal belief query: facts that were true at `tsMs` —
 * `valid_from <= ts AND (valid_to IS NULL OR valid_to > ts)`, INCLUDING rows
 * superseded or invalidated since (that inclusion is the point of "what did
 * we believe then"). valid_from/valid_to are ISO day strings, so the
 * comparison converts each day to its UTC-midnight epoch: the valid_from day
 * counts as valid, the valid_to day does not. Each row carries its status as
 * of today.
 */
export function getFactsAt(
  db: Database,
  project: string,
  tsMs: number,
  options: FactsAtOptions = {},
): FactAtRow[] {
  const includeActive = options.includeActive !== false;
  const rawLimit = options.limit ?? 50;
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.floor(rawLimit), 100) : 50;

  const rows = db.prepare(`
    SELECT id, kind, fact, valid_from, valid_to, superseded_by, invalidated_at
    FROM semantic_facts
    WHERE project = ?
      AND (valid_from IS NULL OR CAST(strftime('%s', valid_from) AS INTEGER) * 1000 <= ?)
      AND (valid_to IS NULL OR CAST(strftime('%s', valid_to) AS INTEGER) * 1000 > ?)
      ${includeActive ? '' : 'AND (superseded_by IS NOT NULL OR invalidated_at IS NOT NULL)'}
    ORDER BY created_at_epoch DESC
    LIMIT ?
  `).all(project, tsMs, tsMs, limit) as Array<Omit<FactAtRow, 'status'>>;

  return rows.map(row => ({ ...row, status: factLifecycleStatus(row) }));
}
