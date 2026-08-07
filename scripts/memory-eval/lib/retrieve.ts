// SPDX-License-Identifier: Apache-2.0

/**
 * Retrieval for the eval harness.
 *
 * FTS path mirrors SessionSearch.searchObservations (observations_fts MATCH,
 * project filter, superseded rows excluded) but runs on a READONLY connection —
 * SessionSearch's constructor probes/creates FTS tables, which is a write, so
 * it cannot be used against the production DB directly. Same SQL semantics.
 *
 * Ranking reuses rankByStrength from src/services/reinforcement/rank.ts for
 * BOTH rankers: recency-only is rankByStrength with ALPHA=0/BETA=0 (the
 * upstream behaviour), ACT-R is rankByStrength with the configured tunables.
 */

import type { Database } from 'bun:sqlite';
import { rankByStrength } from '../../../src/services/reinforcement/rank.js';
import { readTunables, DEFAULT_TUNABLES, type ReinforcementTunables } from '../../../src/services/reinforcement/strength.js';

export interface PoolRow {
  id: number;
  created_at_epoch: number;
  reinforcement_dates: string | null;
  relevance_count: number | null;
  title: string | null;
  narrative: string | null;
  facts: string | null;
}

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'you', 'your', 'are', 'was', 'were',
  'have', 'has', 'not', 'but', 'all', 'can', 'from', 'they', 'them', 'what', 'when',
  'how', 'why', 'please', 'мне', 'что', 'как', 'для', 'это', 'все', 'почему', 'когда',
]);

const MAX_TERMS = 12;

/**
 * Turn a natural-language prompt into an FTS5 OR query of significant terms.
 * Returns null when nothing usable remains (caller treats as empty pool).
 * Exported for tests.
 */
export function toFtsQuery(text: string): string | null {
  const words = text.toLowerCase().match(/[a-zа-я0-9_]{3,}/g) ?? [];
  const terms: string[] = [];
  for (const w of words) {
    if (STOPWORDS.has(w) || terms.includes(w)) continue;
    terms.push(w);
    if (terms.length >= MAX_TERMS) break;
  }
  if (terms.length === 0) return null;
  return terms.map(t => `"${t.replace(/"/g, '""')}"`).join(' OR ');
}

/** FTS-only retrieval: top `limit` observations for the prompt within the project. */
export function ftsPool(db: Database, promptText: string, project: string, limit: number): PoolRow[] {
  const match = toFtsQuery(promptText);
  if (!match) return [];
  try {
    return db.prepare(`
      SELECT o.id, o.created_at_epoch, o.reinforcement_dates, o.relevance_count,
             o.title, o.narrative, o.facts
      FROM observations o
      JOIN observations_fts ON observations_fts.rowid = o.id
      WHERE observations_fts MATCH ?
        AND (o.project = ? OR o.merged_into_project = ?)
        AND o.superseded_by IS NULL
      ORDER BY observations_fts.rank ASC
      LIMIT ?
    `).all(match, project, project, limit) as PoolRow[];
  } catch {
    return []; // FTS table missing or query unparseable — treated as empty pool
  }
}

/**
 * Hybrid retrieval (FTS ∪ vector). Chroma on this machine is partially
 * disabled, so this is fail-soft: any Chroma error/timeout falls back to the
 * FTS pool and the caller's notes record `usedChroma: false`.
 */
export async function hybridPool(
  db: Database,
  promptText: string,
  project: string,
  limit: number,
  notes: string[],
): Promise<PoolRow[]> {
  const fts = ftsPool(db, promptText, project, limit);
  try {
    const { ChromaSync } = await import('../../../src/services/sync/ChromaSync.js');
    const chroma = new ChromaSync(project);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const res = await Promise.race([
      chroma.queryChroma(promptText, limit),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('chroma query timed out (8s)')), 8000);
        if (typeof timer.unref === 'function') timer.unref();
      }),
    ]);
    if (timer) clearTimeout(timer);
    const chromaIds = (res.ids ?? []).map(Number).filter(Number.isFinite);
    if (chromaIds.length === 0) {
      notes.push('hybrid: Chroma returned 0 ids — FTS pool used');
      return fts;
    }
    const placeholders = chromaIds.map(() => '?').join(',');
    const rows = db.prepare(`
      SELECT o.id, o.created_at_epoch, o.reinforcement_dates, o.relevance_count,
             o.title, o.narrative, o.facts
      FROM observations o
      WHERE o.id IN (${placeholders})
        AND (o.project = ? OR o.merged_into_project = ?)
        AND o.superseded_by IS NULL
    `).all(...chromaIds, project, project) as PoolRow[];
    const byId = new Map(rows.map(r => [r.id, r]));
    const merged: PoolRow[] = [];
    for (const id of chromaIds) {
      const row = byId.get(id);
      if (row) merged.push(row);
    }
    for (const row of fts) {
      if (!byId.has(row.id)) merged.push(row);
    }
    return merged.slice(0, limit);
  } catch (error) {
    notes.push(`hybrid: Chroma unavailable (${error instanceof Error ? error.message : String(error)}) — fell back to FTS`);
    return fts;
  }
}

/** No-retrieval recent block (rule 1 full-context proxy / rule 5 saturation). */
export function recentBlockIds(db: Database, project: string, limit: number): number[] {
  const rows = db.prepare(`
    SELECT o.id FROM observations o
    WHERE (o.project = ? OR o.merged_into_project = ?)
      AND o.superseded_by IS NULL
    ORDER BY o.created_at_epoch DESC
    LIMIT ?
  `).all(project, project, limit) as Array<{ id: number }>;
  return rows.map(r => r.id);
}

export type RankerName = 'recency' | 'actr';

/**
 * Rank the pool with rankByStrength. `recency` = ALPHA/BETA zeroed (upstream
 * behaviour: score collapses to ln(1 + age^-d), monotonic in recency);
 * `actr` = configured tunables with an optional powerD override.
 */
export function rankPool(pool: PoolRow[], ranker: RankerName, k: number, powerD?: number, today: Date = new Date()): PoolRow[] {
  const base = readTunables();
  const tunables: ReinforcementTunables = ranker === 'recency'
    ? { ...DEFAULT_TUNABLES, alpha: 0, beta: 0 }
    : { ...base, powerD: powerD ?? base.powerD };
  return rankByStrength(pool, k, today, tunables);
}
