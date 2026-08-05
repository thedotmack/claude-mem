// SPDX-License-Identifier: Apache-2.0

/**
 * Groundedness metric (memory grounding, Layer 3 — see
 * plans/2026-08-05-memory-grounding.md). Answers one question: how much of the
 * active memory rests on observable tool evidence vs. on the agent's own say-so
 * (and, after Layer 2 ships, how much of it is known echo — memory retelling
 * itself).
 *
 * Pure computation over a Database handle: the harness opens the production DB
 * READONLY, tests pass an in-memory store. Missing columns/tables (pre-v53
 * semantic_facts, pre-v55 echo_of) degrade to "not available" instead of
 * throwing, so a baseline can be measured before the migrations land.
 */

import type { Database } from 'bun:sqlite';

export interface GroundednessObservations {
  /** Active = not superseded (and not echo-flagged, once v55 exists). */
  active: number;
  /** Non-empty files_read or files_modified — the v1 tool-evidence proxy. */
  withToolEvidence: number;
  /** withToolEvidence / active, 0..1 (null when no active observations). */
  pct: number | null;
}

export interface GroundednessFacts {
  /** Active = not superseded and not invalidated. */
  active: number;
  /** Facts with at least one source observation recorded. */
  withSources: number;
  /** Facts with no source observations (excluded from the pct denominator). */
  sourceless: number;
  /** Facts whose ALL source observations carry tool evidence. */
  allSourcesGrounded: number;
  /** allSourcesGrounded / withSources, 0..1 (null when no sourced facts). */
  pct: number | null;
}

export interface GroundednessEchoMonth {
  month: string; // YYYY-MM
  observations: number;
  echoes: number;
  /** echoes / observations, 0..1. */
  pct: number;
}

export interface GroundednessEcho {
  /** False on pre-v55 schemas (no echo_of column) — nothing has been flagged yet. */
  available: boolean;
  total: number;
  byMonth: GroundednessEchoMonth[];
}

export interface GroundednessResult {
  observations: GroundednessObservations;
  facts: GroundednessFacts | null; // null when semantic_facts doesn't exist (pre-v53)
  echo: GroundednessEcho;
}

function hasColumn(db: Database, table: string, column: string): boolean {
  const cols = db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return cols.some(c => c.name === column);
}

function hasTable(db: Database, table: string): boolean {
  const rows = db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").all(table) as Array<{ name: string }>;
  return rows.length > 0;
}

function jsonArrayLength(raw: string | null): number {
  if (!raw) return 0;
  try {
    const value = JSON.parse(raw);
    return Array.isArray(value) ? value.length : 0;
  } catch {
    return 0;
  }
}

/** v1 tool-evidence proxy: the observation names at least one file it read or modified. */
export function hasToolEvidence(filesRead: string | null, filesModified: string | null): boolean {
  return jsonArrayLength(filesRead) + jsonArrayLength(filesModified) > 0;
}

export function computeGroundedness(db: Database): GroundednessResult {
  const echoAvailable = hasColumn(db, 'observations', 'echo_of');

  // --- metric 1: active observations with tool evidence ---
  const obsRows = db.prepare(`
    SELECT files_read, files_modified
    FROM observations
    WHERE superseded_by IS NULL${echoAvailable ? ' AND echo_of IS NULL' : ''}
  `).all() as Array<{ files_read: string | null; files_modified: string | null }>;
  const withToolEvidence = obsRows.filter(r => hasToolEvidence(r.files_read, r.files_modified)).length;
  const observations: GroundednessObservations = {
    active: obsRows.length,
    withToolEvidence,
    pct: obsRows.length > 0 ? withToolEvidence / obsRows.length : null,
  };

  // --- metric 2: active facts whose ALL source observations have tool evidence ---
  let facts: GroundednessFacts | null = null;
  if (hasTable(db, 'semantic_facts')) {
    const factRows = db.prepare(`
      SELECT source_observation_ids
      FROM semantic_facts
      WHERE superseded_by IS NULL AND invalidated_at IS NULL
    `).all() as Array<{ source_observation_ids: string | null }>;
    const sourceStmt = db.prepare('SELECT files_read, files_modified FROM observations WHERE id = ?');
    let withSources = 0;
    let sourceless = 0;
    let allSourcesGrounded = 0;
    for (const fact of factRows) {
      let ids: number[] = [];
      try {
        const parsed = JSON.parse(fact.source_observation_ids ?? '[]');
        if (Array.isArray(parsed)) ids = parsed.filter(x => Number.isInteger(x));
      } catch { /* unparseable provenance → treat as sourceless */ }
      if (ids.length === 0) {
        sourceless++;
        continue;
      }
      withSources++;
      // A missing source row (erased/retention) counts as ungrounded: the fact
      // can no longer show its evidence.
      const allGrounded = ids.every(id => {
        const row = sourceStmt.get(id) as { files_read: string | null; files_modified: string | null } | undefined;
        return row != null && hasToolEvidence(row.files_read, row.files_modified);
      });
      if (allGrounded) allSourcesGrounded++;
    }
    facts = {
      active: factRows.length,
      withSources,
      sourceless,
      allSourcesGrounded,
      pct: withSources > 0 ? allSourcesGrounded / withSources : null,
    };
  }

  // --- metric 3: echo-flagged share over time (post-v55 only) ---
  const echo: GroundednessEcho = { available: echoAvailable, total: 0, byMonth: [] };
  if (echoAvailable) {
    const rows = db.prepare(`
      SELECT substr(created_at, 1, 7) AS month,
             COUNT(*) AS observations,
             SUM(CASE WHEN echo_of IS NOT NULL THEN 1 ELSE 0 END) AS echoes
      FROM observations
      GROUP BY month
      ORDER BY month
    `).all() as Array<{ month: string; observations: number; echoes: number }>;
    echo.byMonth = rows.map(r => ({
      month: r.month,
      observations: r.observations,
      echoes: r.echoes,
      pct: r.observations > 0 ? r.echoes / r.observations : 0,
    }));
    echo.total = rows.reduce((a, r) => a + r.echoes, 0);
  }

  return { observations, facts, echo };
}
