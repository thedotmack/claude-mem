/**
 * AccessTracker: Track memory access patterns for intelligent forgetting
 *
 * Responsibility:
 * - Record when memories (observations) are accessed/retrieved
 * - Maintain access history for importance scoring
 * - Provide access frequency metrics
 */

import { Database } from 'bun:sqlite';
import { logger } from '../../utils/logger.js';

/**
 * Memory access record
 */
export interface MemoryAccess {
  memoryId: number;
  timestamp: number;
  context?: string;
}

/**
 * Access statistics for a memory
 */
export interface AccessStats {
  memoryId: number;
  accessCount: number;
  lastAccessed: number | null;
  accessFrequency: number; // accesses per day (last 30 days)
}

/**
 * Tracks and retrieves memory access patterns
 */
export class AccessTracker {
  constructor(private db: Database) {}

  /**
   * Record a memory access event
   * @param memoryId The observation ID being accessed
   * @param context Optional context (e.g., query string, session info)
   */
  async recordAccess(memoryId: number, context?: string): Promise<void> {
    try {
      const now = Date.now();

      // IMPROVEMENT: Wrap both writes in a transaction for atomicity
      // This matches the pattern used in recordAccessBatch
      this.db.run('BEGIN TRANSACTION');

      try {
        // Insert into memory_access table
        this.db.prepare(`
          INSERT INTO memory_access (memory_id, timestamp, context)
          VALUES (?, ?, ?)
        `).run(memoryId, now, context || null);

        // Update observations table for quick access
        this.db.prepare(`
          UPDATE observations
          SET access_count = COALESCE(access_count, 0) + 1,
              last_accessed = ?
          WHERE id = ?
        `).run(now, memoryId);

        this.db.run('COMMIT');

        logger.debug('AccessTracker', `Recorded access for memory ${memoryId}`);
      } catch (error) {
        this.db.run('ROLLBACK');
        throw error;
      }
    } catch (error: unknown) {
      logger.error('AccessTracker', `Failed to record access for memory ${memoryId}`, {}, error instanceof Error ? error : new Error(String(error)));
    }
  }

  /**
   * Record multiple memory accesses in a single transaction
   * Useful for batch retrieval operations
   */
  async recordAccessBatch(memoryIds: number[], context?: string): Promise<void> {
    if (memoryIds.length === 0) return;

    try {
      const now = Date.now();

      this.db.run('BEGIN TRANSACTION');

      try {
        const insertStmt = this.db.prepare(`
          INSERT INTO memory_access (memory_id, timestamp, context)
          VALUES (?, ?, ?)
        `);

        const updateStmt = this.db.prepare(`
          UPDATE observations
          SET access_count = COALESCE(access_count, 0) + 1,
              last_accessed = ?
          WHERE id = ?
        `);

        for (const memoryId of memoryIds) {
          insertStmt.run(memoryId, now, context || null);
          updateStmt.run(now, memoryId);
        }

        this.db.run('COMMIT');
        logger.debug('AccessTracker', `Recorded batch access for ${memoryIds.length} memories`);
      } catch (error) {
        this.db.run('ROLLBACK');
        throw error;
      }
    } catch (error: any) {
      logger.error('AccessTracker', 'Failed to record batch access', {}, error);
    }
  }

  /**
   * Get access history for a specific memory
   * @param memoryId The observation ID
   * @param limit Maximum number of records to return
   */
  getAccessHistory(memoryId: number, limit: number = 100): MemoryAccess[] {
    try {
      const stmt = this.db.prepare(`
        SELECT memory_id as memoryId, timestamp, context
        FROM memory_access
        WHERE memory_id = ?
        ORDER BY timestamp DESC
        LIMIT ?
      `);

      return stmt.all(memoryId, limit) as MemoryAccess[];
    } catch (error: any) {
      logger.error('AccessTracker', `Failed to get access history for memory ${memoryId}`, {}, error);
      return [];
    }
  }

