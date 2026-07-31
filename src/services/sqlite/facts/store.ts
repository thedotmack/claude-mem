// SPDX-License-Identifier: Apache-2.0

import { createHash } from 'crypto';
import type { Database } from 'bun:sqlite';
import { logger } from '../../../utils/logger.js';
import {
  isoDay,
  appendReinforcement,
  parseReinforcementDates,
  MAX_REINFORCEMENT_HISTORY,
} from '../../reinforcement/strength.js';

/**
 * Semantic memory layer — storage helpers for the `semantic_facts` table
 * (schema v53). Facts are short, durable, session-agnostic statements
 * consolidated from observations; the ACT-R strength columns mirror the
 * observations table so the reinforcement engine (persist.ts / rank.ts)
 * applies unchanged.
 *
 * Tombstones only: a fact leaves the active set via `superseded_by` (UPDATE
 * verdict — contradiction with a successor) or `invalidated_at` (DELETE
 * verdict — stopped being true, no successor). Rows are never physically
 * deleted.
 */

export const FACT_KINDS = [
  'project_convention',
  'architecture',
  'environment',
  'user_preference',
  'decision_rationale',
] as const;

export type FactKind = (typeof FACT_KINDS)[number];

export function isFactKind(value: unknown): value is FactKind {
  return typeof value === 'string' && (FACT_KINDS as readonly string[]).includes(value);
}

export interface SemanticFactRow {
  id: number;
  project: string;
  kind: string;
  fact: string;
  source_observation_ids: string;
  reinforcement_dates: string | null;
  last_reinforced: string | null;
  relevance_count: number | null;
  superseded_by: number | null;
  invalidated_at: string | null;
  valid_from: string | null;
  valid_to: string | null;
  content_hash: string;
  created_at: string;
  created_at_epoch: number;
  updated_at_epoch: number;
}

export interface FactInput {
  project: string;
  kind: FactKind;
  fact: string;
  sourceObservationIds: number[];
  /** ISO `YYYY-MM-DD`; defaults to the earliest source observation's day. */
  validFrom?: string | null;
}

/** SHA256(project + fact)[:16] — UNIQUE per project, free dedup on insert. */
export function computeFactContentHash(project: string, fact: string): string {
  return createHash('sha256')
    .update([project || '', fact || ''].join('\x00'))
    .digest('hex')
    .slice(0, 16);
}

/** ISO day of the earliest source observation; null when none resolve. */
function earliestSourceDay(db: Database, sourceObservationIds: number[]): string | null {
  if (sourceObservationIds.length === 0) return null;
  const placeholders = sourceObservationIds.map(() => '?').join(',');
  const row = db
    .prepare(`SELECT MIN(created_at_epoch) AS earliest FROM observations WHERE id IN (${placeholders})`)
    .get(...sourceObservationIds) as { earliest: number | null } | undefined;
  return row?.earliest != null ? isoDay(new Date(row.earliest)) : null;
}

/**
 * Insert a fact with content-hash dedup: an identical (project, fact) pair
 * reinforces the existing row instead of writing a duplicate (mirrors the
 * observations ON CONFLICT path). Returns the row id and whether a new row
 * was written.
 */
export function insertFact(
  db: Database,
  input: FactInput,
  now: Date = new Date(),
): { id: number; inserted: boolean } {
  const contentHash = computeFactContentHash(input.project, input.fact);
  const epochMs = now.getTime();
  const validFrom = input.validFrom ?? earliestSourceDay(db, input.sourceObservationIds) ?? isoDay(now);
  const seedDates = JSON.stringify([isoDay(now)]);

  const inserted = db.prepare(`
    INSERT INTO semantic_facts
    (project, kind, fact, source_observation_ids, reinforcement_dates, last_reinforced,
     relevance_count, valid_from, content_hash, created_at, created_at_epoch, updated_at_epoch)
    VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)
    ON CONFLICT(project, content_hash) DO NOTHING
    RETURNING id
  `).get(
    input.project,
    input.kind,
    input.fact,
    JSON.stringify(input.sourceObservationIds),
    seedDates,
    isoDay(now),
    validFrom,
    contentHash,
    now.toISOString(),
    epochMs,
    epochMs,
  ) as { id: number } | null;

  if (inserted) return { id: inserted.id, inserted: true };

  const existing = db
    .prepare('SELECT id FROM semantic_facts WHERE project = ? AND content_hash = ?')
    .get(input.project, contentHash) as { id: number } | null;
  if (!existing) {
    throw new Error(`insertFact: ON CONFLICT without existing row for content_hash=${contentHash}`);
  }
  reinforceFact(db, existing.id, now);
  logger.debug('DB', `Semantic fact content-hash dedup → reinforced #${existing.id}`, { project: input.project });
  return { id: existing.id, inserted: false };
}

/**
 * Reinforce one fact: append today's date to its history (FIFO-trimmed,
 * idempotent within a day) and bump `last_reinforced`. Same semantics as
 * persist.ts `reinforceObservation`. Returns true when the row changed.
 */
