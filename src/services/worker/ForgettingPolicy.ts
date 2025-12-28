/**
 * ForgettingPolicy: Adaptive memory retention decisions
 *
 * Responsibility:
 * - Evaluate whether memories should be retained based on multiple factors
 * - Combine importance scores, access patterns, and age into retention decisions
 * - Provide transparent reasons for retention/forgetting decisions
 *
 * Core concept from Titans: Adaptive weight decay to discard unused information
 */

import { Database } from 'bun:sqlite';
import { logger } from '../../utils/logger.js';
import type { ObservationRecord } from '../../types/database.js';
import { ImportanceScorer } from './ImportanceScorer.js';
import { AccessTracker } from './AccessTracker.js';

/**
 * Retention decision result
 */
export interface RetentionDecision {
  shouldRetain: boolean;
  reason: string;
  confidence: number;        // 0-1, how confident in this decision
  newImportanceScore?: number; // Updated importance score
}

/**
 * Options for retention evaluation
 */
export interface RetentionOptions {
  importanceThreshold?: number;  // Minimum importance to retain (default: 0.2)
  ageThreshold?: number;         // Minimum age in days to consider (default: 90)
  requireRecentAccess?: boolean;  // Require access within N days (default: false)
  recentAccessDays?: number;      // Days for recent access check (default: 180)
}

/**
 * Statistics about memory retention
 */
export interface RetentionStats {
  totalEvaluated: number;
  retained: number;
  forgotten: number;
  avgImportanceRetained: number;
  avgImportanceForgotten: number;
}

/**
 * Configuration for forgetting policy
 */
export interface ForgettingConfig {
  importanceThreshold: number;    // Default: 0.2
  ageThresholdDays: number;       // Default: 90
  enableAccessTracking: boolean;  // Default: true
  accessDecayWeight: number;      // How much access affects score (0-1)
  ageDecayHalfLife: number;       // Days for importance to halve (default: 90)
}

/**
 * Default configuration
 */
const DEFAULT_CONFIG: ForgettingConfig = {
  importanceThreshold: 0.2,
  ageThresholdDays: 90,
  enableAccessTracking: true,
  accessDecayWeight: 0.3,
  ageDecayHalfLife: 90,
};

/**
 * Makes intelligent retention decisions for observations
 *
 * The policy considers:
 * 1. Current importance score (from Phase 1)
 * 2. Access frequency (frequently accessed = keep)
 * 3. Age (older = more likely to forget, unless important)
 * 4. Semantic rarity (unique content = keep)
 */
export class ForgettingPolicy {
  private db: Database;
  private importanceScorer: ImportanceScorer;
  private accessTracker: AccessTracker;
  private config: ForgettingConfig;

