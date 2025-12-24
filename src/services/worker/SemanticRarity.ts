/**
 * SemanticRarity: Calculate semantic rarity for observations
 *
 * Responsibility:
 * - Calculate how semantically unique an observation is compared to existing memories
 * - Higher rarity = more unique/valuable information
 * - Uses Chroma embeddings for semantic distance calculation
 */

import { Database } from 'bun:sqlite';
import { logger } from '../../utils/logger.js';
import type { ObservationRecord } from '../../types/database.js';
import { ChromaSync } from '../sync/ChromaSync.js';

/**
 * Rarity calculation result
 */
export interface RarityResult {
  score: number;           // 0-1, higher = rarer
  confidence: number;      // How confident we are in this score
  similarMemories: Array<{
    id: number;
    distance: number;
    type: string;
  }>;
}

/**
 * Options for rarity calculation
 */
export interface RarityOptions {
  lookbackDays?: number;   // Only consider recent memories (default: 90)
  sampleSize?: number;     // How many memories to compare against (default: 100)
  minSamples?: number;     // Minimum samples required for confident score (default: 10)
}

/**
 * Calculates semantic rarity based on embedding distances
 */
export class SemanticRarity {
  private chroma: ChromaSync;
  private cache: Map<number, number> = new Map();
  private cacheTimestamp: number = 0;
  private readonly CACHE_TTL = 5 * 60 * 1000; // 5 minutes

  constructor(private db: Database) {
    this.chroma = new ChromaSync('claude-mem');
  }

  /**
   * Calculate semantic rarity for a single observation
   */
  async calculate(
    observation: ObservationRecord,
    options: RarityOptions = {}
  ): Promise<RarityResult> {
    const {
      lookbackDays = 90,
      sampleSize = 100,
      minSamples = 10,
    } = options;

    try {
      // Get similar memories from Chroma
      const similarMemories = await this.getSimilarMemories(
        observation,
        sampleSize,
        lookbackDays
      );

      if (similarMemories.length < minSamples) {
        // Not enough data for confident score
        return {
          score: 0.5, // Default to neutral
          confidence: 0.3, // Low confidence
          similarMemories: [],
        };
      }

      // Calculate rarity score (inverse of average similarity)
      const avgDistance = similarMemories.reduce((sum, m) => sum + m.distance, 0) / similarMemories.length;

      // Convert distance to rarity (0-1)
      // Distance ranges from 0 (identical) to 2 (opposite in cosine similarity)
      // We map: distance 0 -> rarity 0, distance 1+ -> rarity 1
      const score = Math.min(1, avgDistance);

      // Confidence based on sample size
      const confidence = Math.min(1, similarMemories.length / sampleSize);

      return {
        score,
        confidence,
        similarMemories: similarMemories.map(m => ({
          id: m.id,
          distance: m.distance,
          type: m.type,
        })),
      };
    } catch (error: any) {
      logger.error('SemanticRarity', `Failed to calculate rarity for observation ${observation.id}`, {}, error);
      return {
        score: 0.5,
        confidence: 0,
        similarMemories: [],
      };
    }
  }

  /**
   * Batch calculate rarity for multiple observations
   */
  async calculateBatch(
    observations: ObservationRecord[],
    options: RarityOptions = {}
  ): Promise<Map<number, RarityResult>> {
    const results = new Map<number, RarityResult>();

    for (const obs of observations) {
      const result = await this.calculate(obs, options);
      results.set(obs.id, result);
    }

    return results;
  }

  /**
   * Get cached rarity score if available and fresh
   */
  getCached(memoryId: number): number | null {
    const cached = this.cache.get(memoryId);
    if (!cached) return null;

    const age = Date.now() - this.cacheTimestamp;
    if (age > this.CACHE_TTL) {
      this.cache.clear();
      return null;
    }

    return cached;
  }

  /**
   * Set cached rarity score
   */
  setCached(memoryId: number, score: number): void {
    // Clear cache if too old
    const age = Date.now() - this.cacheTimestamp;
    if (age > this.CACHE_TTL) {
      this.cache.clear();
      this.cacheTimestamp = Date.now();
    }

    this.cache.set(memoryId, score);
  }

