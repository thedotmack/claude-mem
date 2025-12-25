/**
 * SurpriseMetric: Compute semantic novelty/surprise for observations
 *
 * Responsibility:
 * - Calculate how "surprising" or novel an observation is compared to existing memories
 * - Higher surprise = more novel/unexpected = should be prioritized for storage
 * - Uses semantic distance from embeddings and temporal decay
 *
 * Core concept from Titans: Unexpected information gets higher priority
 */

import { Database } from 'bun:sqlite';
import { logger } from '../../utils/logger.js';
import type { ObservationRecord } from '../../types/database.js';
import { ChromaSync } from '../sync/ChromaSync.js';

/**
 * Surprise calculation result
 */
export interface SurpriseResult {
  score: number;              // 0-1, higher = more surprising
  confidence: number;         // How confident we are in this score
  similarMemories: Array<{
    id: number;
    distance: number;
    type: string;
    created_at: string;
  }>;
  factors: {
    semanticDistance: number;  // 0-1, avg distance to similar memories
    temporalNovelty: number;   // 0-1, newer memories less surprising
    typeNovelty: number;       // 0-1, rare types more surprising
  };
}

/**
 * Options for surprise calculation
 */
export interface SurpriseOptions {
  lookbackDays?: number;   // Only consider recent memories (default: 30)
  sampleSize?: number;     // How many memories to compare against (default: 50)
  minSamples?: number;     // Minimum samples for confident score (default: 5)
  project?: string;        // Filter by project
}

/**
 * Type rarity weights (rarer types are more surprising)
 */
const TYPE_RARITY: Record<string, number> = {
  'bugfix': 0.6,      // Bug fixes are somewhat common
  'discovery': 0.5,   // Discoveries are baseline
  'change': 0.5,      // Changes are baseline
  'feature': 0.7,     // New features are less common
  'refactor': 0.7,    // Refactors are less common
  'decision': 0.8,    // Decisions are rarer
};

/**
 * Calculates semantic surprise based on embedding distances and novelty factors
 */
export class SurpriseMetric {
  private chroma: ChromaSync;
  private cache: Map<string, { score: number; timestamp: number }> = new Map();
  private readonly CACHE_TTL = 2 * 60 * 1000; // 2 minutes

  constructor(private db: Database) {
    this.chroma = new ChromaSync('claude-mem');
  }

  /**
   * Calculate surprise for a single observation
   */
  async calculate(
    observation: ObservationRecord,
    options: SurpriseOptions = {}
  ): Promise<SurpriseResult> {
    const {
      lookbackDays = 30,
      sampleSize = 50,
      minSamples = 5,
    } = options;

    try {
      // Get similar memories from Chroma
      const similarMemories = await this.getSimilarMemories(
        observation,
        sampleSize,
        lookbackDays,
        options.project
      );

      if (similarMemories.length < minSamples) {
        // Not enough data - assume moderate surprise for new projects
        return {
          score: 0.6,
          confidence: 0.3,
          similarMemories: [],
          factors: {
            semanticDistance: 0.5,
            temporalNovelty: 0.5,
            typeNovelty: TYPE_RARITY[observation.type] || 0.5,
          },
        };
      }

      // Calculate factors
      const semanticDistance = this.calculateSemanticDistance(similarMemories);
      const temporalNovelty = this.calculateTemporalNovelty(observation, similarMemories);
      const typeNovelty = TYPE_RARITY[observation.type] || 0.5;

      // Combine factors into final score
      const score = this.combineFactors({
        semanticDistance,
        temporalNovelty,
        typeNovelty,
      });

      // Confidence based on sample size and recency
      const confidence = Math.min(1, similarMemories.length / sampleSize);

      return {
        score,
        confidence,
        similarMemories: similarMemories.slice(0, 10), // Top 10 for reference
        factors: {
          semanticDistance,
          temporalNovelty,
          typeNovelty,
        },
      };
    } catch (error: any) {
      logger.error('SurpriseMetric', `Failed to calculate surprise for observation ${observation.id}`, {}, error);
      return {
        score: 0.5, // Default to neutral on error
        confidence: 0,
        similarMemories: [],
        factors: {
          semanticDistance: 0.5,
          temporalNovelty: 0.5,
          typeNovelty: 0.5,
        },
      };
    }
  }