  constructor(db: Database, config?: Partial<ForgettingConfig>) {
    this.db = db;  // Store directly instead of accessing via importanceScorer
    this.importanceScorer = new ImportanceScorer(db);
    this.accessTracker = new AccessTracker(db);
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Evaluate whether a memory should be retained
   */
  async evaluate(memoryId: number): Promise<RetentionDecision | null> {
    try {
      // Get the observation
      const stmt = this.db.prepare(`
        SELECT * FROM observations WHERE id = ?
      `);
      const obs = stmt.get(memoryId) as ObservationRecord | undefined;
      if (!obs) return null;

      return await this.evaluateObservation(obs);
    } catch (error: unknown) {
      logger.error('ForgettingPolicy', `Failed to evaluate memory ${memoryId}`, {}, error instanceof Error ? error : new Error(String(error)));
      return null;
    }
  }

  /**
   * Evaluate retention for an observation record
   */
  async evaluateObservation(obs: ObservationRecord, options?: RetentionOptions): Promise<RetentionDecision> {
    const config = { ...this.config, ...options };

    // Calculate age in days
    const ageDays = (Date.now() - obs.created_at_epoch) / (24 * 60 * 60 * 1000);

    // Skip if too young
    if (ageDays < config.ageThresholdDays) {
      return {
        shouldRetain: true,
        reason: `Too young (${Math.floor(ageDays)} < ${config.ageThresholdDays} days)`,
        confidence: 0.9,
      };
    }

    // Get current importance score (updated with access patterns)
    const importanceResult = await this.importanceScorer.updateScore(obs.id);
    const importanceScore = importanceResult?.score ?? 0.5;

    // Get access stats if enabled
    let accessFrequency = 0;
    if (config.enableAccessTracking) {
      const accessStats = this.accessTracker.getAccessStats(obs.id, config.recentAccessDays || 180);
      if (accessStats) {
        accessFrequency = accessStats.accessFrequency;
      }
    }

    // Check if recently accessed
    const hasRecentAccess = accessFrequency > 0;

    // Decision logic
    const reasons: string[] = [];
    let shouldRetain = true;

    // High importance always retained
    if (importanceScore >= 0.6) {
      reasons.push(`High importance (${importanceScore.toFixed(2)})`);
      shouldRetain = true;
    }
    // Low importance with no recent access
    else if (importanceScore < config.importanceThreshold) {
      if (!hasRecentAccess) {
        reasons.push(`Low importance (${importanceScore.toFixed(2)} < ${config.importanceThreshold}) and no recent access`);
        shouldRetain = false;
      } else {
        reasons.push(`Low importance but has recent access (${accessFrequency.toFixed(2)}/day)`);
        shouldRetain = true;
      }
    }
    // Medium importance - check access
    else if (importanceScore < 0.4) {
      if (!hasRecentAccess && ageDays > config.ageDecayHalfLife * 1.5) {
        reasons.push(`Medium importance (${importanceScore.toFixed(2)}) but no recent access and old (${Math.floor(ageDays)} days)`);
        shouldRetain = false;
      } else {
        reasons.push(`Medium importance, keeping for now`);
        shouldRetain = true;
      }
    }
    // Borderline - retain
    else {
      reasons.push(`Borderline importance (${importanceScore.toFixed(2)}), retaining`);
      shouldRetain = true;
    }

    // Calculate confidence based on data availability
    let confidence = 0.7; // Base confidence
    if (hasRecentAccess) confidence += 0.1;
    if (ageDays > config.ageThresholdDays * 2) confidence += 0.1; // More confident with older memories

    return {
      shouldRetain,
      reason: reasons.join('; '),
      confidence: Math.min(1, confidence),
      newImportanceScore: importanceScore,
    };
  }

  /**
   * Batch evaluate multiple memories
   */
  async evaluateBatch(memoryIds: number[], options?: RetentionOptions): Promise<Map<number, RetentionDecision>> {
    const results = new Map<number, RetentionDecision>();

    for (const id of memoryIds) {
      const decision = await this.evaluate(id);
      if (decision) {
        results.set(id, decision);
      }
    }

    return results;
  }

  /**
   * Get candidates for cleanup (memories that can be forgotten)
   * @param limit Maximum number of candidates to return
   */
  async getCleanupCandidates(limit: number = 100): Promise<Array<{
    id: number;
    title: string;
    type: string;
    importanceScore: number;
    age: number;
    reason: string;
  }>> {
    // Get old memories with low importance
    const candidates = this.importanceScorer.getLowImportanceMemories(0.3, 90, limit * 2);

    const results: Array<{
      id: number;
      title: string;
      type: string;
      importanceScore: number;
      age: number;
      reason: string;
    }> = [];

    for (const candidate of candidates) {
      const decision = await this.evaluate(candidate.id);
      if (decision && !decision.shouldRetain) {
        // Get observation details
        const obs = this.db.prepare(`
          SELECT id, title, type FROM observations WHERE id = ?
        `).get(candidate.id) as { id: number; title: string | null; type: string } | undefined;

        if (obs) {
          results.push({
            id: obs.id,
            title: obs.title || `${obs.type} observation`,
            type: obs.type,
            importanceScore: decision.newImportanceScore ?? candidate.score,
            age: candidate.age,
            reason: decision.reason,
          });
        }
      }

      if (results.length >= limit) break;
    }

    return results;
  }

  /**
   * Get retention statistics for a project
   */
  async getProjectRetentionStats(
    project: string,
    lookbackDays: number = 365
  ): Promise<RetentionStats> {
    const stmt = this.db.prepare(`
      SELECT id FROM observations
      WHERE project = ? AND created_at_epoch > ?
      ORDER BY created_at_epoch DESC
      LIMIT 500
    `);

    const cutoff = Date.now() - (lookbackDays * 24 * 60 * 60 * 1000);
    const rows = stmt.all(project, cutoff) as Array<{ id: number }>;

    let retained = 0;
    let forgotten = 0;
    let importanceRetained = 0;
    let importanceForgotten = 0;

    for (const row of rows) {
      const decision = await this.evaluate(row.id);
      if (decision) {
        if (decision.shouldRetain) {
          retained++;
          importanceRetained += decision.newImportanceScore ?? 0;
        } else {
          forgotten++;
          importanceForgotten += decision.newImportanceScore ?? 0;
        }
      }
    }

    return {
      totalEvaluated: rows.length,
      retained,
      forgotten,
      avgImportanceRetained: retained > 0 ? importanceRetained / retained : 0,
      avgImportanceForgotten: forgotten > 0 ? importanceForgotten / forgotten : 0,
    };
  }

  /**
   * Delete memories that should be forgotten
   * Returns the number of memories deleted
   */
  async applyForgetting(limit: number = 100, dryRun: boolean = false): Promise<{
    deleted: number;
    candidates: Array<{ id: number; title: string; reason: string }>;
  }> {
    const candidates = await this.getCleanupCandidates(limit);

    if (dryRun) {
      return {
        deleted: 0,
        candidates: candidates.map(c => ({
          id: c.id,
          title: c.title,
          reason: c.reason,
        })),
      };
    }

    let deleted = 0;

    for (const candidate of candidates) {
      try {
        // Delete from observations (CASCADE will handle related tables)
        this.db.prepare('DELETE FROM observations WHERE id = ?').run(candidate.id);
        deleted++;

        logger.debug('ForgettingPolicy', `Forgot memory`, {
          id: candidate.id,
          title: candidate.title,
          reason: candidate.reason,
        });
      } catch (error: any) {
        logger.error('ForgettingPolicy', `Failed to delete memory ${candidate.id}`, {}, error);
      }
    }

    if (deleted > 0) {
      logger.info('ForgettingPolicy', `Applied forgetting to ${deleted} memories`, {
        deleted,
        limit,
      });
    }

    return {
      deleted,
      candidates: candidates.map(c => ({
        id: c.id,
        title: c.title,
        reason: c.reason,
      })),
    };
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<ForgettingConfig>): void {
    this.config = { ...this.config, ...config };
    logger.info('ForgettingPolicy', 'Configuration updated', { config: this.config });
  }

  /**
   * Get current configuration
   */
  getConfig(): ForgettingConfig {
    return { ...this.config };
  }

  /**
   * Calculate age-based importance decay
   * Uses exponential decay with configurable half-life
   */
  private calculateAgeDecay(ageDays: number): number {
    return Math.exp(-Math.log(2) * ageDays / this.config.ageDecayHalfLife);
  }

}