  /**
   * Clear the rarity cache
   */
  clearCache(): void {
    this.cache.clear();
    this.cacheTimestamp = 0;
  }

  /**
   * Get memories that are semantically rare (good candidates for retention)
   * @param threshold Minimum rarity score (0-1)
   * @param limit Maximum results
   */
  async getRareMemories(threshold: number = 0.7, limit: number = 50): Promise<Array<{ id: number; title: string; score: number }>> {
    try {
      // Get recent observations
      const stmt = this.db.prepare(`
        SELECT id, title, type, created_at_epoch
        FROM observations
        WHERE created_at_epoch > ?
        ORDER BY created_at_epoch DESC
        LIMIT 200
      `);

      const cutoff = Date.now() - (90 * 24 * 60 * 60 * 1000); // 90 days
      const observations = stmt.all(cutoff) as ObservationRecord[];

      // Calculate rarity for each
      const rareMemories: Array<{ id: number; title: string; score: number }> = [];

      for (const obs of observations) {
        const result = await this.calculate(obs, { sampleSize: 50 });
        if (result.score >= threshold && result.confidence > 0.5) {
          rareMemories.push({
            id: obs.id,
            title: obs.title || `${obs.type} observation`,
            score: result.score,
          });
        }

        if (rareMemories.length >= limit) break;
      }

      return rareMemories.sort((a, b) => b.score - a.score);
    } catch (error: any) {
      logger.error('SemanticRarity', 'Failed to get rare memories', {}, error);
      return [];
    }
  }

  /**
   * Get similar memories using Chroma semantic search
   */
  private async getSimilarMemories(
    observation: ObservationRecord,
    limit: number,
    lookbackDays: number
  ): Promise<Array<{ id: number; distance: number; type: string }>> {
    try {
      // Query Chroma for similar memories
      const results = await this.chroma.queryObservations(
        observation.project,
        observation.title || observation.text || '',
        { limit, lookbackDays }
      );

      return results
        .filter(r => r.id !== observation.id) // Exclude self
        .map(r => ({
          id: r.id,
          distance: 1 - r.score, // Convert similarity to distance
          type: r.type,
        }));
    } catch (error: any) {
      logger.debug('SemanticRarity', 'Chroma query failed, using database fallback', {}, error);

      // Fallback: Get random recent observations from database
      const cutoff = Date.now() - (lookbackDays * 24 * 60 * 60 * 1000);
      const stmt = this.db.prepare(`
        SELECT id, type FROM observations
        WHERE project = ? AND id != ? AND created_at_epoch > ?
        ORDER BY RANDOM()
        LIMIT ?
      `);

      const results = stmt.all(observation.project, observation.id, cutoff, limit) as Array<{ id: number; type: string }>;

      // Return with neutral distance (0.5)
      return results.map(r => ({
        id: r.id,
        distance: 0.5,
        type: r.type,
      }));
    }
  }

  /**
   * Calculate rarity distribution statistics for a project
   * Useful for understanding the overall diversity of memories
   */
  async getProjectRarityStats(project: string, lookbackDays: number = 90): Promise<{
    mean: number;
    median: number;
    min: number;
    max: number;
    sampleCount: number;
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
        return { mean: 0, median: 0, min: 0, max: 0, sampleCount: 0 };
      }

      const scores: number[] = [];

      for (const obs of observations) {
        const result = await this.calculate(obs, { sampleSize: 30 });
        scores.push(result.score);
      }

      scores.sort((a, b) => a - b);

      return {
        mean: scores.reduce((sum, s) => sum + s, 0) / scores.length,
        median: scores[Math.floor(scores.length / 2)],
        min: scores[0],
        max: scores[scores.length - 1],
        sampleCount: scores.length,
      };
    } catch (error: any) {
      logger.error('SemanticRarity', `Failed to get rarity stats for project ${project}`, {}, error);
      return { mean: 0, median: 0, min: 0, max: 0, sampleCount: 0 };
    }
  }
}
