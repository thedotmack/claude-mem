/**
 * SupersessionDetector - Detects when newer observations supersede older ones
 *
 * Part of the Sleep Agent system for memory consolidation.
 * Uses semantic similarity (Chroma) combined with metadata heuristics.
 */

import { ChromaSync } from '../sync/ChromaSync.js';
import { SessionStore } from '../sqlite/SessionStore.js';
import { ObservationRow } from '../sqlite/types.js';
import {
  SupersessionCandidate,
  SupersessionResult,
  SupersessionConfig,
  PriorityConfig,
  DEFAULT_PRIORITY_CONFIG,
  getObservationPriority,
  getPriorityTier,
  MemoryTier,
  MemoryTierConfig,
  DEFAULT_MEMORY_TIER_CONFIG,
  MemoryTierClassification,
  LearnedModelConfig,
  DEFAULT_LEARNED_MODEL_CONFIG,
  ModelTrainingResult,
  SupersessionPrediction,
} from '../../types/sleep-agent.js';
import { logger } from '../../utils/logger.js';
import { LearnedSupersessionModel } from './LearnedSupersessionModel.js';

/**
 * Default configuration for supersession detection
 */
const DEFAULT_CONFIG: SupersessionConfig = {
  minSemanticSimilarity: 0.7,
  minConfidence: 0.6,
  sameTypeRequired: true,
  sameProjectRequired: true,
  maxAgeDifferenceHours: 720, // 30 days
};

/**
 * SupersessionDetector class
 * Detects when newer observations supersede older ones based on:
 * - Semantic similarity (via Chroma vector search)
 * - Same observation type (e.g., decision supersedes decision)
 * - File overlap (modifications to same files)
 * - Concept/topic matching
 * - P1: Priority-based ordering and confidence boosting
 */
export class SupersessionDetector {
  private priorityConfig: PriorityConfig;
  private memoryTierConfig: MemoryTierConfig;
  private learnedModel: LearnedSupersessionModel;

  constructor(
    private chromaSync: ChromaSync | null,
    private sessionStore: SessionStore,
    private config: SupersessionConfig = DEFAULT_CONFIG,
    priorityConfig: PriorityConfig = DEFAULT_PRIORITY_CONFIG,
    memoryTierConfig: MemoryTierConfig = DEFAULT_MEMORY_TIER_CONFIG,
    learnedModelConfig: Partial<LearnedModelConfig> = {}
  ) {
    this.priorityConfig = priorityConfig;
    this.memoryTierConfig = memoryTierConfig;
    this.learnedModel = new LearnedSupersessionModel(learnedModelConfig);

    // Load saved weights if available
    this.loadSavedWeights();
  }

  /**
   * Update priority configuration (called during cycle execution)
   */
  setPriorityConfig(config: PriorityConfig): void {
    this.priorityConfig = config;
  }

  /**
   * Update memory tier configuration (called during cycle execution)
   */
  setMemoryTierConfig(config: MemoryTierConfig): void {
    this.memoryTierConfig = config;
  }