  /**
   * Batch calculate surprise for multiple observations
   */
  async calculateBatch(
    observations: ObservationRecord[],
    options: SurpriseOptions = {}
  ): Promise<Map<number, SurpriseResult>> {
    const results = new Map<number, SurpriseResult>();

    for (const obs of observations) {
      const result = await this.calculate(obs, options);
      results.set(obs.id, result);
    }

    return results;
  }

  /**
   * Check if an observation should be filtered based on surprise threshold
   * Returns true if the observation is NOT surprising enough (should be filtered)
   */
  async shouldFilter(
    observation: ObservationRecord,
    threshold: number = 0.3,
    options: SurpriseOptions = {}
  ): Promise<boolean> {
    // Check cache first
    const cacheKey = `${observation.id}:${threshold}`;
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
      return cached.score < threshold;
    }

    const result = await this.calculate(observation, options);

    // Cache the result
    this.cache.set(cacheKey, {
      score: result.score,
      timestamp: Date.now(),
    });

    return result.score < threshold;
  }

  /**
   * Get surprising memories (high surprise scores)
   * Useful for identifying novel/interesting content
   */
  async getSurprisingMemories(
    threshold: number = 0.7,
    limit: number = 50,
    lookbackDays: number = 30
  ): Promise<Array<{ id: number; title: string; score: number; type: string }>> {
    try {
      // Get recent observations
      const stmt = this.db.prepare(`
        SELECT id, title, type, project, created_at_epoch
        FROM observations
        WHERE created_at_epoch > ?
        ORDER BY created_at_epoch DESC
        LIMIT 200
      `);

      const cutoff = Date.now() - (lookbackDays * 24 * 60 * 60 * 1000);
      const observations = stmt.all(cutoff) as ObservationRecord[];

      // Calculate surprise for each
      const surprising: Array<{ id: number; title: string; score: number; type: string }> = [];

      for (const obs of observations) {
        const result = await this.calculate(obs, { sampleSize: 30 });
        if (result.score >= threshold && result.confidence > 0.4) {
          surprising.push({
            id: obs.id,
            title: obs.title || `${obs.type} observation`,
            score: result.score,
            type: obs.type,
          });
        }

        if (surprising.length >= limit) break;
      }

      return surprising.sort((a, b) => b.score - a.score);
    } catch (error: any) {
      logger.error('SurpriseMetric', 'Failed to get surprising memories', {}, error);
      return [];
    }
  }

  /**
   * Get similar memories using Chroma semantic search
   */
  private async getSimilarMemories(
    observation: ObservationRecord,
    limit: number,
    lookbackDays: number,
    project?: string
  ): Promise<Array<{ id: number; distance: number; type: string; created_at: string }>> {
    try {
      // Query Chroma for similar memories
      const results = await this.chroma.queryObservations(
        project || observation.project,
        observation.title || observation.text || '',
        { limit, lookbackDays }
      );

      return results
        .filter(r => r.id !== observation.id) // Exclude self
        .map(r => ({
          id: r.id,
          distance: 1 - r.score, // Convert similarity (0-1) to distance (0-1)
          type: r.type,
          created_at: r.created_at,
        }));
    } catch (error: any) {
      logger.debug('SurpriseMetric', 'Chroma query failed, using database fallback', {}, error);

      // Fallback: Get random recent observations from database
      const cutoff = Date.now() - (lookbackDays * 24 * 60 * 60 * 1000);

      let query = `
        SELECT id, type, created_at FROM observations
        WHERE id != ? AND created_at_epoch > ?
      `;
      const params: any[] = [observation.id, cutoff];

      if (project) {
        query += ' AND project = ?';
        params.push(project);
      }

      query += ' ORDER BY RANDOM() LIMIT ?';
      params.push(limit);

      const stmt = this.db.prepare(query);
      const results = stmt.all(...params) as Array<{ id: number; type: string; created_at: string }>;

      // Return with neutral distance (0.5)
      return results.map(r => ({
        id: r.id,
        distance: 0.5,
        type: r.type,
        created_at: r.created_at,
      }));
    }
  }

  /**
   * Calculate semantic distance factor (0-1)
   * Higher = more distant from existing memories = more surprising
   */
  private calculateSemanticDistance(similarMemories: Array<{ distance: number }>): number {
    if (similarMemories.length === 0) return 0.5;

    // Average distance to similar memories
    const avgDistance = similarMemories.reduce((sum, m) => sum + m.distance, 0) / similarMemories.length;

    // Use top 5 most similar (smallest distance) for a stricter metric
    const top5 = similarMemories.slice(0, Math.min(5, similarMemories.length));
    const minAvgDistance = top5.reduce((sum, m) => sum + m.distance, 0) / top5.length;

    // Combine both: 70% weight on closest matches, 30% on average
    return minAvgDistance * 0.7 + avgDistance * 0.3;
  }

  /**
   * Calculate temporal novelty factor (0-1)
   * Accounts for the fact that recent similar memories reduce surprise
   */
  private calculateTemporalNovelty(
    observation: ObservationRecord,
    similarMemories: Array<{ distance: number; created_at: string }>
  ): number {
    if (similarMemories.length === 0) return 1.0; // Completely novel if no similar memories

    const obsTime = new Date(observation.created_at).getTime();
    const now = Date.now();

    // Calculate weighted recency of similar memories
    // More recent similar memories = lower temporal novelty
    let weightedRecency = 0;
    let totalWeight = 0;

    for (const mem of similarMemories) {
      const memTime = new Date(mem.created_at).getTime();
      const ageHours = (obsTime - memTime) / (60 * 60 * 1000);

      // Weight by similarity (closer = more weight) and recency
      const similarityWeight = 1 - mem.distance;
      const recencyWeight = Math.exp(-ageHours / 24); // 24-hour half-life

      weightedRecency += similarityWeight * recencyWeight;
      totalWeight += similarityWeight;
    }

    if (totalWeight === 0) return 1.0;

    const avgRecency = weightedRecency / totalWeight;

    // Convert recency (0-1) to novelty (1-0)
    // High recency = low novelty, low recency = high novelty
    return 1 - avgRecency;
  }

  /**
   * Combine multiple factors into final surprise score
   */
  private combineFactors(factors: {
    semanticDistance: number;
    temporalNovelty: number;
    typeNovelty: number;
  }): number {
    // Weighted combination
    // Semantic distance is most important (50%)
    // Temporal novelty accounts for recent similar content (30%)
    // Type rarity accounts for observation type (20%)
    const score =
      factors.semanticDistance * 0.5 +
      factors.temporalNovelty * 0.3 +
      factors.typeNovelty * 0.2;

    // Clamp to 0-1 range
    return Math.max(0, Math.min(1, score));
  }

  /**
   * Clear the surprise cache
   */
  clearCache(): void {
    this.cache.clear();
  }

  /**
   * Get surprise statistics for a project
   */
  async getProjectSurpriseStats(
    project: string,
    lookbackDays: number = 30
  ): Promise<{
    mean: number;
    median: number;
    min: number;
    max: number;
    sampleCount: number;
    byType: Record<string, { mean: number; count: number }>;
  }> {
    try {
      const stmt = this.db.prepare(`
        SELECT id, title, type, text, created_at_epoch
        FROM observations
        WHERE project = ? AND created_at_epoch > ?
        LIMIT 500
      `);

      const cutoff = Date.now() - (lookbackDays * 24 * 60 * 60 * 1000);
      const observations = stmt.all(project, cutoff) as ObservationRecord[];

      if (observations.length === 0) {
        return {
          mean: 0,
          median: 0,
          min: 0,
          max: 0,
          sampleCount: 0,
          byType: {},
        };
      }

      const scores: number[] = [];
      const byType: Record<string, number[]> = {};

      for (const obs of observations) {
        const result = await this.calculate(obs, { sampleSize: 30 });
        scores.push(result.score);

        if (!byType[obs.type]) {
          byType[obs.type] = [];
        }
        byType[obs.type].push(result.score);
      }

      scores.sort((a, b) => a - b);

      const byTypeStats: Record<string, { mean: number; count: number }> = {};
      for (const [type, typeScores] of Object.entries(byType)) {
        byTypeStats[type] = {
          mean: typeScores.reduce((sum, s) => sum + s, 0) / typeScores.length,
          count: typeScores.length,
        };
      }

      return {
        mean: scores.reduce((sum, s) => sum + s, 0) / scores.length,
        median: scores[Math.floor(scores.length / 2)],
        min: scores[0],
        max: scores[scores.length - 1],
        sampleCount: scores.length,
        byType: byTypeStats,
      };
    } catch (error: any) {
      logger.error('SurpriseMetric', `Failed to get surprise stats for project ${project}`, {}, error);
      return {
        mean: 0,
        median: 0,
        min: 0,
        max: 0,
        sampleCount: 0,
        byType: {},
      };
    }
  }
}
