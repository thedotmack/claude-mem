// SPDX-License-Identifier: Apache-2.0

import { Database } from 'bun:sqlite';
import { isoDay, appendReinforcement, parseReinforcementHistory, reinforcementSeedIndex } from './strength.js';

/**
 * DB-coupled reinforcement helpers for the `observations` table: the thin layer
 * that reads and writes the `reinforcement_dates` / `last_reinforced` columns.
 * The ranking math lives in ./rank.ts.
 */

/** Initial reinforcement values for a freshly inserted observation. */
export function seedReinforcement(epochMs: number): { dates: string; lastReinforced: string } {
  const day = isoDay(new Date(epochMs));
  return { dates: JSON.stringify({ version: 1, dates: [day], seedIndex: 0 }), lastReinforced: day };
}

/**
 * Reinforce one observation: append the day to its history (FIFO-trimmed,
 * idempotent within a day) and bump `last_reinforced`. Called when the world
 * re-confirms an observation that already exists (a duplicate the write path
 * collapses onto the existing row).
 *
 * Returns true if the row changed (false on a same-day no-op or a missing row).
 */
export function reinforceObservation(db: Database, id: number, today: Date = new Date()): boolean {
  const row = db
    .prepare('SELECT reinforcement_dates, created_at_epoch FROM observations WHERE id = ?')
    .get(id) as { reinforcement_dates: string | null; created_at_epoch: number } | undefined;
  if (!row) return false;

  const history = parseReinforcementHistory(row.reinforcement_dates);
  const current = history.dates;
  const seedIndex = reinforcementSeedIndex(history, isoDay(new Date(row.created_at_epoch)));
  const next = appendReinforcement(current, today);
  if (next === current) return false; // same-day no-op

  const trimmed = current.length + 1 - next.length;
  const retainedSeedIndex = seedIndex !== null && seedIndex >= trimmed ? seedIndex - trimmed : null;
  db.prepare('UPDATE observations SET reinforcement_dates = ?, last_reinforced = ? WHERE id = ?').run(
    JSON.stringify({ version: 1, dates: next, seedIndex: retainedSeedIndex }),
    next[next.length - 1],
    id,
  );
  return true;
}