  /**
   * Detect supersession relationships in a batch of observations
   * Called during Sleep Cycles to find older observations that may be superseded
   *
   * @param project Project to analyze
   * @param lookbackDays How far back to look for candidate pairs
   * @param limit Maximum observations to process
   * @returns Detection result with candidates
   */
  async detectBatch(
    project: string,
    lookbackDays: number,
    limit: number
  ): Promise<SupersessionResult> {
    const startTime = Date.now();
    const candidates: SupersessionCandidate[] = [];

    // Get recent observations that haven't been superseded
    const cutoffEpoch = Date.now() - (lookbackDays * 24 * 60 * 60 * 1000);
    let observations = this.getActiveObservations(project, cutoffEpoch, limit);

    logger.debug('SLEEP_AGENT', 'Starting supersession detection batch', {
      project,
      lookbackDays,
      observationCount: observations.length,
      priorityEnabled: this.priorityConfig.enabled,
    });

    if (observations.length < 2) {
      return {
        candidates: [],
        processedCount: observations.length,
        duration: Date.now() - startTime,
      };
    }

    // P1: Sort by priority if enabled (high priority first)
    if (this.priorityConfig.enabled && this.priorityConfig.priorityOrdering) {
      observations = [...observations].sort((a, b) => {
        const priorityA = getObservationPriority(a.type);
        const priorityB = getObservationPriority(b.type);
        // Higher priority first, then by creation time (newer first)
        if (priorityA !== priorityB) {
          return priorityB - priorityA;
        }
        return b.created_at_epoch - a.created_at_epoch;
      });

      logger.debug('SLEEP_AGENT', 'Observations sorted by priority', {
        topTypes: observations.slice(0, 5).map(o => o.type),
      });
    }

    // For each observation, check if any newer observations supersede it
    for (let i = 0; i < observations.length; i++) {
      const older = observations[i];

      // Skip if already superseded
      if (older.superseded_by !== null) continue;

      // Find potential superseding observations (newer ones with similar content)
      const newerObs = observations.filter(
        o => o.id > older.id && o.created_at_epoch > older.created_at_epoch
      );

      for (const newer of newerObs) {
        const candidate = await this.checkSupersessionPair(older, newer);
        if (candidate) {
          // P1: Apply priority boost to confidence threshold
          let adjustedThreshold = this.config.minConfidence;
          if (this.priorityConfig.enabled) {
            const boost = candidate.priority * this.priorityConfig.confidenceBoostFactor;
            adjustedThreshold = Math.max(0.3, this.config.minConfidence - boost);
          }

          if (candidate.confidence >= adjustedThreshold) {
            candidates.push(candidate);
          }
        }
      }
    }

    // Sort by priority tier first, then by confidence
    candidates.sort((a, b) => {
      // Higher priority observations first
      if (a.priority !== b.priority) {
        return b.priority - a.priority;
      }
      // Then by confidence
      return b.confidence - a.confidence;
    });

    const result: SupersessionResult = {
      candidates,
      processedCount: observations.length,
      duration: Date.now() - startTime,
    };

    logger.debug('SLEEP_AGENT', 'Supersession detection batch complete', {
      project,
      candidatesFound: candidates.length,
      duration: result.duration,
      byPriorityTier: this.countByPriorityTier(candidates),
    });

    return result;
  }

  /**
   * Count candidates by priority tier
   */
  private countByPriorityTier(candidates: SupersessionCandidate[]): Record<string, number> {
    const counts = { critical: 0, high: 0, medium: 0, low: 0 };
    for (const c of candidates) {
      counts[c.priorityTier]++;
    }
    return counts;
  }

  /**
   * Check if one observation supersedes another
   *
   * @param older The older observation (potential to be superseded)
   * @param newer The newer observation (potential superseder)
   * @returns SupersessionCandidate if supersession detected, null otherwise
   */
  async checkSupersessionPair(
    older: ObservationRow,
    newer: ObservationRow
  ): Promise<SupersessionCandidate | null> {
    // Check type match if required
    if (this.config.sameTypeRequired && older.type !== newer.type) {
      return null;
    }

    // Check project match if required
    if (this.config.sameProjectRequired && older.project !== newer.project) {
      return null;
    }

    // Check age difference
    const ageDiffHours = (newer.created_at_epoch - older.created_at_epoch) / (1000 * 60 * 60);
    if (ageDiffHours > this.config.maxAgeDifferenceHours) {
      return null;
    }

    // Calculate semantic similarity
    const semanticSimilarity = await this.calculateSemanticSimilarity(older, newer);
    if (semanticSimilarity < this.config.minSemanticSimilarity) {
      return null;
    }

    // Calculate topic/concept match
    const topicMatch = this.checkTopicMatch(older, newer);

    // Calculate file overlap
    const fileOverlap = this.calculateFileOverlap(older, newer);

    // Type match score (1.0 if same type, 0.0 otherwise)
    const typeMatch = older.type === newer.type ? 1.0 : 0.0;

    // P1: Get priority information for the newer observation
    const priority = getObservationPriority(newer.type);
    const priorityTier = getPriorityTier(priority);

    // P3: Calculate confidence using learned model
    const features = this.learnedModel.extractFeatures(
      semanticSimilarity,
      topicMatch,
      fileOverlap,
      typeMatch,
      ageDiffHours,
      priority,
      older.reference_count || 0
    );

    const prediction = this.learnedModel.predict(features);
    const confidence = prediction.confidence;

    // Note: minConfidence check is now done in detectBatch with priority adjustment
    // Here we return the candidate with priority info for the caller to decide

    // Generate reason
    const reasons: string[] = [];
    const methodUsed = prediction.usingLearnedWeights ? 'learned' : 'fixed';
    reasons.push(`method: ${methodUsed}`);
    if (semanticSimilarity >= 0.8) reasons.push('high semantic similarity');
    else if (semanticSimilarity >= 0.7) reasons.push('moderate semantic similarity');
    if (topicMatch) reasons.push('matching topics/concepts');
    if (fileOverlap >= 0.5) reasons.push('overlapping files');
    if (typeMatch) reasons.push(`same type (${newer.type})`);
    if (priorityTier === 'critical' || priorityTier === 'high') {
      reasons.push(`${priorityTier} priority`);
    }

    return {
      olderId: older.id,
      newerId: newer.id,
      confidence,
      reason: reasons.join(', '),
      semanticSimilarity,
      topicMatch,
      fileOverlap,
      olderType: older.type,
      newerType: newer.type,
      priority,
      priorityTier,
    };
  }