  /**
   * Get access frequency for a memory (accesses per day in last N days)
   * @param memoryId The observation ID
   * @param days Number of days to look back (default: 30)
   */
  getAccessFrequency(memoryId: number, days: number = 30): number {
    try {
      const cutoffTime = Date.now() - (days * 24 * 60 * 60 * 1000);

      const stmt = this.db.prepare(`
        SELECT COUNT(*) as count
        FROM memory_access
        WHERE memory_id = ? AND timestamp >= ?
      `);

      const result = stmt.get(memoryId, cutoffTime) as { count: number };
      return result.count / days; // accesses per day
    } catch (error: any) {
      logger.error('AccessTracker', `Failed to get access frequency for memory ${memoryId}`, {}, error);
      return 0;
    }
  }

  /**
   * Get comprehensive access statistics for a memory
   */
  getAccessStats(memoryId: number, days: number = 30): AccessStats | null {
    try {
      const stmt = this.db.prepare(`
        SELECT
          o.id as memoryId,
          COALESCE(o.access_count, 0) as accessCount,
          o.last_accessed as lastAccessed
        FROM observations o
        WHERE o.id = ?
      `);

      const result = stmt.get(memoryId) as AccessStats | undefined;
      if (!result) return null;

      // Calculate frequency
      result.accessFrequency = this.getAccessFrequency(memoryId, days);

      return result;
    } catch (error: any) {
      logger.error('AccessTracker', `Failed to get access stats for memory ${memoryId}`, {}, error);
      return null;
    }
  }

  /**
   * Get access statistics for multiple memories
   * OPTIMIZATION: Single query with LEFT JOIN to avoid N+1 problem
   */
  getAccessStatsBatch(memoryIds: number[], days: number = 30): Map<number, AccessStats> {
    const stats = new Map<number, AccessStats>();

    if (memoryIds.length === 0) return stats;

    try {
      const placeholders = memoryIds.map(() => '?').join(',');
      const cutoffTime = Date.now() - (days * 24 * 60 * 60 * 1000);

      // OPTIMIZATION: Single query with LEFT JOIN to get access frequencies in batch
      // This eliminates the N+1 query pattern where we previously called getAccessFrequency() for each memory
      const stmt = this.db.prepare(`
        SELECT
          o.id as memoryId,
          COALESCE(o.access_count, 0) as accessCount,
          o.last_accessed as lastAccessed,
          COALESCE(freq.access_count, 0) / ? as accessFrequency
        FROM observations o
        LEFT JOIN (
          SELECT memory_id, COUNT(*) as access_count
          FROM memory_access
          WHERE memory_id IN (${placeholders})
            AND timestamp >= ?
          GROUP BY memory_id
        ) freq ON o.id = freq.memory_id
        WHERE o.id IN (${placeholders})
      `);

      // Build params: cutoffTime for division, memoryIds for subquery, cutoffTime for subquery, memoryIds for outer query
      const params = [1 / days, ...memoryIds, cutoffTime, ...memoryIds];

      const results = stmt.all(...params) as Array<{
        memoryId: number;
        accessCount: number;
        lastAccessed: number | null;
        accessFrequency: number;
      }>;

      for (const result of results) {
        stats.set(result.memoryId, {
          memoryId: result.memoryId,
          accessCount: result.accessCount,
          lastAccessed: result.lastAccessed,
          accessFrequency: result.accessFrequency,
        });
      }
    } catch (error: unknown) {
      logger.error('AccessTracker', 'Failed to get batch access stats', {}, error instanceof Error ? error : new Error(String(error)));
    }

    return stats;
  }

  /**
   * Cleanup old access records to prevent table bloat
   * @param olderThanDays Remove records older than this many days
   */
  async cleanup(olderThanDays: number = 90): Promise<number> {
    try {
      const cutoffTime = Date.now() - (olderThanDays * 24 * 60 * 60 * 1000);

      const stmt = this.db.prepare(`
        DELETE FROM memory_access
        WHERE timestamp < ?
      `);

      const result = stmt.run(cutoffTime);
      const deletedCount = result.changes;

      if (deletedCount > 0) {
        logger.info('AccessTracker', `Cleaned up ${deletedCount} old access records`);
      }

      return deletedCount;
    } catch (error: any) {
      logger.error('AccessTracker', 'Failed to cleanup old access records', {}, error);
      return 0;
    }
  }
}
