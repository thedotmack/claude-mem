// SPDX-License-Identifier: Apache-2.0

import type { Database } from 'bun:sqlite';
import { logger } from '../../utils/logger.js';

/**
 * Erasure cascade (memory-review audit G5).
 *
 * Invalidation and hard deletion are DIFFERENT operations and both are
 * required: a superseded/invalidated row is kept for audit and prior-belief
 * queries, but a genuine erasure request must remove the rows tombstoned BY
 * the deleted one too — otherwise the "erased" content survives in the DB as
 * a marked row.
 *
 * Supersede chains exist (A superseded_by B, B superseded_by C — the first
 * supersession wins per row, but a successor can itself be superseded
 * later), so the cascade is recursive over reverse `superseded_by` edges.
 * FTS cleanup is automatic via the observations_ad / semantic_facts_ad
 * triggers.
 */

export interface ErasureResult {
  /** All physically deleted ids, parent first. Empty when the parent is gone. */
  deletedIds: number[];
  /** How many of those were tombstones (deletedIds.length - 1). */
  cascaded: number;
}

/**
 * The full erasure chain for one observation: the row itself plus every row
 * recursively tombstoned by it. Local-origin rows only (`origin_device_id
 * IS NULL`) — replica rows belong to another device's lineage and are erased
 * through sync, mirroring the DELETE /api/observation/:id contract. Returns
 * [] when the parent is missing or not local-origin.
 */
export function observationErasureChain(db: Database, id: number): number[] {
  const rows = db.prepare(`
    WITH RECURSIVE doomed(id) AS (
      SELECT o.id FROM observations o
      WHERE o.id = ? AND o.origin_device_id IS NULL
      UNION
      SELECT o.id FROM observations o
      JOIN doomed d ON o.superseded_by = d.id
      WHERE o.origin_device_id IS NULL
    )
    SELECT id FROM doomed
  `).all(id) as Array<{ id: number }>;
  return rows.map(r => r.id);
}

/** Same chain for semantic_facts (no sync-origin columns on that table). */
export function factErasureChain(db: Database, id: number): number[] {
  const rows = db.prepare(`
    WITH RECURSIVE doomed(id) AS (
      SELECT f.id FROM semantic_facts f WHERE f.id = ?
      UNION
      SELECT f.id FROM semantic_facts f
      JOIN doomed d ON f.superseded_by = d.id
    )
    SELECT id FROM doomed
  `).all(id) as Array<{ id: number }>;
  return rows.map(r => r.id);
}

function deleteIds(db: Database, table: 'observations' | 'semantic_facts', ids: number[]): void {
  const placeholders = ids.map(() => '?').join(',');
  db.prepare(`DELETE FROM ${table} WHERE id IN (${placeholders})`).run(...ids);
}

/**
 * Hard-delete an observation AND every tombstone in its supersede chain,
 * in one transaction. Returns the deleted ids (parent first) so the caller
 * can tombstone Chroma / report the cascade.
 */
export function eraseObservationCascade(db: Database, id: number): ErasureResult {
  const chain = observationErasureChain(db, id);
  if (chain.length === 0) return { deletedIds: [], cascaded: 0 };

  const tx = db.transaction(() => deleteIds(db, 'observations', chain));
  tx();

  const cascaded = chain.length - 1;
  if (cascaded > 0) {
    logger.info('ERASURE', `Erasure of observation #${id} cascaded to ${cascaded} tombstone(s)`, {
      deletedIds: chain,
    });
  }
  return { deletedIds: chain, cascaded };
}

/**
 * Hard-delete a semantic fact AND its supersede chain. Facts tombstoned via
 * `invalidated_at` carry no pointer to their deleter, so they are out of
 * cascade scope by construction.
 */
export function eraseFactCascade(db: Database, id: number): ErasureResult {
  const chain = factErasureChain(db, id);
  if (chain.length === 0) return { deletedIds: [], cascaded: 0 };

  const tx = db.transaction(() => deleteIds(db, 'semantic_facts', chain));
  tx();

  const cascaded = chain.length - 1;
  if (cascaded > 0) {
    logger.info('ERASURE', `Erasure of fact #${id} cascaded to ${cascaded} tombstone(s)`, {
      deletedIds: chain,
    });
  }
  return { deletedIds: chain, cascaded };
}
