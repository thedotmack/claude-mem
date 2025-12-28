/**
 * MomentumBuffer: Short-term boost for related topics after high-surprise events
 *
 * Responsibility:
 * - Maintain a short-term buffer of boosted topics
 * - When a high-surprise event occurs, boost related topics for a duration
 * - This ensures related follow-up observations are also prioritized
 *
 * Core concept from Titans: "Momentum" considers both momentary and past surprise
 */

import { logger } from '../../utils/logger.js';

/**
 * A boosted topic with expiration
 */
export interface BoostedTopic {
  topic: string;          // The topic keyword/phrase
  expiry: number;         // Expiration timestamp (epoch ms)
  boostFactor: number;    // Multiplier for importance (1.0-3.0)
  sourceMemoryId?: number; // ID of the memory that caused this boost
  context?: string;       // Additional context about the boost
}

/**
 * Options for boosting topics
 */
export interface BoostOptions {
  duration?: number;      // Duration in minutes (default: 5)
  boostFactor?: number;   // Boost multiplier (default: 1.5)
}

/**
 * Result of checking if a topic is boosted
 */
export interface BoostStatus {
  isBoosted: boolean;
  boostFactor: number;
  remainingSeconds: number;
  source?: BoostedTopic;
}

/**
 * Manages short-term topic boosts based on recent surprise events
 *
 * Example flow:
 * 1. User fixes a bug in "auth module" → high surprise
 * 2. System boosts "auth" topic for 5 minutes
 * 3. Related observations about "auth" get boosted importance
 * 4. Boost expires after 5 minutes
 */
export class MomentumBuffer {
  private boosts: Map<string, BoostedTopic> = new Map();
  private cleanupInterval: NodeJS.Timeout | null = null;

  // Configuration
  private readonly DEFAULT_DURATION_MINUTES = 5;
  private readonly CLEANUP_INTERVAL_MS = 60 * 1000; // Cleanup every minute
  private readonly MAX_BOOSTS = 100; // Prevent unbounded growth

  constructor() {
    // Start periodic cleanup
    this.startCleanup();
  }

  /**
   * Boost a topic after a high-surprise event
   * @param topic The topic keyword to boost
   * @param options Duration and boost factor
   */
  boost(topic: string, options: BoostOptions = {}): void {
    const {
      duration = this.DEFAULT_DURATION_MINUTES,
      boostFactor = 1.5,
    } = options;

    // Normalize topic (lowercase, trim)
    const normalizedTopic = this.normalizeTopic(topic);

    const expiry = Date.now() + (duration * 60 * 1000);

    // Check if there's an existing boost for this topic
    const existing = this.boosts.get(normalizedTopic);

    // Only update if the new boost is stronger or extends the expiry significantly
    if (!existing || expiry > existing.expiry + 60000 || boostFactor > existing.boostFactor) {
      this.boosts.set(normalizedTopic, {
        topic: normalizedTopic,
        expiry,
        boostFactor: Math.min(boostFactor, 3.0), // Cap at 3x
      });

      logger.debug('MomentumBuffer', `Boosted topic: "${normalizedTopic}"`, {
        duration,
        boostFactor,
        expiry: new Date(expiry).toISOString(),
      });
    }
  }

  /**
   * Boost multiple topics at once
   */
  boostMultiple(topics: string[], options: BoostOptions = {}): void {
    for (const topic of topics) {
      this.boost(topic, options);
    }
  }

  /**
   * Boost topics extracted from a high-surprise memory
   * @param topics Array of topic keywords
   * @param sourceMemoryId ID of the memory causing the boost
   */
  boostFromMemory(topics: string[], sourceMemoryId: number, options: BoostOptions = {}): void {
    const {
      duration = this.DEFAULT_DURATION_MINUTES,
      boostFactor = 1.5,
    } = options;

    for (const topic of topics) {
      const normalizedTopic = this.normalizeTopic(topic);
      const expiry = Date.now() + (duration * 60 * 1000);

      this.boosts.set(normalizedTopic, {
        topic: normalizedTopic,
        expiry,
        boostFactor: Math.min(boostFactor, 3.0),
        sourceMemoryId,
      });
    }

    logger.debug('MomentumBuffer', `Boosted ${topics.length} topics from memory ${sourceMemoryId}`, {
      topics,
      duration,
      boostFactor,
    });
  }

