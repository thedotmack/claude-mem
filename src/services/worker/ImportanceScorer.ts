/**
 * ImportanceScorer: Calculate and update importance scores for memories
 *
 * Responsibility:
 * - Calculate initial importance scores for new observations
 * - Update importance scores based on access patterns
 * - Combine multiple factors: type, rarity, surprise, access frequency, age
 */

import { Database } from 'bun:sqlite';
import { logger } from '../../utils/logger.js';
import type { ObservationRecord } from '../../types/database.js';
import { AccessTracker } from './AccessTracker.js';

/**
 * Type-based importance weights
 */
const TYPE_WEIGHTS: Record<string, number> = {
  'bugfix': 1.5,      // Bug fixes are high value
  'decision': 1.3,    // Decisions shape the codebase
  'feature': 1.2,     // New features are important
  'refactor': 1.1,    // Refactors improve quality
  'discovery': 1.0,   // Baseline
  'change': 1.0,      // Baseline
};

/**
 * Initial score ranges for different observation types
 */
const INITIAL_SCORE_RANGES: Record<string, { min: number; max: number }> = {
  'bugfix': { min: 0.6, max: 0.9 },
  'decision': { min: 0.5, max: 0.8 },
  'feature': { min: 0.5, max: 0.8 },
  'refactor': { min: 0.4, max: 0.7 },
  'discovery': { min: 0.3, max: 0.6 },
  'change': { min: 0.3, max: 0.6 },
};

/**
 * Factors contributing to importance score
 */
export interface ImportanceFactors {
  initialScore: number;      // Base score from type
  typeBonus: number;         // Type-specific multiplier
  semanticRarity: number;    // How semantically unique this is (0-1)
  surprise: number;          // Novelty/surprise score (0-1)
  accessFrequency: number;   // Recent access frequency
  age: number;              // Time-based decay factor (0-1)
}

/**
 * Calculated importance score with breakdown
 */
export interface ImportanceResult {
  score: number;             // Final importance score (0-1)
  factors: ImportanceFactors;
  confidence: number;        // How confident we are in this score
}

/**
 * Options for updating importance score
 */
export interface UpdateScoreOptions {
  surpriseScore?: number;    // Pre-calculated surprise score (0-1)
  semanticRarity?: number;   // Pre-calculated semantic rarity (0-1)
}

/**
 * Calculates and manages importance scores for observations
 */
export class ImportanceScorer {
  private accessTracker: AccessTracker;

  constructor(private db: Database) {
    this.accessTracker = new AccessTracker(db);
  }

  /**
   * Calculate initial importance score for a new observation
   */
  async score(observation: ObservationRecord): Promise<ImportanceResult> {
    const factors: ImportanceFactors = {
      initialScore: this.getInitialScore(observation.type),
      typeBonus: TYPE_WEIGHTS[observation.type] || 1.0,
      semanticRarity: 0.5, // Will be calculated by SemanticRarity
      surprise: 0.5,       // Will be calculated by SurpriseMetric
      accessFrequency: 0,  // New observations have no access history
      age: 1.0,           // New observations have no age decay
    };

    const score = this.calculateScore(factors);

    return {
      score,
      factors,
      confidence: this.calculateConfidence(factors),
    };
  }

  /**
   * Update importance score for an existing memory
   * Takes into account access patterns, age, and optionally pre-calculated surprise
   * @param memoryId The observation ID to update
   * @param options Optional pre-calculated scores (surprise, semantic rarity)
   */
  async updateScore(memoryId: number, options: UpdateScoreOptions = {}): Promise<ImportanceResult | null> {
    try {
      // Get the observation
      const obsStmt = this.db.prepare(`
        SELECT * FROM observations WHERE id = ?
      `);
      const observation = obsStmt.get(memoryId) as ObservationRecord | undefined;
      if (!observation) return null;

      // Get access stats
      const accessStats = this.accessTracker.getAccessStats(memoryId, 30);
      if (!accessStats) return null;

      // Calculate age in days
      const ageDays = (Date.now() - observation.created_at_epoch) / (24 * 60 * 60 * 1000);

      // Use provided surprise score or fall back to stored value or default
      const surpriseScore = options.surpriseScore ??
        observation.surprise_score ??
        0.5;

      const factors: ImportanceFactors = {
        initialScore: this.getInitialScore(observation.type),
        typeBonus: TYPE_WEIGHTS[observation.type] || 1.0,
        semanticRarity: options.semanticRarity ?? 0.5,
        surprise: surpriseScore,
        accessFrequency: Math.min(accessStats.accessFrequency / 10, 1), // Normalize to 0-1
        age: this.ageDecay(ageDays),
      };

      const score = this.calculateScore(factors);

      // Update database with both importance_score and surprise_score
      this.db.prepare(`
        UPDATE observations
        SET importance_score = ?,
            surprise_score = ?
        WHERE id = ?
      `).run(score, surpriseScore, memoryId);

      return {
        score,
        factors,
        confidence: this.calculateConfidence(factors),
      };
    } catch (error: any) {
      logger.error('ImportanceScorer', `Failed to update score for memory ${memoryId}`, {}, error);
      return null;
    }
  }

