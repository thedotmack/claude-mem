/**
 * Corrections Store
 * CRUD operations for user correction records.
 * Corrections capture when a user corrects Claude's behavior.
 */

import { Database } from 'bun:sqlite';
import { logger } from '../../../utils/logger.js';

export interface CorrectionRecord {
  id: number;
  session_id: string;
  user_message: string;
  detected_pattern: string | null;
  category: string;
  created_at: string;
  promoted_to_principle_id: number | null;
}

/**
 * Store a user correction in the database
 */
export function storeCorrection(
  db: Database,
  sessionId: string,
  userMessage: string,
  detectedPattern: string | null,
  category: string = 'general'
): number {
  const stmt = db.prepare(`
    INSERT INTO corrections (session_id, user_message, detected_pattern, category)
    VALUES (?, ?, ?, ?)
  `);
  const result = stmt.run(sessionId, userMessage, detectedPattern, category);
  logger.debug('PRINCIPLES', `Stored correction id=${result.lastInsertRowid}`, { sessionId, category });
  return Number(result.lastInsertRowid);
}

/**
 * Get corrections grouped by detected_pattern, with count
 */
export function getCorrectionsByPattern(
  db: Database,
  pattern: string
): { count: number; corrections: CorrectionRecord[] } {
  const rows = db.prepare(
    `SELECT * FROM corrections WHERE detected_pattern = ? ORDER BY created_at DESC`
  ).all(pattern) as CorrectionRecord[];
  return { count: rows.length, corrections: rows };
}

/**
 * Get count of unpromoted corrections for a given pattern
 */
export function getUnpromotedCountByPattern(
  db: Database,
  pattern: string
): number {
  const row = db.prepare(
    `SELECT COUNT(*) as cnt FROM corrections WHERE detected_pattern = ? AND promoted_to_principle_id IS NULL`
  ).get(pattern) as { cnt: number };
  return row.cnt;
}

/**
 * Mark corrections as promoted to a principle
 */
export function markPromoted(
  db: Database,
  pattern: string,
  principleId: number
): void {
  db.prepare(
    `UPDATE corrections SET promoted_to_principle_id = ? WHERE detected_pattern = ? AND promoted_to_principle_id IS NULL`
  ).run(principleId, pattern);
  logger.debug('PRINCIPLES', `Marked corrections promoted | pattern=${pattern} | principleId=${principleId}`);
}

/**
 * Get recent unpromoted corrections for batch review
 */
export function getRecentUnpromotedCorrections(
  db: Database,
  limit: number = 50
): Array<{ id: number; user_message: string; detected_pattern: string | null; category: string }> {
  return db.prepare(
    `SELECT id, user_message, detected_pattern, category
     FROM corrections
     WHERE promoted_to_principle_id IS NULL
     ORDER BY created_at DESC
     LIMIT ?`
  ).all(limit) as Array<{ id: number; user_message: string; detected_pattern: string | null; category: string }>;
}
