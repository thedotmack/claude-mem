/**
 * Working Memory Tier Service - P1 Feature
 *
 * Implements a two-tier memory system inspired by MemOS:
 * - Working Memory: Fast access, limited capacity (20 items)
 * - Long-term Memory: Persistent, searchable via SQLite/Chroma
 *
 * Working memory acts as a cache for recently accessed observations,
 * improving retrieval speed and reducing database queries.
 *
 * Key Features:
 * - Automatic working memory management (LRU eviction)
 * - Fast in-memory search before database query
 * - Seamless fallback to long-term memory
 * - Periodic compression of working memory to long-term
 */

import { logger } from '../../utils/logger.js';
import type { ObservationSearchResult } from '../sqlite/types.js';

export interface WorkingMemoryItem {
  id: number;
  data: ObservationSearchResult;
  accessedAt: number;
  accessCount: number;
}

export interface WorkingMemoryConfig {
  maxSize: number;
  compressionThreshold: number;
  compressionInterval: number; // milliseconds
}

export interface SearchOptions {
  query?: string;
  limit?: number;
  type?: string;
  project?: string;
}

export class WorkingMemoryService {
  private workingMemory: Map<number, WorkingMemoryItem> = new Map();
  private accessOrder: number[] = [];
  private lastCompressedAt: number = Date.now();
  private config: WorkingMemoryConfig = {
    maxSize: 20,
    compressionThreshold: 15,
    compressionInterval: 5 * 60 * 1000 // 5 minutes
  };

  constructor(config?: Partial<WorkingMemoryConfig>) {
    if (config) {
      this.config = { ...this.config, ...config };
    }
    logger.info('WORKING_MEMORY', 'Initialized', { config: this.config });
  }

  /**
   * Add or update an item in working memory
   * Implements LRU eviction when capacity is exceeded
   */
  addToWorkingMemory(item: ObservationSearchResult): void {
    const id = item.id;
    const now = Date.now();

    // Check if item already exists
    const existing = this.workingMemory.get(id);
    if (existing) {
      // Update access time and count
      existing.accessedAt = now;
      existing.accessCount++;
      existing.data = item; // Update with fresh data

      // Move to end of access order (most recently used)
      this.accessOrder = this.accessOrder.filter(x => x !== id);
      this.accessOrder.push(id);
    } else {
      // Add new item
      this.workingMemory.set(id, {
        id,
        data: item,
        accessedAt: now,
        accessCount: 1
      });
      this.accessOrder.push(id);

      // Check capacity
      this.evictIfNeeded();
    }

    logger.debug('WORKING_MEMORY', 'Item added/updated', {
      id,
      size: this.workingMemory.size,
      capacity: this.config.maxSize
    });
  }

  /**
   * Get an item from working memory by ID
   */
  getFromWorkingMemory(id: number): ObservationSearchResult | null {
    const item = this.workingMemory.get(id);
    if (!item) {
      return null;
    }

    // Update access statistics
    item.accessedAt = Date.now();
    item.accessCount++;

    // Move to end of access order
    this.accessOrder = this.accessOrder.filter(x => x !== id);
    this.accessOrder.push(id);

    return item.data;
  }

  /**
   * Search working memory for items matching the query
   * Returns items ranked by relevance (simple keyword matching)
   */
  searchWorkingMemory(query: string, options: SearchOptions = {}): ObservationSearchResult[] {
    if (this.workingMemory.size === 0) {
      return [];
    }

    const results: Array<{ item: ObservationSearchResult; score: number }> = [];
    const queryLower = query.toLowerCase();
    const queryWords = queryLower.split(/\s+/).filter(w => w.length > 2);

    // Score each item based on keyword matches
    for (const [id, memItem] of this.workingMemory) {
      let score = 0;
      const item = memItem.data;

      // Check title match
      if (item.title) {
        const titleLower = item.title.toLowerCase();
        if (titleLower.includes(queryLower)) {
          score += 10;
        }
        for (const word of queryWords) {
          if (titleLower.includes(word)) {
            score += 2;
          }
        }
      }

      // Check narrative match
      if (item.narrative) {
        const narrativeLower = item.narrative.toLowerCase();
        if (narrativeLower.includes(queryLower)) {
          score += 5;
        }
        for (const word of queryWords) {
          if (narrativeLower.includes(word)) {
            score += 1;
          }
        }
      }

      // Check concepts match
      if (item.concepts && Array.isArray(item.concepts)) {
        for (const concept of item.concepts) {
          if (concept.toLowerCase().includes(queryLower) || queryLower.includes(concept.toLowerCase())) {
            score += 3;
          }
        }
      }

      // Boost frequently accessed items
      score += Math.min(memItem.accessCount * 0.5, 5);

      // Apply type filter if specified
      if (options.type && item.type !== options.type) {
        continue;
      }

      // Apply project filter if specified
      if (options.project && item.project !== options.project) {
        continue;
      }

      if (score > 0) {
        results.push({ item, score });
      }
    }

    // Sort by score (descending) and apply limit
    results.sort((a, b) => b.score - a.score);
    const limited = results.slice(0, options.limit || 10);

    logger.debug('WORKING_MEMORY', 'Search completed', {
      query,
      resultsCount: limited.length,
      totalSize: this.workingMemory.size
    });

    return limited.map(r => r.item);
  }

