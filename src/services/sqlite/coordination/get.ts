/**
 * Coordination Get — Read operations
 *
 * Handles querying active claims, checking file conflicts,
 * and retrieving discoveries.
 */

import { Database } from 'bun:sqlite';
import { cleanupExpiredClaims } from './store.js';
import type {
  ClaimRecord,
  CheckConflictsResult,
  DiscoveryRecord,
  DiscoveryQuery,
  FileConflictCheck,
} from './types.js';

/**
 * Check for active claims on a set of files. Runs cleanup first.
 * Optionally excludes a specific agent's claims from results.
 */
export function checkConflicts(
  db: Database,
  files: string[],
  excludeAgentId?: string
): CheckConflictsResult {
  // Clean up expired claims before checking
  cleanupExpiredClaims(db);

  const now = Date.now();
  const conflicts: FileConflictCheck[] = [];

  for (const filePath of files) {
    let claims: ClaimRecord[];

    if (excludeAgentId) {
      claims = db.prepare(`
        SELECT * FROM agent_coordination_claims
        WHERE file_path = ?
          AND agent_id != ?
          AND released_at_epoch IS NULL
          AND expires_at_epoch > ?
        ORDER BY claimed_at_epoch DESC
      `).all(filePath, excludeAgentId, now) as ClaimRecord[];
    } else {
      claims = db.prepare(`
        SELECT * FROM agent_coordination_claims
        WHERE file_path = ?
          AND released_at_epoch IS NULL
          AND expires_at_epoch > ?
        ORDER BY claimed_at_epoch DESC
      `).all(filePath, now) as ClaimRecord[];
    }

    conflicts.push({
      file_path: filePath,
      has_conflict: claims.length > 0,
      claims,
    });
  }

  return { conflicts };
}

/**
 * Get all active (non-expired, non-released) claims, optionally filtered by agent.
 */
export function getActiveClaims(
  db: Database,
  agentId?: string
): ClaimRecord[] {
  const now = Date.now();

  if (agentId) {
    return db.prepare(`
      SELECT * FROM agent_coordination_claims
      WHERE agent_id = ?
        AND released_at_epoch IS NULL
        AND expires_at_epoch > ?
      ORDER BY claimed_at_epoch DESC
    `).all(agentId, now) as ClaimRecord[];
  }

  return db.prepare(`
    SELECT * FROM agent_coordination_claims
    WHERE released_at_epoch IS NULL
      AND expires_at_epoch > ?
    ORDER BY claimed_at_epoch DESC
  `).all(now) as ClaimRecord[];
}

/**
 * Get discoveries with optional filters.
 */
export function getDiscoveries(
  db: Database,
  query: DiscoveryQuery = {}
): DiscoveryRecord[] {
  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (query.session_id) {
    conditions.push('session_id = ?');
    params.push(query.session_id);
  }

  if (query.agent_id) {
    conditions.push('agent_id = ?');
    params.push(query.agent_id);
  }

  if (query.affected_file) {
    // Use json_each to search within the JSON array of affected files
    conditions.push(`EXISTS (
      SELECT 1 FROM json_each(affected_files) WHERE json_each.value = ?
    )`);
    params.push(query.affected_file);
  }

  if (query.since_epoch) {
    conditions.push('created_at_epoch > ?');
    params.push(query.since_epoch);
  }

  const whereClause = conditions.length > 0
    ? `WHERE ${conditions.join(' AND ')}`
    : '';

  const limit = query.limit ?? 50;

  return db.prepare(`
    SELECT * FROM agent_coordination_discoveries
    ${whereClause}
    ORDER BY created_at_epoch DESC
    LIMIT ?
  `).all(...params, limit) as DiscoveryRecord[];
}
