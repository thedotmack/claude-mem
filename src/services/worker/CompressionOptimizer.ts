/**
 * CompressionOptimizer: Importance-based compression adjustments
 *
 * Responsibility:
 * - Adjust compression granularity based on observation importance
 * - High importance observations get more detailed compression
 * - Low importance observations get lighter compression
 * - Balance token cost with information preservation
 *
 * Core concept from Titans: Allocate resources based on information value
 */

import { Database } from 'bun:sqlite';
import { logger } from '../../utils/logger.js';
import { ImportanceScorer } from './ImportanceScorer.js';
import type { ObservationRecord } from '../../types/database.js';

/**
 * Compression level for observations
 */
export enum CompressionLevel {
  MINIMAL = 'minimal',       // Keep almost everything (highest value)
  DETAILED = 'detailed',     // Full narrative + facts
  STANDARD = 'standard',     // Standard compression (default)
  LIGHT = 'light',           // Just key facts
  AGGRESSIVE = 'aggressive', // Minimal info (lowest value)
}

/**
 * Compression recommendation
 */
export interface CompressionRecommendation {
  level: CompressionLevel;
  reason: string;
  includeFull: boolean;      // Include full narrative
  includeFacts: boolean;     // Include facts array
  includeConcepts: boolean;  // Include concepts array
  maxTokens: number;         // Maximum tokens for this observation
}

/**
 * Compression statistics
 */
export interface CompressionStats {
  totalObservations: number;
  avgImportanceScore: number;
  distribution: Record<CompressionLevel, number>;
}

/**
 * Configuration for compression optimization
 */
export interface CompressionConfig {
  // Importance thresholds for compression levels
  aggressiveThreshold: number;  // Below this = aggressive
  lightThreshold: number;       // Below this = light
  standardThreshold: number;    // Below this = standard
  detailedThreshold: number;    // Below this = detailed
  // Above this = minimal

  // Token limits per level
  minimalMaxTokens: number;
  detailedMaxTokens: number;
  standardMaxTokens: number;
  lightMaxTokens: number;
  aggressiveMaxTokens: number;
}

/**
 * Default configuration
 */
const DEFAULT_CONFIG: CompressionConfig = {
  aggressiveThreshold: 0.15,
  lightThreshold: 0.25,
  standardThreshold: 0.40,
  detailedThreshold: 0.60,
  minimalMaxTokens: 500,
  detailedMaxTokens: 400,
  standardMaxTokens: 300,
  lightMaxTokens: 200,
  aggressiveMaxTokens: 100,
};

/**
 * Optimizes compression settings based on observation importance
 *
 * The idea: High-value content should be preserved in more detail,
 * while low-value content can be heavily compressed to save tokens.
 */
export class CompressionOptimizer {
  private config: CompressionConfig;
  private importanceScorer: ImportanceScorer;

  constructor(db: Database, config?: Partial<CompressionConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.importanceScorer = new ImportanceScorer(db);
  }

  /**
   * Get compression recommendation for an observation
   */
  async getRecommendation(observation: ObservationRecord): Promise<CompressionRecommendation> {
    // Get current importance score
    const importanceResult = await this.importanceScorer.updateScore(observation.id);
    const score = importanceResult?.score ?? 0.5;

    // Determine compression level based on importance
    const level = this.getCompressionLevel(score);

    return {
      level,
      reason: this.getReason(score, level),
      includeFull: level >= CompressionLevel.STANDARD,
      includeFacts: level >= CompressionLevel.LIGHT,
      includeConcepts: level >= CompressionLevel.DETAILED,
      maxTokens: this.getMaxTokens(level),
    };
  }

  /**
   * Batch get recommendations
   */
  async getRecommendationsBatch(observations: ObservationRecord[]): Promise<Map<number, CompressionRecommendation>> {
    const results = new Map<number, CompressionRecommendation>();

    for (const obs of observations) {
      const recommendation = await this.getRecommendation(obs);
      results.set(obs.id, recommendation);
    }

    return results;
  }

  /**
   * Get compression level for an importance score
   */
  private getCompressionLevel(score: number): CompressionLevel {
    if (score >= this.config.detailedThreshold) {
      return CompressionLevel.MINIMAL;
    } else if (score >= this.config.standardThreshold) {
      return CompressionLevel.DETAILED;
    } else if (score >= this.config.lightThreshold) {
      return CompressionLevel.STANDARD;
    } else if (score >= this.config.aggressiveThreshold) {
      return CompressionLevel.LIGHT;
    } else {
      return CompressionLevel.AGGRESSIVE;
    }
  }