  /**
   * Remove least recently used items when capacity is exceeded
   */
  private evictIfNeeded(): void {
    while (this.workingMemory.size > this.config.maxSize && this.accessOrder.length > 0) {
      const lruId = this.accessOrder.shift()!;
      const removed = this.workingMemory.delete(lruId);

      if (removed) {
        logger.debug('WORKING_MEMORY', 'Evicted LRU item', {
          id: lruId,
          remainingSize: this.workingMemory.size
        });
      }
    }
  }

  /**
   * Remove a specific item from working memory
   */
  removeFromWorkingMemory(id: number): boolean {
    this.accessOrder = this.accessOrder.filter(x => x !== id);
    return this.workingMemory.delete(id);
  }

  /**
   * Clear all working memory
   */
  clearWorkingMemory(): void {
    this.workingMemory.clear();
    this.accessOrder = [];
    logger.info('WORKING_MEMORY', 'Working memory cleared');
  }

  /**
   * Get current working memory statistics
   */
  getStats(): {
    size: number;
    capacity: number;
    utilization: number;
    topAccessed: Array<{ id: number; accessCount: number }>;
  } {
    const topAccessed = Array.from(this.workingMemory.values())
      .sort((a, b) => b.accessCount - a.accessCount)
      .slice(0, 5)
      .map(item => ({ id: item.id, accessCount: item.accessCount }));

    return {
      size: this.workingMemory.size,
      capacity: this.config.maxSize,
      utilization: this.workingMemory.size / this.config.maxSize,
      topAccessed
    };
  }

  /**
   * Check if compression is needed
   * Returns true if working memory is above threshold and enough time has passed
   */
  needsCompression(): boolean {
    const now = Date.now();
    const timeSinceLastCompression = now - this.lastCompressedAt;
    const isAboveThreshold = this.workingMemory.size >= this.config.compressionThreshold;
    const isTimeToCompress = timeSinceLastCompression >= this.config.compressionInterval;

    return isAboveThreshold && isTimeToCompress;
  }

  /**
   * Get items that should be compressed to long-term memory
   * Returns least recently used items above threshold
   */
  getItemsToCompress(): ObservationSearchResult[] {
    if (this.workingMemory.size <= this.config.compressionThreshold) {
      return [];
    }

    // Get items to compress (LRU items above threshold)
    const toCompress: ObservationSearchResult[] = [];
    const targetSize = this.config.compressionThreshold - 5; // Leave some buffer

    while (this.workingMemory.size > targetSize && this.accessOrder.length > 0) {
      const lruId = this.accessOrder.shift()!;
      const item = this.workingMemory.get(lruId);
      if (item) {
        toCompress.push(item.data);
        this.workingMemory.delete(lruId);
      }
    }

    this.lastCompressedAt = Date.now();
    logger.info('WORKING_MEMORY', 'Items selected for compression', {
      count: toCompress.length,
      remainingSize: this.workingMemory.size
    });

    return toCompress;
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<WorkingMemoryConfig>): void {
    const oldMaxSize = this.config.maxSize;
    this.config = { ...this.config, ...config };

    // If max size decreased, evict excess items
    if (this.config.maxSize < oldMaxSize) {
      this.evictIfNeeded();
    }

    logger.info('WORKING_MEMORY', 'Configuration updated', { config: this.config });
  }

  /**
   * Get current configuration
   */
  getConfig(): WorkingMemoryConfig {
    return { ...this.config };
  }

  /**
   * Export working memory contents (for debugging/analysis)
   */
  exportContents(): Array<{
    id: number;
    title: string;
    type: string;
    accessedAt: Date;
    accessCount: number;
  }> {
    return Array.from(this.workingMemory.values()).map(item => ({
      id: item.id,
      title: item.data.title || 'Untitled',
      type: item.data.type || 'unknown',
      accessedAt: new Date(item.accessedAt),
      accessCount: item.accessCount
    }));
  }
}