  /**
   * Calculate semantic similarity between two observations
   * Uses Chroma vector search if available, falls back to text-based heuristics
   */
  private async calculateSemanticSimilarity(
    older: ObservationRow,
    newer: ObservationRow
  ): Promise<number> {
    // Try Chroma first
    if (this.chromaSync) {
      try {
        // Use newer observation's narrative as query
        const queryText = newer.narrative || newer.title || '';
        if (!queryText) return 0;

        // Query for similar documents
        const results = await this.chromaSync.queryChroma(queryText, 50, {
          doc_type: 'observation'
        });

        // Check if older observation is in the results
        const olderIndex = results.ids.indexOf(older.id);
        if (olderIndex === -1) {
          return 0; // Not similar enough to be in top 50
        }

        // Convert distance to similarity (Chroma uses L2 distance)
        // Lower distance = higher similarity
        const distance = results.distances[olderIndex] || 2.0;
        // Normalize: distance of 0 = similarity 1.0, distance of 2.0 = similarity 0.0
        const similarity = Math.max(0, 1 - distance / 2.0);

        return similarity;
      } catch (error) {
        logger.debug('SLEEP_AGENT', 'Chroma query failed, using text fallback', {
          error: (error as Error).message,
        });
      }
    }

    // Fallback: Simple text-based similarity using concept overlap
    return this.calculateTextSimilarity(older, newer);
  }

  /**
   * Calculate text-based similarity as fallback when Chroma is unavailable
   */
  private calculateTextSimilarity(older: ObservationRow, newer: ObservationRow): number {
    // Extract concepts from both
    const olderConcepts = this.parseConcepts(older.concepts);
    const newerConcepts = this.parseConcepts(newer.concepts);

    if (olderConcepts.length === 0 && newerConcepts.length === 0) {
      // Fall back to title similarity
      const olderTitle = (older.title || '').toLowerCase();
      const newerTitle = (newer.title || '').toLowerCase();

      if (!olderTitle || !newerTitle) return 0;

      // Check for significant word overlap
      const olderWords = new Set(olderTitle.split(/\s+/).filter(w => w.length > 3));
      const newerWords = new Set(newerTitle.split(/\s+/).filter(w => w.length > 3));

      if (olderWords.size === 0 || newerWords.size === 0) return 0;

      let overlap = 0;
      for (const word of olderWords) {
        if (newerWords.has(word)) overlap++;
      }

      return overlap / Math.max(olderWords.size, newerWords.size);
    }

    // Calculate Jaccard similarity of concepts
    const olderSet = new Set(olderConcepts.map(c => c.toLowerCase()));
    const newerSet = new Set(newerConcepts.map(c => c.toLowerCase()));

    let intersection = 0;
    for (const concept of olderSet) {
      if (newerSet.has(concept)) intersection++;
    }

    const union = new Set([...olderSet, ...newerSet]).size;
    return union > 0 ? intersection / union : 0;
  }

  /**
   * Check if two observations share topics/concepts
   */
  private checkTopicMatch(older: ObservationRow, newer: ObservationRow): boolean {
    const olderConcepts = this.parseConcepts(older.concepts);
    const newerConcepts = this.parseConcepts(newer.concepts);

    if (olderConcepts.length === 0 || newerConcepts.length === 0) {
      return false;
    }

    // Check for any overlap
    const olderSet = new Set(olderConcepts.map(c => c.toLowerCase()));
    for (const concept of newerConcepts) {
      if (olderSet.has(concept.toLowerCase())) {
        return true;
      }
    }

    return false;
  }