  /**
   * Check if a topic is currently boosted
   * @param topic The topic to check
   */
  isBoosted(topic: string): boolean {
    const normalizedTopic = this.normalizeTopic(topic);
    const boosted = this.boosts.get(normalizedTopic);

    if (!boosted) return false;

    // Check if expired
    if (Date.now() > boosted.expiry) {
      this.boosts.delete(normalizedTopic);
      return false;
    }

    return true;
  }

  /**
   * Get boost status for a topic
   */
  getBoostStatus(topic: string): BoostStatus {
    const normalizedTopic = this.normalizeTopic(topic);
    const boosted = this.boosts.get(normalizedTopic);

    if (!boosted) {
      return {
        isBoosted: false,
        boostFactor: 1.0,
        remainingSeconds: 0,
      };
    }

    // Check if expired
    const now = Date.now();
    if (now > boosted.expiry) {
      this.boosts.delete(normalizedTopic);
      return {
        isBoosted: false,
        boostFactor: 1.0,
        remainingSeconds: 0,
      };
    }

    const remainingSeconds = Math.floor((boosted.expiry - now) / 1000);

    return {
      isBoosted: true,
      boostFactor: boosted.boostFactor,
      remainingSeconds,
      source: boosted,
    };
  }

  /**
   * Get boost factor for a topic (1.0 if not boosted)
   */
  getBoostFactor(topic: string): number {
    const status = this.getBoostStatus(topic);
    return status.boostFactor;
  }