export function reinforceFact(db: Database, id: number, today: Date = new Date()): boolean {
  const row = db
    .prepare('SELECT reinforcement_dates FROM semantic_facts WHERE id = ?')
    .get(id) as { reinforcement_dates: string | null } | undefined;
  if (!row) return false;

  const current = parseReinforcementDates(row.reinforcement_dates);
  const next = appendReinforcement(current, today);
  if (next === current || (next.length === current.length && next[next.length - 1] === current[current.length - 1])) {
    return false; // same-day no-op
  }

  db.prepare('UPDATE semantic_facts SET reinforcement_dates = ?, last_reinforced = ?, updated_at_epoch = ? WHERE id = ?').run(
    JSON.stringify(next),
    next[next.length - 1],
    today.getTime(),
    id,
  );
  return true;
}

/**
 * Retrieval practice for facts (MCP `get_facts`): active recall appends a
 * real reinforcement date, same-day idempotent. Returns how many rows changed.
 */
export function recordFactsRetrieved(db: Database, ids: number[], today: Date = new Date()): number {
  let changed = 0;
  for (const id of ids) {
    if (reinforceFact(db, id, today)) changed++;
  }
  return changed;
}

/** Surfacing feedback: facts shown in the `## Project Knowledge` block. */
export function recordFactSurfaced(db: Database, ids: number[]): void {
  if (ids.length === 0) return;
  const placeholders = ids.map(() => '?').join(',');
  db.prepare(
    `UPDATE semantic_facts SET relevance_count = COALESCE(relevance_count, 0) + 1 WHERE id IN (${placeholders})`,
  ).run(...ids);
}

/**
 * UPDATE verdict — reconsolidation. The new fact replaces the old one: the old
 * row is marked `superseded_by` and its `valid_to` closes; the older half of
 * its reinforcement dates transfers to the new row so the corrected fact
 * inherits part of the trace's strength. First supersession wins, no chains.
 */
export function supersedeFact(db: Database, oldId: number, newId: number, today: Date = new Date()): boolean {
  const rows = db
    .prepare('SELECT id, reinforcement_dates, superseded_by FROM semantic_facts WHERE id IN (?, ?)')
    .all(oldId, newId) as Array<{ id: number; reinforcement_dates: string | null; superseded_by: number | null }>;
  const oldRow = rows.find(r => r.id === oldId);
  const newRow = rows.find(r => r.id === newId);
  if (!oldRow || !newRow || oldRow.superseded_by != null) return false;

  const oldDates = parseReinforcementDates(oldRow.reinforcement_dates);
  const inherited = oldDates.slice(0, Math.ceil(oldDates.length / 2));
  const merged = Array.from(
    new Set([...inherited, ...parseReinforcementDates(newRow.reinforcement_dates)]),
  ).sort();
  const trimmed = merged.slice(-MAX_REINFORCEMENT_HISTORY);

  const epochMs = today.getTime();
  db.prepare('UPDATE semantic_facts SET reinforcement_dates = ?, last_reinforced = ?, updated_at_epoch = ? WHERE id = ?').run(
    JSON.stringify(trimmed),
    trimmed[trimmed.length - 1] ?? null,
    epochMs,
    newId,
  );
  db.prepare('UPDATE semantic_facts SET superseded_by = ?, valid_to = ?, updated_at_epoch = ? WHERE id = ?').run(
    newId,
    isoDay(today),
    epochMs,
    oldId,
  );
  return true;
}

/**
 * DELETE verdict — tombstone. The fact stopped being true with no successor:
 * `invalidated_at` + `valid_to` are set and the row drops out of injection/FTS
 * like a superseded row, but is never physically deleted. No-op when the row
 * is already invalidated or superseded.
 */
export function invalidateFact(db: Database, id: number, today: Date = new Date()): boolean {
  const row = db
    .prepare('SELECT superseded_by, invalidated_at FROM semantic_facts WHERE id = ?')
    .get(id) as { superseded_by: number | null; invalidated_at: string | null } | undefined;
  if (!row || row.invalidated_at != null || row.superseded_by != null) return false;

  db.prepare('UPDATE semantic_facts SET invalidated_at = ?, valid_to = ?, updated_at_epoch = ? WHERE id = ?').run(
    today.toISOString(),
    isoDay(today),
    today.getTime(),
    id,
  );
  return true;
}

/**
 * Active facts for a set of projects: `superseded_by IS NULL AND
 * invalidated_at IS NULL`, newest-first pool sized for strength re-ranking
 * (the caller ranks and caps).
 */
export function getActiveFacts(db: Database, projects: string[], poolLimit: number): SemanticFactRow[] {
  if (projects.length === 0 || poolLimit <= 0) return [];
  const placeholders = projects.map(() => '?').join(',');
  return db.prepare(`
    SELECT * FROM semantic_facts
    WHERE project IN (${placeholders})
      AND superseded_by IS NULL
      AND invalidated_at IS NULL
    ORDER BY created_at_epoch DESC
    LIMIT ?
  `).all(...projects, poolLimit) as SemanticFactRow[];
}

/** Full fact rows by id, newest-first. */
export function getFactsByIds(db: Database, ids: number[]): SemanticFactRow[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(',');
  return db.prepare(
    `SELECT * FROM semantic_facts WHERE id IN (${placeholders}) ORDER BY created_at_epoch DESC`,
  ).all(...ids) as SemanticFactRow[];
}

/** Parse the `source_observation_ids` JSON array (tolerant of malformation). */
export function parseSourceObservationIds(raw: string | null | undefined): number[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((n): n is number => typeof n === 'number' && Number.isInteger(n));
  } catch {
    return [];
  }
}
