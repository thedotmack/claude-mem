// SPDX-License-Identifier: Apache-2.0

import { Database } from 'bun:sqlite';
import {
  isoDay,
  appendReinforcement,
  parseReinforcementDates,
  effectiveStrength,
  readTunables,
} from './strength.js';

/**
 * DB-coupled reinforcement helpers for the `observations` table (Phase 1c).
 *
 * The pure ACT-R math lives in ./strength.ts; this module is the thin layer
 * that reads/writes the `reinforcement_dates` / `last_reinforced` columns added
 * by the schema-v33 migration.
 */

/** Initial reinforcement values for a freshly-inserted observation. */
export function seedReinforcement(epochMs: number): { dates: string; lastReinforced: string } {
  const day = isoDay(new Date(epochMs));
  return { dates: JSON.stringify([day]), lastReinforced: day };
}

/**
 * Reinforce one observation: append today's date to its history (FIFO-trimmed,
 * idempotent within a day) and bump `last_reinforced`. Used by the exact-hash
 * dedup path on write, and later by retrieval-feedback / the semantic judge.
 *
 * Returns true if the row was changed (false on same-day no-op or missing row).
 */
export function reinforceObservation(db: Database, id: number, today: Date = new Date()): boolean {
  const row = db
    .prepare('SELECT reinforcement_dates FROM observations WHERE id = ?')
    .get(id) as { reinforcement_dates: string | null } | undefined;
  if (!row) return false;

  const current = parseReinforcementDates(row.reinforcement_dates);
  const next = appendReinforcement(current, today);
  if (next === current || (next.length === current.length && next[next.length - 1] === current[current.length - 1])) {
    return false; // same-day no-op
  }

  db.prepare('UPDATE observations SET reinforcement_dates = ?, last_reinforced = ? WHERE id = ?').run(
    JSON.stringify(next),
    next[next.length - 1],
    id,
  );
  return true;
}

/**
 * Phase 4 — record that observations were surfaced to the agent during context
 * injection. Bumps relevance_count, which feeds back into ranking as a small
 * β·log1p(count) self-reinforcement of notes that keep proving useful enough to
 * surface. Pure count signal — does NOT touch reinforcement_dates (surfacing is
 * not the same as the world re-confirming the fact). No-op on empty input.
 */
export function recordSurfaced(db: Database, ids: number[]): void {
  if (ids.length === 0) return;
  const placeholders = ids.map(() => '?').join(',');
  db.prepare(
    `UPDATE observations SET relevance_count = COALESCE(relevance_count, 0) + 1 WHERE id IN (${placeholders})`,
  ).run(...ids);
}

/** Current ACT-R strength of one observation (0 if no history / missing). */
export function observationStrength(db: Database, id: number, today: Date = new Date()): number {
  const row = db
    .prepare('SELECT reinforcement_dates FROM observations WHERE id = ?')
    .get(id) as { reinforcement_dates: string | null } | undefined;
  if (!row) return 0;
  return effectiveStrength(parseReinforcementDates(row.reinforcement_dates), today, readTunables().powerD);
}
