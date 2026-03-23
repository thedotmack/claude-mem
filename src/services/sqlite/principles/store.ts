/**
 * Principles Store
 * CRUD operations for extracted principles (user-confirmed rules).
 * Principles are high-level behavioral rules extracted from repeated corrections
 * or auto-extracted from session summaries.
 */

import { Database } from 'bun:sqlite';
import { logger } from '../../../utils/logger.js';

export interface PrincipleRecord {
  id: number;
  rule: string;
  source: string;
  confidence: number;
  frequency: number;
  status: string;
  category: string;
  created_at: string;
  updated_at: string;
}

/**
 * Store or upsert a principle.
 * If a principle with the same rule already exists, increment its frequency instead.
 * Returns the principle id.
 */
export function storePrinciple(
  db: Database,
  rule: string,
  source: string = 'correction',
  confidence: number = 0.5,
  category: string = 'general'
): number {
  // Check if principle with same rule already exists
  const existing = db.prepare(
    `SELECT id, frequency FROM principles WHERE rule = ?`
  ).get(rule) as { id: number; frequency: number } | null;

  if (existing) {
    // Upsert: increment frequency and update timestamp
    db.prepare(
      `UPDATE principles SET frequency = frequency + 1, updated_at = datetime('now') WHERE id = ?`
    ).run(existing.id);
    logger.debug('PRINCIPLES', `Incremented principle frequency | id=${existing.id} | newFreq=${existing.frequency + 1}`);
    return existing.id;
  }

  const stmt = db.prepare(`
    INSERT INTO principles (rule, source, confidence, category)
    VALUES (?, ?, ?, ?)
  `);
  const result = stmt.run(rule, source, confidence, category);
  logger.debug('PRINCIPLES', `Stored new principle id=${result.lastInsertRowid}`, { source, category });
  return Number(result.lastInsertRowid);
}

/**
 * Get principles filtered by status
 */
export function getPrinciples(
  db: Database,
  status?: string,
  limit: number = 50
): PrincipleRecord[] {
  if (status) {
    return db.prepare(
      `SELECT * FROM principles WHERE status = ? ORDER BY updated_at DESC LIMIT ?`
    ).all(status, limit) as PrincipleRecord[];
  }
  return db.prepare(
    `SELECT * FROM principles ORDER BY updated_at DESC LIMIT ?`
  ).all(limit) as PrincipleRecord[];
}

/**
 * Get active principles (confirmed + promoted) for context injection.
 * Ordered by confidence * frequency descending for relevance.
 */
export function getActivePrinciples(
  db: Database,
  limit: number = 5
): PrincipleRecord[] {
  return db.prepare(
    `SELECT * FROM principles WHERE status IN ('confirmed', 'promoted')
     ORDER BY (confidence * frequency) DESC LIMIT ?`
  ).all(limit) as PrincipleRecord[];
}

/**
 * Update a principle's status
 */
export function updatePrincipleStatus(
  db: Database,
  id: number,
  newStatus: string
): void {
  db.prepare(
    `UPDATE principles SET status = ?, updated_at = datetime('now') WHERE id = ?`
  ).run(newStatus, id);
  logger.debug('PRINCIPLES', `Updated principle status | id=${id} | status=${newStatus}`);
}

/**
 * Increment frequency for a principle
 */
export function incrementFrequency(
  db: Database,
  id: number
): void {
  db.prepare(
    `UPDATE principles SET frequency = frequency + 1, updated_at = datetime('now') WHERE id = ?`
  ).run(id);
}

/**
 * Delete a principle by id
 */
export function deletePrinciple(
  db: Database,
  id: number
): void {
  db.prepare(`DELETE FROM principles WHERE id = ?`).run(id);
  logger.debug('PRINCIPLES', `Deleted principle id=${id}`);
}