  /**
   * Batch update importance scores for multiple memories
   */
  async updateScoreBatch(memoryIds: number[]): Promise<Map<number, ImportanceResult>> {
    const results = new Map<number, ImportanceResult>();

    for (const memoryId of memoryIds) {
      const result = await this.updateScore(memoryId);
      if (result) {
        results.set(memoryId, result);
      }
    }

    return results;
  }

  /**
   * Get importance score for a memory (from database or calculated)
   */
  getScore(memoryId: number): number {
    try {
      const stmt = this.db.prepare(`
        SELECT COALESCE(importance_score, 0.5) as score
        FROM observations
        WHERE id = ?
      `);
      const result = stmt.get(memoryId) as { score: number } | undefined;
      return result?.score ?? 0.5;
    } catch {
      return 0.5;
    }
  }

  /**
   * Get importance scores for multiple memories
   */
  getScoresBatch(memoryIds: number[]): Map<number, number> {
    const scores = new Map<number, number>();

    if (memoryIds.length === 0) return scores;

    try {
      const placeholders = memoryIds.map(() => '?').join(',');
      const stmt = this.db.prepare(`
        SELECT id, COALESCE(importance_score, 0.5) as score
        FROM observations
        WHERE id IN (${placeholders})
      `);

      const results = stmt.all(...memoryIds) as Array<{ id: number; score: number }>;

      for (const result of results) {
        scores.set(result.id, result.score);
      }
    } catch (error: any) {
      logger.error('ImportanceScorer', 'Failed to get batch scores', {}, error);
    }

    return scores;
  }

  /**
   * Get low-importance memories that could be candidates for cleanup
   * @param threshold Maximum importance score to include
   * @param olderThanDays Minimum age in days
   * @param limit Maximum results to return
   */
  getLowImportanceMemories(threshold: number = 0.3, olderThanDays: number = 90, limit: number = 100): Array<{ id: number; score: number; age: number }> {
    try {
      const cutoffEpoch = Date.now() - (olderThanDays * 24 * 60 * 60 * 1000);

      const stmt = this.db.prepare(`
        SELECT
          id,
          COALESCE(importance_score, 0.5) as score,
          (CAST(strftime('%s', 'now') as INTEGER) * 1000 - created_at_epoch) / (24 * 60 * 60 * 1000) as age
        FROM observations
        WHERE created_at_epoch < ?
          AND COALESCE(importance_score, 0.5) < ?
        ORDER BY score ASC, created_at_epoch DESC
        LIMIT ?
      `);

      return stmt.all(cutoffEpoch, threshold, limit) as Array<{ id: number; score: number; age: number }>;
    } catch (error: any) {
      logger.error('ImportanceScorer', 'Failed to get low importance memories', {}, error);
      return [];
    }
  }

  /**
   * Calculate initial score based on observation type
   */
  private getInitialScore(type: string): number {
    const range = INITIAL_SCORE_RANGES[type] || INITIAL_SCORE_RANGES['discovery'];
    // Add some randomness within the range
    return range.min + Math.random() * (range.max - range.min);
  }

  /**
   * Calculate final score from all factors
   */
  private calculateScore(factors: ImportanceFactors): number {
    // Base score from type
    let score = factors.initialScore;

    // Apply type bonus
    score *= factors.typeBonus;

    // Apply semantic rarity (rarer = more important)
    score = score * 0.7 + factors.semanticRarity * 0.3;

    // Apply surprise (more surprising = more important)
    score = score * 0.8 + factors.surprise * 0.2;

    // Apply access frequency boost (frequently accessed = more important)
    score = score * 0.9 + factors.accessFrequency * 0.1;

    // Apply age decay
    score *= factors.age;

    // Clamp to 0-1 range
    return Math.max(0, Math.min(1, score));
  }

  /**
   * Calculate confidence in the score (0-1)
   * Based on how many factors we have actual values for
   */
  private calculateConfidence(factors: ImportanceFactors): number {
    let knownFactors = 2; // initialScore and typeBonus are always known
    if (factors.semanticRarity > 0) knownFactors++;
    if (factors.surprise > 0) knownFactors++;
    if (factors.accessFrequency > 0) knownFactors++;

    return knownFactors / 5; // We have 5 total factors
  }

  /**
   * Calculate age-based decay factor
   * Uses exponential decay with a half-life of 90 days
   */
  private ageDecay(ageDays: number): number {
    const halfLife = 90; // days
    return Math.exp(-Math.log(2) * ageDays / halfLife);
  }

  /**
   * Update the type weights configuration
   * Can be used to tune importance scoring based on user feedback
   */
  updateTypeWeights(weights: Partial<Record<string, number>>): void {
    Object.assign(TYPE_WEIGHTS, weights);
    logger.info('ImportanceScorer', 'Updated type weights', { weights: TYPE_WEIGHTS });
  }

  /**
   * Get current type weights
   */
  getTypeWeights(): Record<string, number> {
    return { ...TYPE_WEIGHTS };
  }
}