  /**
   * Calculate file overlap between two observations
   * Returns a score from 0 (no overlap) to 1 (complete overlap)
   */
  private calculateFileOverlap(older: ObservationRow, newer: ObservationRow): number {
    const olderFiles = this.parseFiles(older.files_modified);
    const newerFiles = this.parseFiles(newer.files_modified);

    if (olderFiles.length === 0 || newerFiles.length === 0) {
      return 0;
    }

    // Normalize paths for comparison
    const normalize = (path: string) => path.replace(/^\.\//, '').toLowerCase();

    const olderSet = new Set(olderFiles.map(normalize));
    const newerSet = new Set(newerFiles.map(normalize));

    let overlap = 0;
    for (const file of olderSet) {
      if (newerSet.has(file)) overlap++;
    }

    // Return Jaccard similarity
    const union = new Set([...olderSet, ...newerSet]).size;
    return union > 0 ? overlap / union : 0;
  }

  /**
   * Apply supersession: Mark older observation as superseded by newer
   *
   * @param candidate The supersession candidate to apply
   * @param dryRun If true, don't actually update the database
   * @returns true if applied successfully
   */
  async applySupersession(
    candidate: SupersessionCandidate,
    dryRun: boolean = false
  ): Promise<boolean> {
    if (dryRun) {
      logger.debug('SLEEP_AGENT', 'DRY RUN: Would apply supersession', {
        olderId: candidate.olderId,
        newerId: candidate.newerId,
        confidence: candidate.confidence,
        reason: candidate.reason,
      });
      return true;
    }

    try {
      // Update the observation
      this.sessionStore.db.run(
        `UPDATE observations
         SET superseded_by = ?
         WHERE id = ? AND superseded_by IS NULL`,
        candidate.newerId,
        candidate.olderId
      );

      logger.debug('SLEEP_AGENT', 'Applied supersession', {
        olderId: candidate.olderId,
        newerId: candidate.newerId,
        confidence: candidate.confidence,
      });

      return true;
    } catch (error) {
      logger.error('SLEEP_AGENT', 'Failed to apply supersession', {
        olderId: candidate.olderId,
        newerId: candidate.newerId,
      }, error as Error);
      return false;
    }
  }

  /**
   * Get observations that are active (not deprecated, not superseded)
   */
  private getActiveObservations(
    project: string,
    afterEpoch: number,
    limit: number
  ): ObservationRow[] {
    return this.sessionStore.db.prepare(`
      SELECT * FROM observations
      WHERE project = ?
        AND created_at_epoch > ?
        AND deprecated = 0
        AND superseded_by IS NULL
      ORDER BY created_at_epoch ASC
      LIMIT ?
    `).all(project, afterEpoch, limit) as ObservationRow[];
  }

  /**
   * Get observations that have been superseded but not yet deprecated
   */
  getSupersededObservations(
    project: string,
    limit: number = 100
  ): ObservationRow[] {
    return this.sessionStore.db.prepare(`
      SELECT * FROM observations
      WHERE project = ?
        AND superseded_by IS NOT NULL
        AND deprecated = 0
      ORDER BY created_at_epoch DESC
      LIMIT ?
    `).all(project, limit) as ObservationRow[];
  }

  /**
   * Mark observation as deprecated
   *
   * @param observationId The observation to deprecate
   * @param reason Why it's being deprecated
   * @returns true if deprecated successfully
   */
  deprecateObservation(
    observationId: number,
    reason: string
  ): boolean {
    try {
      this.sessionStore.db.run(
        `UPDATE observations
         SET deprecated = 1, deprecated_at = ?, deprecation_reason = ?
         WHERE id = ?`,
        Date.now(),
        reason,
        observationId
      );
      return true;
    } catch (error) {
      logger.error('SLEEP_AGENT', 'Failed to deprecate observation', {
        observationId,
      }, error as Error);
      return false;
    }
  }

  /**
   * Parse JSON array of concepts, returning empty array on error
   */
  private parseConcepts(conceptsJson: string | null | undefined): string[] {
    if (!conceptsJson) return [];
    try {
      const parsed = JSON.parse(conceptsJson);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  /**
   * Parse JSON array of files, returning empty array on error
   */
  private parseFiles(filesJson: string | null | undefined): string[] {
    if (!filesJson) return [];
    try {
      const parsed = JSON.parse(filesJson);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  /**
   * Detect supersession for a specific session's observations (micro cycle)
   * Compares new session observations against recent observations in the same project.
   * Uses priority-based ordering and confidence boosting.
   *
   * @param claudeSessionId The session to process
   * @param lookbackDays How far back to look for existing observations
   * @returns Detection result with candidates
   */
  async detectForSession(
    claudeSessionId: string,
    lookbackDays: number = 7
  ): Promise<SupersessionResult> {
    const startTime = Date.now();
    const candidates: SupersessionCandidate[] = [];

    // Get observations from this session
    let sessionObs = this.sessionStore.db.prepare(`
      SELECT o.* FROM observations o
      JOIN sdk_sessions s ON o.sdk_session_id = s.id
      WHERE s.claude_session_id = ?
        AND o.deprecated = 0
        AND o.superseded_by IS NULL
      ORDER BY o.created_at_epoch ASC
    `).all(claudeSessionId) as ObservationRow[];

    if (sessionObs.length === 0) {
      return {
        candidates: [],
        processedCount: 0,
        duration: Date.now() - startTime,
      };
    }

    // P1: Sort session observations by priority (high priority first)
    if (this.priorityConfig.enabled && this.priorityConfig.priorityOrdering) {
      sessionObs = [...sessionObs].sort((a, b) => {
        const priorityA = getObservationPriority(a.type);
        const priorityB = getObservationPriority(b.type);
        if (priorityA !== priorityB) {
          return priorityB - priorityA;
        }
        return b.created_at_epoch - a.created_at_epoch;
      });
    }

    // Get the project from session observations
    const project = sessionObs[0].project;
    const cutoffEpoch = Date.now() - (lookbackDays * 24 * 60 * 60 * 1000);

    // Get recent observations from the same project (excluding this session)
    const sessionIds = new Set(sessionObs.map(o => o.id));
    const recentObs = this.sessionStore.db.prepare(`
      SELECT * FROM observations
      WHERE project = ?
        AND created_at_epoch > ?
        AND deprecated = 0
        AND superseded_by IS NULL
      ORDER BY created_at_epoch ASC
    `).all(project, cutoffEpoch) as ObservationRow[];

    // Filter out observations from the current session
    const existingObs = recentObs.filter(o => !sessionIds.has(o.id));

    logger.debug('SLEEP_AGENT', 'Starting micro cycle supersession detection', {
      claudeSessionId,
      sessionObsCount: sessionObs.length,
      existingObsCount: existingObs.length,
      project,
      priorityEnabled: this.priorityConfig.enabled,
    });

    // For each new session observation, check if it supersedes any existing observation
    for (const newObs of sessionObs) {
      for (const oldObs of existingObs) {
        // New observation must be newer
        if (newObs.created_at_epoch <= oldObs.created_at_epoch) continue;

        const candidate = await this.checkSupersessionPair(oldObs, newObs);
        if (candidate) {
          // P1: Apply priority boost to confidence threshold
          let adjustedThreshold = this.config.minConfidence;
          if (this.priorityConfig.enabled) {
            const boost = candidate.priority * this.priorityConfig.confidenceBoostFactor;
            adjustedThreshold = Math.max(0.3, this.config.minConfidence - boost);
          }

          if (candidate.confidence >= adjustedThreshold) {
            candidates.push(candidate);
          }
        }
      }
    }

    // Sort by priority tier first, then by confidence
    candidates.sort((a, b) => {
      if (a.priority !== b.priority) {
        return b.priority - a.priority;
      }
      return b.confidence - a.confidence;
    });

    const result: SupersessionResult = {
      candidates,
      processedCount: sessionObs.length,
      duration: Date.now() - startTime,
    };

    logger.debug('SLEEP_AGENT', 'Micro cycle supersession detection complete', {
      claudeSessionId,
      candidatesFound: candidates.length,
      duration: result.duration,
      byPriorityTier: this.countByPriorityTier(candidates),
    });

    return result;
  }

  // ============================================================================
  // P2: Memory Tier Classification (CMS - Continuum Memory Systems)
  // ============================================================================

  /**
   * Classify an observation into a memory tier based on multiple factors
   * Inspired by Nested Learning's Continuum Memory Systems
   *
   * @param observation The observation to classify
   * @returns Memory tier classification result
   */
  classifyMemoryTier(observation: ObservationRow): MemoryTierClassification {
    const now = Date.now();
    const daysSinceCreation = (now - observation.created_at_epoch) / (24 * 60 * 60 * 1000);
    const daysSinceLastAccess = observation.last_accessed_at
      ? (now - observation.last_accessed_at) / (24 * 60 * 60 * 1000)
      : daysSinceCreation;
    const referenceCount = observation.reference_count || 0;
    const isSuperseded = observation.superseded_by !== null;
    const isDeprecated = observation.deprecated === 1;

    // Core tier: Highly referenced, critical decisions
    if (referenceCount >= this.memoryTierConfig.coreReferenceThreshold) {
      return {
        observationId: observation.id,
        tier: 'core',
        reason: `Referenced ${referenceCount}+ times`,
        confidence: 0.9,
        factors: {
          type: observation.type,
          referenceCount,
          daysSinceCreation,
          daysSinceLastAccess,
          superseded: isSuperseded,
        },
      };
    }

    // Deprecated or long-term superseded observations become ephemeral
    if (isDeprecated || daysSinceLastAccess > this.memoryTierConfig.archiveToEphemeralDays) {
      return {
        observationId: observation.id,
        tier: 'ephemeral',
        reason: isDeprecated ? 'Marked as deprecated' : `Not accessed for ${Math.floor(daysSinceLastAccess)} days`,
        confidence: 0.85,
        factors: {
          type: observation.type,
          referenceCount,
          daysSinceCreation,
          daysSinceLastAccess,
          superseded: isSuperseded,
        },
      };
    }

    // Superseded or not accessed for a while -> archive
    if (isSuperseded || daysSinceLastAccess > this.memoryTierConfig.workingToArchiveDays) {
      return {
        observationId: observation.id,
        tier: 'archive',
        reason: isSuperseded ? 'Superseded by newer observation' : `Idle for ${Math.floor(daysSinceLastAccess)} days`,
        confidence: 0.8,
        factors: {
          type: observation.type,
          referenceCount,
          daysSinceCreation,
          daysSinceLastAccess,
          superseded: isSuperseded,
        },
      };
    }

    // Default: working tier
    return {
      observationId: observation.id,
      tier: 'working',
      reason: 'Actively used',
      confidence: 0.7,
      factors: {
        type: observation.type,
        referenceCount,
        daysSinceCreation,
        daysSinceLastAccess,
        superseded: isSuperseded,
      },
    };
  }

  /**
   * Apply memory tier classification to an observation
   *
   * @param classification The classification result to apply
   * @returns true if applied successfully
   */
  applyMemoryTierClassification(classification: MemoryTierClassification): boolean {
    try {
      this.sessionStore.db.run(
        `UPDATE observations
         SET memory_tier = ?, memory_tier_updated_at = ?
         WHERE id = ?`,
        classification.tier,
        Date.now(),
        classification.observationId
      );

      logger.debug('SLEEP_AGENT', 'Applied memory tier classification', {
        observationId: classification.observationId,
        tier: classification.tier,
        reason: classification.reason,
      });

      return true;
    } catch (error) {
      logger.error('SLEEP_AGENT', 'Failed to apply memory tier classification', {
        observationId: classification.observationId,
      }, error as Error);
      return false;
    }
  }

  /**
   * Batch classify memory tiers for a project
   *
   * @param project The project to classify
   * @returns Number of classifications updated
   */
  batchClassifyMemoryTiers(project: string): number {
    if (!this.memoryTierConfig.enabled || !this.memoryTierConfig.reclassifyOnSleepCycle) {
      return 0;
    }

    // Get all non-deprecated observations for this project
    const observations = this.sessionStore.db.prepare(`
      SELECT * FROM observations
      WHERE project = ? AND deprecated = 0
    `).all(project) as ObservationRow[];

    let updated = 0;

    for (const obs of observations) {
      const classification = this.classifyMemoryTier(obs);

      // Only update if tier would change
      if (obs.memory_tier !== classification.tier) {
        const applied = this.applyMemoryTierClassification(classification);
        if (applied) updated++;
      }
    }

    logger.debug('SLEEP_AGENT', 'Memory tier batch classification complete', {
      project,
      totalObservations: observations.length,
      tierUpdates: updated,
    });

    return updated;
  }

  /**
   * Get observations by memory tier
   *
   * @param project The project to query
   * @param tier The memory tier to filter by
   * @returns Array of observations in the specified tier
   */
  getObservationsByMemoryTier(
    project: string,
    tier: MemoryTier,
    limit: number = 100
  ): ObservationRow[] {
    return this.sessionStore.db.prepare(`
      SELECT * FROM observations
      WHERE project = ? AND memory_tier = ? AND deprecated = 0
      ORDER BY created_at_epoch DESC
      LIMIT ?
    `).all(project, tier, limit) as ObservationRow[];
  }

  /**
   * Update reference count for an observation
   * Called when an observation is referenced (e.g., via supersession)
   *
   * @param observationId The observation to update
   */
  incrementReferenceCount(observationId: number): void {
    this.sessionStore.db.run(
      `UPDATE observations
       SET reference_count = COALESCE(reference_count, 0) + 1,
           last_accessed_at = ?
       WHERE id = ?`,
      Date.now(),
      observationId
    );
  }

  /**
   * Update last accessed time for an observation
   *
   * @param observationId The observation to update
   */
  updateLastAccessed(observationId: number): void {
    this.sessionStore.db.run(
      `UPDATE observations SET last_accessed_at = ? WHERE id = ?`,
      Date.now(),
      observationId
    );
  }

  /**
   * Get memory tier statistics for a project
   *
   * @param project The project to query
   * @returns Statistics by tier
   */
  getMemoryTierStats(project: string): Record<MemoryTier, number> {
    const rows = this.sessionStore.db.prepare(`
      SELECT memory_tier, COUNT(*) as count
      FROM observations
      WHERE project = ? AND deprecated = 0
      GROUP BY memory_tier
    `).all(project) as { memory_tier: string; count: number }[];

    const stats: Record<MemoryTier, number> = {
      core: 0,
      working: 0,
      archive: 0,
      ephemeral: 0,
    };

    for (const row of rows) {
      const tier = row.memory_tier as MemoryTier;
      if (tier in stats) {
        stats[tier] = row.count;
      }
    }

    return stats;
  }

  // ============================================================================
  // P3: Learned Supersession Model (Regression Model)
  // ============================================================================

  /**
   * Record a training example when user feedback is received
   *
   * @param olderObservationId The older observation that was superseded
   * @param newerObservationId The newer observation that superseded
   * @param features Features used for prediction
   * @param label True if supersession was accepted, false if rejected
   * @param confidence Confidence score that was used
   */
  recordTrainingExample(
    olderObservationId: number,
    newerObservationId: number,
    features: Parameters<LearnedSupersessionModel['extractFeatures']>,
    label: boolean,
    confidence: number
  ): void {
    const featureVector = this.learnedModel.extractFeatures(...features);

    // Add to in-memory model
    this.learnedModel.addTrainingExample(featureVector, label, confidence);

    // Persist to database for training across restarts
    try {
      this.sessionStore.db.run(`
        INSERT INTO supersession_training (
          older_observation_id, newer_observation_id,
          semantic_similarity, topic_match, file_overlap, type_match,
          time_delta_hours, priority_score, older_reference_count,
          label, confidence, created_at_epoch
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, olderObservationId, newerObservationId,
        featureVector.semanticSimilarity,
        featureVector.topicMatch ? 1 : 0,
        featureVector.fileOverlap,
        featureVector.typeMatch,
        featureVector.timeDeltaHours,
        featureVector.priorityScore,
        featureVector.olderReferenceCount,
        label ? 1 : 0,
        confidence,
        Date.now()
      );
    } catch (error) {
      logger.debug('SLEEP_AGENT', 'Failed to save training example', {
        olderObservationId,
        newerObservationId,
      }, error as Error);
    }
  }

  /**
   * Train the learned model on collected examples
   *
   * @returns Training result with metrics
   */
  trainLearnedModel(): ModelTrainingResult {
    const result = this.learnedModel.train();

    // Save trained weights to database
    this.saveWeights(result);

    logger.debug('SLEEP_AGENT', 'Learned model training complete', {
      examplesUsed: result.examplesUsed,
      loss: result.loss,
      accuracy: result.accuracy,
    });

    return result;
  }

  /**
   * Get training statistics and model status
   */
  getLearnedModelStats(): {
    config: LearnedModelConfig;
    weights: ReturnType<LearnedSupersessionModel['getWeights']>;
    stats: ReturnType<LearnedSupersessionModel['getTrainingStats']>;
    recentExamples: number;
  } {
    // Count examples in database
    const recentCount = this.sessionStore.db.prepare(`
      SELECT COUNT(*) as count FROM supersession_training
      WHERE created_at_epoch > ?
    `).get(Date.now() - 30 * 24 * 60 * 60 * 1000) as { count: number };

    return {
      config: this.learnedModel.getConfig(),
      weights: this.learnedModel.getWeights(),
      stats: this.learnedModel.getTrainingStats(),
      recentExamples: recentCount.count,
    };
  }

  /**
   * Enable or disable the learned model
   */
  setLearnedModelEnabled(enabled: boolean): void {
    this.learnedModel.updateConfig({ enabled });
  }

  /**
   * Reset the model to initial weights
   */
  resetLearnedModel(): void {
    this.learnedModel.resetWeights();
    logger.debug('SLEEP_AGENT', 'Learned model reset to initial weights');
  }

  /**
   * Load saved weights from database
   */
  private loadSavedWeights(): void {
    try {
      const row = this.sessionStore.db.prepare(`
        SELECT * FROM learned_model_weights
        ORDER BY trained_at_epoch DESC
        LIMIT 1
      `).get() as {
        weight_semantic_similarity: number;
        weight_topic_match: number;
        weight_file_overlap: number;
        weight_type_match: number;
        weight_time_decay: number;
        weight_priority_boost: number;
        weight_reference_decay: number;
        weight_bias: number;
      } | undefined;

      if (row) {
        this.learnedModel.setWeights({
          semanticSimilarity: row.weight_semantic_similarity,
          topicMatch: row.weight_topic_match,
          fileOverlap: row.weight_file_overlap,
          typeMatch: row.weight_type_match,
          timeDecay: row.weight_time_decay,
          priorityBoost: row.weight_priority_boost,
          referenceDecay: row.weight_reference_decay,
          bias: row.weight_bias,
        });
        logger.debug('SLEEP_AGENT', 'Loaded saved model weights from database');
      }
    } catch (error) {
      // Table might not exist yet, ignore
      logger.debug('SLEEP_AGENT', 'No saved weights found, using initial weights');
    }
  }

  /**
   * Save weights to database after training
   */
  private saveWeights(result: ModelTrainingResult): void {
    try {
      const weights = result.weights;

      this.sessionStore.db.run(`
        INSERT INTO learned_model_weights (
          weight_semantic_similarity, weight_topic_match, weight_file_overlap,
          weight_type_match, weight_time_decay, weight_priority_boost,
          weight_reference_decay, weight_bias,
          trained_at_epoch, examples_used, loss, accuracy
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, weights.semanticSimilarity, weights.topicMatch, weights.fileOverlap,
        weights.typeMatch, weights.timeDecay, weights.priorityBoost,
        weights.referenceDecay, weights.bias,
        result.timestamp, result.examplesUsed, result.loss, result.accuracy
      );
    } catch (error) {
      logger.debug('SLEEP_AGENT', 'Failed to save model weights', {}, error as Error);
    }
  }

  /**
   * Generate training examples from existing supersession relationships
   * This allows the model to learn from historical supersession decisions
   *
   * @param project Optional project filter
   * @param limit Maximum number of examples to generate
   * @returns Number of training examples generated
   */
  async generateTrainingDataFromExistingSupersessions(
    project?: string,
    limit: number = 1000
  ): Promise<number> {
    // Get existing supersession pairs
    const query = `
      SELECT
        o1.id as older_id, o1.type as older_type, o1.narrative as older_narrative,
        o1.title as older_title, o1.files_modified as older_files, o1.concepts as older_concepts,
        o1.access_count as older_ref_count, o1.created_at_epoch as older_created,
        o2.id as newer_id, o2.type as newer_type, o2.narrative as newer_narrative,
        o2.title as newer_title, o2.files_modified as newer_files, o2.concepts as newer_concepts,
        o2.created_at_epoch as newer_created
      FROM observations o1
      JOIN observations o2 ON o1.superseded_by = o2.id
      WHERE o1.deprecated = 0
        ${project ? 'AND o1.project = ?' : ''}
      ORDER BY o1.created_at_epoch DESC
      LIMIT ?
    `;

    const rows = this.sessionStore.db.prepare(query)
      .all(...(project ? [project, limit] : [limit])) as Array<{
        older_id: number;
        older_type: string;
        older_narrative: string;
        older_title: string;
        older_files: string;
        older_concepts: string;
        older_ref_count: number;
        older_created: number;
        newer_id: number;
        newer_type: string;
        newer_narrative: string;
        newer_title: string;
        newer_files: string;
        newer_concepts: string;
        newer_created: number;
      }>;

    let generated = 0;

    for (const row of rows) {
      try {
        // Calculate features (same as in detectSupersession)
        const semanticSimilarity = await this.calculateSemanticSimilarity(
          { id: row.older_id, narrative: row.older_narrative, title: row.older_title } as ObservationRow,
          { id: row.newer_id, narrative: row.newer_narrative, title: row.newer_title } as ObservationRow
        );

        const topicMatch = this.checkTopicMatch(
          { concepts: row.older_concepts } as ObservationRow,
          { concepts: row.newer_concepts } as ObservationRow
        );

        const fileOverlap = this.calculateFileOverlap(
          { files_modified: row.older_files } as ObservationRow,
          { files_modified: row.newer_files } as ObservationRow
        );

        const typeMatch = row.older_type === row.newer_type ? 1.0 : 0.0;
        const timeDeltaHours = (row.newer_created - row.older_created) / 3600000;
        const priority = getObservationPriority(row.newer_type);

        // Record as positive training example (label = true, supersession was valid)
        this.recordTrainingExample(
          row.older_id,
          row.newer_id,
          [semanticSimilarity, topicMatch, fileOverlap, typeMatch, timeDeltaHours, priority, row.older_ref_count],
          true,  // label = true (valid supersession)
          0.8    // assume high confidence for historical data
        );

        generated++;
      } catch (error) {
        // Skip failed examples
        logger.debug('SLEEP_AGENT', 'Failed to generate training example', {
          older_id: row.older_id,
          newer_id: row.newer_id,
        }, error as Error);
      }
    }

    logger.debug('SLEEP_AGENT', 'Generated training examples from existing supersessions', {
      project,
      total: rows.length,
      generated,
    });

    return generated;
  }
}
