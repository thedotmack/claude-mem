/**
 * Coordination Store — Write operations
 *
 * Handles claiming files, releasing claims, recording discoveries,
 * resolving conflicts, and cleaning up expired claims.
 */

import { Database } from 'bun:sqlite';
import { logger } from '../../../utils/logger.js';
import type {
  ClaimInput,
  ClaimResult,
  ClaimRecord,
  ConflictRecord,
  DiscoveryInput,
  ReleaseResult,
} from './types.js';

/**
 * Claim files for an agent. Auto-releases existing active claims by the same agent
 * on the same files before inserting. Detects conflicts with other agents' write claims.
 *
 * Wraps everything in a single transaction for atomicity.
 */
export function claimFiles(db: Database, input: ClaimInput): ClaimResult {
  const now = Date.now();
  const expiresAt = now + input.ttl_minutes * 60 * 1000;
  const claimIds: number[] = [];
  const conflicts: ConflictRecord[] = [];

  const transaction = db.transaction(() => {
    for (const filePath of input.files) {
      // Auto-release existing active claims by this agent on this file
      db.prepare(`
        UPDATE agent_coordination_claims
        SET released_at_epoch = ?
        WHERE agent_id = ? AND file_path = ? AND released_at_epoch IS NULL
      `).run(now, input.agent_id, filePath);

      // Insert new claim
      const result = db.prepare(`
        INSERT INTO agent_coordination_claims
          (agent_id, agent_name, file_path, scope, intent, session_id, claimed_at_epoch, expires_at_epoch)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.agent_id,
        input.agent_name,
        filePath,
        input.scope,
        input.intent ?? null,
        input.session_id ?? null,
        now,
        expiresAt
      );

      const claimId = Number(result.lastInsertRowid);
      claimIds.push(claimId);

      // Detect conflicts: look for overlapping active claims from other agents
      if (input.scope === 'write') {
        // Write claims conflict with any other agent's write claims on same file
        const overlapping = db.prepare(`
          SELECT * FROM agent_coordination_claims
          WHERE file_path = ?
            AND agent_id != ?
            AND scope = 'write'
            AND released_at_epoch IS NULL
            AND expires_at_epoch > ?
        `).all(filePath, input.agent_id, now) as ClaimRecord[];

        for (const other of overlapping) {
          const conflictResult = db.prepare(`
            INSERT INTO agent_coordination_conflicts
              (claim_a_id, claim_b_id, agent_a_id, agent_b_id, conflict_type, files, description, session_id, created_at_epoch)
            VALUES (?, ?, ?, ?, 'write_write', ?, ?, ?, ?)
          `).run(
            claimId,
            other.id,
            input.agent_id,
            other.agent_id,
            JSON.stringify([filePath]),
            `Write conflict on ${filePath} between ${input.agent_name} and ${other.agent_name}`,
            input.session_id ?? null,
            now
          );

          conflicts.push({
            id: Number(conflictResult.lastInsertRowid),
            claim_a_id: claimId,
            claim_b_id: other.id,
            agent_a_id: input.agent_id,
            agent_b_id: other.agent_id,
            conflict_type: 'write_write',
            files: JSON.stringify([filePath]),
            description: `Write conflict on ${filePath} between ${input.agent_name} and ${other.agent_name}`,
            resolution: 'unresolved',
            resolved_at_epoch: null,
            session_id: input.session_id ?? null,
            created_at_epoch: now,
          });
        }
      }
    }
  });

  transaction();

  if (conflicts.length > 0) {
    logger.warn('COORDINATION', `${conflicts.length} conflict(s) detected during claim`, {
      agent: input.agent_name,
      files: input.files.join(', '),
    });
  }

  return { claim_ids: claimIds, conflicts };
}

/**
 * Release active claims for an agent on specific files.
 */
export function releaseFiles(db: Database, agentId: string, files: string[]): ReleaseResult {
  const now = Date.now();
  let releasedCount = 0;

  const transaction = db.transaction(() => {
    for (const filePath of files) {
      const result = db.prepare(`
        UPDATE agent_coordination_claims
        SET released_at_epoch = ?
        WHERE agent_id = ? AND file_path = ? AND released_at_epoch IS NULL
      `).run(now, agentId, filePath);

      releasedCount += result.changes;
    }
  });

  transaction();

  return { released_count: releasedCount };
}

/**
 * Record a discovery from an agent for cross-agent awareness.
 */
export function recordDiscovery(db: Database, input: DiscoveryInput): number {
  const now = Date.now();

  const result = db.prepare(`
    INSERT INTO agent_coordination_discoveries
      (agent_id, agent_name, discovery_type, content, affected_files, severity, session_id, created_at_epoch)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.agent_id,
    input.agent_name,
    input.discovery_type,
    input.content,
    input.affected_files ? JSON.stringify(input.affected_files) : null,
    input.severity ?? 'info',
    input.session_id ?? null,
    now
  );

  return Number(result.lastInsertRowid);
}

/**
 * Resolve a conflict with a given resolution strategy.
 */
export function resolveConflict(
  db: Database,
  conflictId: number,
  resolution: string
): boolean {
  const now = Date.now();

  const result = db.prepare(`
    UPDATE agent_coordination_conflicts
    SET resolution = ?, resolved_at_epoch = ?
    WHERE id = ? AND resolution = 'unresolved'
  `).run(resolution, now, conflictId);

  return result.changes > 0;
}

/**
 * Clean up expired claims (set released_at_epoch for claims past their TTL).
 */
export function cleanupExpiredClaims(db: Database): number {
  const now = Date.now();

  const result = db.prepare(`
    UPDATE agent_coordination_claims
    SET released_at_epoch = ?
    WHERE released_at_epoch IS NULL AND expires_at_epoch < ?
  `).run(now, now);

  if (result.changes > 0) {
    logger.debug('COORDINATION', `Cleaned up ${result.changes} expired claim(s)`);
  }

  return result.changes;
}