  /**
   * Get human-readable reason for compression level
   */
  private getReason(score: number, level: CompressionLevel): string {
    switch (level) {
      case CompressionLevel.MINIMAL:
        return `Very high importance (${score.toFixed(2)}), keeping maximum detail`;
      case CompressionLevel.DETAILED:
        return `High importance (${score.toFixed(2)}), keeping full detail`;
      case CompressionLevel.STANDARD:
        return `Medium importance (${score.toFixed(2)}), standard compression`;
      case CompressionLevel.LIGHT:
        return `Low-medium importance (${score.toFixed(2)}), keeping key facts only`;
      case CompressionLevel.AGGRESSIVE:
        return `Low importance (${score.toFixed(2)}), minimal compression`;
    }
  }

  /**
   * Get max tokens for a compression level
   */
  private getMaxTokens(level: CompressionLevel): number {
    switch (level) {
      case CompressionLevel.MINIMAL:
        return this.config.minimalMaxTokens;
      case CompressionLevel.DETAILED:
        return this.config.detailedMaxTokens;
      case CompressionLevel.STANDARD:
        return this.config.standardMaxTokens;
      case CompressionLevel.LIGHT:
        return this.config.lightMaxTokens;
      case CompressionLevel.AGGRESSIVE:
        return this.config.aggressiveMaxTokens;
    }
  }

  /**
   * Get compression statistics for a project
   */
  async getProjectCompressionStats(project: string, lookbackDays: number = 90): Promise<CompressionStats> {
    const stmt = this.db.prepare(`
      SELECT id FROM observations
      WHERE project = ? AND created_at_epoch > ?
      LIMIT 1000
    `);

    const cutoff = Date.now() - (lookbackDays * 24 * 60 * 60 * 1000);
    const rows = stmt.all(project, cutoff) as Array<{ id: number }>;

    let totalImportance = 0;
    const distribution: Record<CompressionLevel, number> = {
      [CompressionLevel.MINIMAL]: 0,
      [CompressionLevel.DETAILED]: 0,
      [CompressionLevel.STANDARD]: 0,
      [CompressionLevel.LIGHT]: 0,
      [CompressionLevel.AGGRESSIVE]: 0,
    };

    // Get importance scores
    const scores = this.importanceScorer.getScoresBatch(rows.map(r => r.id));

    for (const [id, score] of scores.entries()) {
      totalImportance += score;
      const level = this.getCompressionLevel(score);
      distribution[level]++;
    }

    return {
      totalObservations: rows.length,
      avgImportanceScore: rows.length > 0 ? totalImportance / rows.length : 0,
      distribution,
    };
  }

  /**
   * Estimate token savings with compression optimization
   */
  async estimateTokenSavings(project: string, lookbackDays: number = 90): Promise<{
    currentTokens: number;
    optimizedTokens: number;
    savings: number;
    savingsPercent: number;
  }> {
    const stats = await this.getProjectCompressionStats(project, lookbackDays);

    // Current approach: all observations use standard compression (~300 tokens each)
    const currentTokens = stats.totalObservations * 300;

    // Optimized approach: vary by importance
    const optimizedTokens =
      stats.distribution[CompressionLevel.MINIMAL] * this.config.minimalMaxTokens +
      stats.distribution[CompressionLevel.DETAILED] * this.config.detailedMaxTokens +
      stats.distribution[CompressionLevel.STANDARD] * this.config.standardMaxTokens +
      stats.distribution[CompressionLevel.LIGHT] * this.config.lightMaxTokens +
      stats.distribution[CompressionLevel.AGGRESSIVE] * this.config.aggressiveMaxTokens;

    const savings = currentTokens - optimizedTokens;
    const savingsPercent = currentTokens > 0 ? (savings / currentTokens) * 100 : 0;

    return {
      currentTokens,
      optimizedTokens,
      savings,
      savingsPercent,
    };
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<CompressionConfig>): void {
    this.config = { ...this.config, ...config };
    logger.info('CompressionOptimizer', 'Configuration updated', { config: this.config });
  }

  /**
   * Get current configuration
   */
  getConfig(): CompressionConfig {
    return { ...this.config };
  }

  /**
   * Get database reference
   */
  private get db(): Database {
    return (this.importanceScorer as any).db;
  }
}
