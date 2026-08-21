// SPDX-License-Identifier: Apache-2.0

import { Database } from 'bun:sqlite';
import {
  isoDay,
  appendReinforcement,
  parseReinforcementDates,
  effectiveStrength,
  readTunables,
  MAX_REINFORCEMENT_HISTORY,
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
 * idempotent within a day), bump `last_reinforced`, and increment the
 * monotonic `reinforcement_total` counter (lifetime durability signal — the
 * FIFO window drops old dates, the counter never does; it does NOT enter the
 * strength formula). Used by the exact-hash dedup path on write, and later by
 * retrieval-feedback / the semantic judge.
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

  db.prepare('UPDATE observations SET reinforcement_dates = ?, last_reinforced = ?, reinforcement_total = COALESCE(reinforcement_total, 0) + 1 WHERE id = ?').run(
    JSON.stringify(next),
    next[next.length - 1],
    id,
  );
  return true;
}

/**
 * Phase 5 — retrieval practice. When the agent actually recalls observations
 * (MCP `get_observations` → /api/observations/batch), the act of retrieval
 * strengthens the memory trace — this is the single most robust finding in
 * memory science (testing effect). Unlike passive surfacing (recordSurfaced,
 * which only bumps a count), active recall appends a real reinforcement date.
 * Same-day idempotent via appendReinforcement, so a chatty agent cannot inflate
 * a note by re-fetching it within one day.
 *
 * Returns how many rows were changed (missing rows and same-day no-ops don't).
 */
export function recordRetrieved(db: Database, ids: number[], today: Date = new Date()): number {
  let changed = 0;
  for (const id of ids) {
    if (reinforceObservation(db, id, today)) changed++;
  }
  return changed;
}

/**
 * Phase 6 — reconsolidation. Human memory is rewritten on every recall; here a
 * new observation that CONTRADICTS an existing one (dedup judge verdict
 * FLAG_CONFLICT) supersedes it:
 *   - the old row is marked `superseded_by = newId` — it drops out of context
 *     injection and dedup candidacy, but stays in the DB (searchable history,
 *     right-to-audit; nothing is deleted);
 *   - the older half of the old row's reinforcement dates is transferred to the
 *     new row, so the corrected fact inherits part of the trace's strength
 *     instead of starting cold.
 *
 * No-op (returns false) when either row is missing or the old row is already
 * superseded — the first supersession wins, no chains.
 */
export function supersedeObservation(db: Database, oldId: number, newId: number): boolean {
  const rows = db
    .prepare('SELECT id, reinforcement_dates, superseded_by FROM observations WHERE id IN (?, ?)')
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

  db.prepare('UPDATE observations SET reinforcement_dates = ?, last_reinforced = ? WHERE id = ?').run(
    JSON.stringify(trimmed),
    trimmed[trimmed.length - 1] ?? null,
    newId,
  );
  db.prepare('UPDATE observations SET superseded_by = ? WHERE id = ?').run(newId, oldId);
  return true;
}

/**
 * Phase 4 — record that observations were surfaced to the agent during context
 * injection. Bumps relevance_count, which feeds back into ranking as a small
 * β·log1p(count) self-reinforcement of notes that keep proving useful enough to
 * surface. Pure count signal — does NOT touch reinforcement_dates (surfacing is
 * not the same as the world re-confirming the fact). No-op on empty input.
 *
 * Also stamps last_surfaced (v55, memory grounding Layer 2): the freshness of
 * this stamp is echo condition 2 — a near-duplicate observation written shortly
 * after A surfaced is likely the agent retelling its own memory, not the world
 * re-confirming it (see detectEcho in ./dedup.ts).
 */
export function recordSurfaced(db: Database, ids: number[], today: Date = new Date()): void {
  if (ids.length === 0) return;
  const placeholders = ids.map(() => '?').join(',');
  db.prepare(
    `UPDATE observations SET relevance_count = COALESCE(relevance_count, 0) + 1, last_surfaced = ? WHERE id IN (${placeholders})`,
  ).run(isoDay(today), ...ids);
}

/** Current ACT-R strength of one observation (0 if no history / missing). */
export function observationStrength(db: Database, id: number, today: Date = new Date()): number {
  const row = db
    .prepare('SELECT reinforcement_dates FROM observations WHERE id = ?')
    .get(id) as { reinforcement_dates: string | null } | undefined;
  if (!row) return 0;
  return effectiveStrength(parseReinforcementDates(row.reinforcement_dates), today, readTunables().powerD);
}