  /**
   * Check if any of the topics are boosted
   * Useful for checking if content matches any boosted topics
   */
  isAnyBoosted(topics: string[]): boolean {
    for (const topic of topics) {
      if (this.isBoosted(topic)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Get the maximum boost factor for a list of topics
   */
  getMaxBoostFactor(topics: string[]): number {
    let maxFactor = 1.0;

    for (const topic of topics) {
      const factor = this.getBoostFactor(topic);
      if (factor > maxFactor) {
        maxFactor = factor;
      }
    }

    return maxFactor;
  }

  /**
   * Get all currently active boosts
   */
  getActiveBoosts(): BoostedTopic[] {
    const now = Date.now();
    const active: BoostedTopic[] = [];
    const expired: string[] = [];

    // First pass: collect active and expired (don't modify during iteration)
    for (const [topic, boost] of this.boosts.entries()) {
      if (now <= boost.expiry) {
        active.push(boost);
      } else {
        expired.push(topic);
      }
    }

    // Second pass: cleanup expired entries
    for (const topic of expired) {
      this.boosts.delete(topic);
    }

    // Sort by expiry (soonest expiring first)
    return active.sort((a, b) => a.expiry - b.expiry);
  }

  /**
   * Clear a specific boost
   */
  clearBoost(topic: string): void {
    const normalizedTopic = this.normalizeTopic(topic);
    this.boosts.delete(normalizedTopic);
  }

  /**
   * Clear all boosts
   */
  clearAll(): void {
    this.boosts.clear();
    logger.debug('MomentumBuffer', 'Cleared all boosts');
  }

  /**
   * Clear expired boosts (also runs periodically)
   */
  cleanup(): number {
    const now = Date.now();
    let cleared = 0;

    for (const [topic, boost] of this.boosts.entries()) {
      if (now > boost.expiry) {
        this.boosts.delete(topic);
        cleared++;
      }
    }

    // Also enforce max limit
    if (this.boosts.size > this.MAX_BOOSTS) {
      // Sort by expiry and remove oldest
      const sorted = Array.from(this.boosts.entries())
        .sort(([, a], [, b]) => a.expiry - b.expiry);

      const toRemove = sorted.slice(0, this.boosts.size - this.MAX_BOOSTS);
      for (const [topic] of toRemove) {
        this.boosts.delete(topic);
        cleared++;
      }
    }

    if (cleared > 0) {
      logger.debug('MomentumBuffer', `Cleaned up ${cleared} expired boosts`);
    }

    return cleared;
  }

  /**
   * Get statistics about current boosts
   */
  getStats(): {
    activeCount: number;
    avgBoostFactor: number;
    avgRemainingMinutes: number;
    topBoosts: BoostedTopic[];
  } {
    const active = this.getActiveBoosts();

    if (active.length === 0) {
      return {
        activeCount: 0,
        avgBoostFactor: 1.0,
        avgRemainingMinutes: 0,
        topBoosts: [],
      };
    }

    const now = Date.now();
    const totalBoost = active.reduce((sum, b) => sum + b.boostFactor, 0);
    const totalRemaining = active.reduce((sum, b) => sum + (b.expiry - now), 0);

    return {
      activeCount: active.length,
      avgBoostFactor: totalBoost / active.length,
      avgRemainingMinutes: (totalRemaining / active.length) / (60 * 1000),
      topBoosts: active
        .sort((a, b) => b.boostFactor - a.boostFactor)
        .slice(0, 10),
    };
  }

  /**
   * Extract topics from text content
   * Simple keyword extraction based on common patterns
   */
  extractTopics(text: string, maxTopics: number = 10): string[] {
    const topics: Set<string> = new Set();

    // Common technical keywords to look for
    const patterns = [
      // File/function/class names
      /([A-Z][a-z]+(?:[A-Z][a-z]+)+)/g, // CamelCase
      /([a-z]+_[a-z_]+)/g, // snake_case
      // Technical terms (common suffixes)
      /\b(\w+(?:module|service|component|handler|controller|utils|helper|config|settings))\b/gi,
      // File extensions
      /\b(\w+\.(?:ts|js|tsx|jsx|py|rs|go|java))\b/gi,
    ];

    for (const pattern of patterns) {
      const matches = text.match(pattern);
      if (matches) {
        for (const match of matches) {
          const topic = this.normalizeTopic(match);
          if (topic.length >= 3 && topic.length <= 50) {
            topics.add(topic);
          }
        }
      }
    }

    // Also look for quoted strings (often important terms)
    const quotedMatches = text.match(/"([^"]{3,30})"/g);
    if (quotedMatches) {
      for (const match of quotedMatches) {
        const topic = match.slice(1, -1).toLowerCase();
        if (topic.length >= 3) {
          topics.add(topic);
        }
      }
    }

    // Convert to array and limit
    return Array.from(topics).slice(0, maxTopics);
  }

  /**
   * Stop the cleanup interval
   */
  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }

  /**
   * Normalize topic string (lowercase, trim)
   */
  private normalizeTopic(topic: string): string {
    return topic.toLowerCase().trim().slice(0, 100); // Limit length
  }

  /**
   * Start periodic cleanup of expired boosts
   */
  private startCleanup(): void {
    this.cleanupInterval = setInterval(() => {
      this.cleanup();
    }, this.CLEANUP_INTERVAL_MS);

    logger.debug('MomentumBuffer', 'Started periodic cleanup');
  }
}

/**
 * Global singleton instance for use across the worker
 */
let globalInstance: MomentumBuffer | null = null;

export function getMomentumBuffer(): MomentumBuffer {
  if (!globalInstance) {
    globalInstance = new MomentumBuffer();
  }
  return globalInstance;
}

export function destroyMomentumBuffer(): void {
  if (globalInstance) {
    globalInstance.destroy();
    globalInstance = null;
  }
}
