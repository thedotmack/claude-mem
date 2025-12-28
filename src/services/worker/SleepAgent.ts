/**
 * SleepAgent - Background memory consolidation system
 *
 * Inspired by Titans paper: consolidates memory during idle periods.
 * Runs sleep cycles that detect supersession relationships and deprecate old memories.
 */

import { SupersessionDetector } from './SupersessionDetector.js';
import { ChromaSync } from '../sync/ChromaSync.js';
import { SessionStore } from '../sqlite/SessionStore.js';
import {
  SleepCycleType,
  SleepCycleConfig,
  SleepCycleResult,
  SleepAgentStatus,
  IdleState,
  IdleConfig,
  SleepCycleRow,
  ChainDetectionResult,
  SLEEP_CYCLE_DEFAULTS,
  DEFAULT_IDLE_CONFIG,
  DEFAULT_PRIORITY_CONFIG,
  DEFAULT_MEMORY_TIER_CONFIG,
  MemoryTierConfig,
  getPriorityTier,
  MIN_LIGHT_CYCLE_INTERVAL_MS,
  MIN_DEEP_CYCLE_INTERVAL_MS,
} from '../../types/sleep-agent.js';
import { logger } from '../../utils/logger.js';

/**
 * SleepAgent - Singleton class for managing memory consolidation
 *
 * Lifecycle:
 * 1. Created by worker service on startup
 * 2. Starts idle detection (monitors for inactivity)
 * 3. When idle threshold reached, triggers sleep cycle
 * 4. Sleep cycles detect supersession and deprecate old memories
 */
export class SleepAgent {
  private static instance: SleepAgent | null = null;

  private supersessionDetector: SupersessionDetector;
  private idleConfig: IdleConfig;
  private idleCheckInterval: NodeJS.Timeout | null = null;
  private lastActivityAt: number = Date.now();
  private isRunning: boolean = false;
  private activeSessions: Set<string> = new Set();
  private lastCycle: SleepCycleResult | null = null;
  private stats = {
    totalCycles: 0,
    totalSupersessions: 0,
    totalDeprecated: 0,
  };

  private constructor(
    private chromaSync: ChromaSync | null,
    private sessionStore: SessionStore,
    idleConfig: Partial<IdleConfig> = {}
  ) {
    this.idleConfig = { ...DEFAULT_IDLE_CONFIG, ...idleConfig };
    this.supersessionDetector = new SupersessionDetector(
      chromaSync,
      sessionStore
    );
  }

  /**
   * Get or create the SleepAgent singleton
   */
  static getInstance(
    chromaSync: ChromaSync | null,
    sessionStore: SessionStore,
    idleConfig: Partial<IdleConfig> = {}
  ): SleepAgent {
    if (!SleepAgent.instance) {
      SleepAgent.instance = new SleepAgent(chromaSync, sessionStore, idleConfig);
    }
    return SleepAgent.instance;
  }

  /**
   * Reset the singleton (for testing)
   */
  static resetInstance(): void {
    if (SleepAgent.instance) {
      SleepAgent.instance.stopIdleDetection();
      SleepAgent.instance = null;
    }
  }

  /**
   * Record activity - resets idle timer
   * Call this whenever there's user/session activity
   */
  recordActivity(): void {
    this.lastActivityAt = Date.now();
  }

  /**
   * Register an active session
   */
  registerSession(sessionId: string): void {
    this.activeSessions.add(sessionId);
    this.recordActivity();
  }

  /**
   * Unregister a session (completed or failed)
   */
  unregisterSession(sessionId: string): void {
    this.activeSessions.delete(sessionId);
    this.recordActivity();
  }

  /**
   * Start idle detection
   * Monitors for inactivity and triggers sleep cycles
   */
  startIdleDetection(): void {
    if (this.idleCheckInterval) {
      return; // Already running
    }

    this.isRunning = true;
    this.lastActivityAt = Date.now();

    logger.debug('SLEEP_AGENT', 'Starting idle detection', {
      lightSleepAfterMs: this.idleConfig.lightSleepAfterMs,
      deepSleepAfterMs: this.idleConfig.deepSleepAfterMs,
      checkIntervalMs: this.idleConfig.checkIntervalMs,
    });

    this.idleCheckInterval = setInterval(
      () => this.checkIdleState(),
      this.idleConfig.checkIntervalMs
    );
  }

  /**
   * Stop idle detection
   */
  stopIdleDetection(): void {
    if (this.idleCheckInterval) {
      clearInterval(this.idleCheckInterval);
      this.idleCheckInterval = null;
    }
    this.isRunning = false;

    logger.debug('SLEEP_AGENT', 'Stopped idle detection', {});
  }

  /**
   * Check current idle state and trigger sleep cycle if appropriate
   */
  private async checkIdleState(): Promise<void> {
    const idleState = this.getIdleState();

    // Don't run if there are active sessions (if configured)
    if (this.idleConfig.requireNoActiveSessions && idleState.activeSessions > 0) {
      return;
    }

    // Check for deep sleep threshold
    if (idleState.idleDurationMs >= this.idleConfig.deepSleepAfterMs) {
      await this.runCycleIfNotBusy('deep');
      // Reset timer after deep sleep to prevent immediate re-trigger
      this.recordActivity();
      return;
    }

    // Check for light sleep threshold
    if (idleState.idleDurationMs >= this.idleConfig.lightSleepAfterMs) {
      await this.runCycleIfNotBusy('light');
      // Don't reset timer - allow escalation to deep sleep
    }
  }

  /**
   * Run a sleep cycle if not already running one
   */
  private async runCycleIfNotBusy(type: SleepCycleType): Promise<void> {
    // Check if we recently ran a cycle of this type
    if (this.lastCycle && this.lastCycle.type === type) {
      const timeSinceLast = Date.now() - this.lastCycle.completedAt;
      const minInterval = type === 'light' ? MIN_LIGHT_CYCLE_INTERVAL_MS : MIN_DEEP_CYCLE_INTERVAL_MS;
      if (timeSinceLast < minInterval) {
        return;
      }
    }

    await this.runCycle(type);
  }

  /**
   * Run a complete sleep cycle
   *
   * @param type Type of sleep cycle
   * @param configOverrides Optional configuration overrides
   * @returns Cycle result
   */
  async runCycle(
    type: SleepCycleType,
    configOverrides: Partial<SleepCycleConfig> = {}
  ): Promise<SleepCycleResult> {
    const config: SleepCycleConfig = {
      ...SLEEP_CYCLE_DEFAULTS[type],
      ...configOverrides,
    };

    const startedAt = Date.now();
    const cycleId = this.recordCycleStart(type);

    // P1: Set priority config on the detector for this cycle
    this.supersessionDetector.setPriorityConfig(config.priority);

    // P2: Set memory tier config on the detector for this cycle
    this.supersessionDetector.setMemoryTierConfig(config.memoryTier);

    logger.debug('SLEEP_AGENT', `Starting ${type} sleep cycle`, {
      cycleId,
      config: {
        supersessionEnabled: config.supersessionEnabled,
        chainDetectionEnabled: config.chainDetectionEnabled,
        deprecationEnabled: config.deprecationEnabled,
        lookbackDays: config.supersessionLookbackDays,
        maxObservations: config.maxObservationsPerCycle,
        priorityEnabled: config.priority.enabled,
        priorityBoostFactor: config.priority.confidenceBoostFactor,
        memoryTierEnabled: config.memoryTier.enabled,
        memoryTierReclassify: config.memoryTier.reclassifyOnSleepCycle,
      },
    });

    const result: SleepCycleResult = {
      cycleId,
      type,
      startedAt,
      completedAt: 0,
      duration: 0,
      supersession: null,
      chains: null,
      summary: {
        observationsProcessed: 0,
        supersessionsDetected: 0,
        chainsConsolidated: 0,
        memoriesDeprecated: 0,
        byPriorityTier: { critical: 0, high: 0, medium: 0, low: 0 },
        // P2: Initialize memory tier stats
        byMemoryTier: { core: 0, working: 0, archive: 0, ephemeral: 0 },
        memoryTierUpdates: 0,
      },
    };

    try {
      // Get all projects
      const projects = this.getAllProjects();

      for (const project of projects) {
        // Phase 1: Supersession Detection
        if (config.supersessionEnabled) {
          const supersessionResult = await this.supersessionDetector.detectBatch(
            project,
            config.supersessionLookbackDays,
            config.maxObservationsPerCycle
          );

          result.summary.observationsProcessed += supersessionResult.processedCount;

          // Apply supersessions
          for (const candidate of supersessionResult.candidates) {
            // P1: Priority-adjusted threshold (already applied in detector, but double-check here)
            let adjustedThreshold = config.supersessionThreshold;
            if (config.priority.enabled) {
              const boost = candidate.priority * config.priority.confidenceBoostFactor;
              adjustedThreshold = Math.max(0.3, config.supersessionThreshold - boost);
            }

            if (candidate.confidence >= adjustedThreshold) {
              const applied = await this.supersessionDetector.applySupersession(
                candidate,
                config.dryRun
              );
              if (applied) {
                result.summary.supersessionsDetected++;
                // P1: Track by priority tier
                if (result.summary.byPriorityTier) {
                  result.summary.byPriorityTier[candidate.priorityTier]++;
                }
                // P2: Increment reference count for the newer observation
                if (!config.dryRun) {
                  this.supersessionDetector.incrementReferenceCount(candidate.newerId);
                  this.supersessionDetector.updateLastAccessed(candidate.newerId);
                  this.supersessionDetector.updateLastAccessed(candidate.olderId);
                }
              }
            }
          }

          if (!result.supersession) {
            result.supersession = supersessionResult;
          } else {
            result.supersession.candidates.push(...supersessionResult.candidates);
            result.supersession.processedCount += supersessionResult.processedCount;
          }
        }

        // Phase 2: Chain Detection (placeholder for future implementation)
        if (config.chainDetectionEnabled) {
          const chainResult = await this.detectDecisionChains(project, config);
          if (chainResult) {
            result.chains = chainResult;
            result.summary.chainsConsolidated += chainResult.chains.length;
          }
        }

        // Phase 3: Deprecation
        if (config.deprecationEnabled) {
          const deprecated = await this.deprecateOldSuperseded(
            project,
            config.deprecateAfterDays,
            config.dryRun
          );
          result.summary.memoriesDeprecated += deprecated;
        }

        // P2: Phase 4: Memory Tier Classification (CMS)
        if (config.memoryTier.enabled && config.memoryTier.reclassifyOnSleepCycle) {
          const tierStats = this.supersessionDetector.getMemoryTierStats(project);
          const tierUpdates = this.supersessionDetector.batchClassifyMemoryTiers(project);

          // Update summary stats
          if (result.summary.byMemoryTier) {
            result.summary.byMemoryTier.core += tierStats.core;
            result.summary.byMemoryTier.working += tierStats.working;
            result.summary.byMemoryTier.archive += tierStats.archive;
            result.summary.byMemoryTier.ephemeral += tierStats.ephemeral;
          }
          result.summary.memoryTierUpdates = (result.summary.memoryTierUpdates || 0) + tierUpdates;

          logger.debug('SLEEP_AGENT', 'Memory tier classification complete', {
            project,
            tierStats,
            tierUpdates,
          });
        }
      }

      result.completedAt = Date.now();
      result.duration = result.completedAt - startedAt;

      // Update stats
      this.stats.totalCycles++;
      this.stats.totalSupersessions += result.summary.supersessionsDetected;
      this.stats.totalDeprecated += result.summary.memoriesDeprecated;

      // Record completion
      this.recordCycleComplete(cycleId, result);
      this.lastCycle = result;

      logger.debug('SLEEP_AGENT', `Completed ${type} sleep cycle`, {
        cycleId,
        duration: result.duration,
        supersessionsDetected: result.summary.supersessionsDetected,
        memoriesDeprecated: result.summary.memoriesDeprecated,
      });

      return result;
    } catch (error) {
      result.completedAt = Date.now();
      result.duration = result.completedAt - startedAt;
      result.error = (error as Error).message;

      this.recordCycleFailed(cycleId, (error as Error).message);
      this.lastCycle = result;

      logger.error('SLEEP_AGENT', `Failed ${type} sleep cycle`, {
        cycleId,
        duration: result.duration,
      }, error as Error);

      return result;
    }
  }

  /**
   * Detect decision chains (groups of related decisions)
   * Currently a placeholder - will be implemented in future iteration
   */
  private async detectDecisionChains(
    _project: string,
    _config: SleepCycleConfig
  ): Promise<ChainDetectionResult | null> {
    // TODO: Implement decision chain detection
    // This requires semantic clustering of decision-type observations
    return null;
  }

  /**
   * Deprecate observations that have been superseded for a long time
   */
  private async deprecateOldSuperseded(
    project: string,
    deprecateAfterDays: number,
    dryRun: boolean
  ): Promise<number> {
    const cutoffEpoch = Date.now() - (deprecateAfterDays * 24 * 60 * 60 * 1000);

    // Find superseded observations older than cutoff
    const toDeprecate = this.sessionStore.db.prepare(`
      SELECT id FROM observations
      WHERE project = ?
        AND superseded_by IS NOT NULL
        AND deprecated = 0
        AND created_at_epoch < ?
    `).all(project, cutoffEpoch) as { id: number }[];

    if (dryRun) {
      logger.debug('SLEEP_AGENT', 'DRY RUN: Would deprecate observations', {
        project,
        count: toDeprecate.length,
      });
      return toDeprecate.length;
    }

    let deprecated = 0;
    for (const { id } of toDeprecate) {
      const success = this.supersessionDetector.deprecateObservation(
        id,
        `Superseded for more than ${deprecateAfterDays} days`
      );
      if (success) deprecated++;
    }

    return deprecated;
  }

  /**
   * Get current idle state
   */
  getIdleState(): IdleState {
    return {
      isIdle: this.activeSessions.size === 0,
      lastActivityAt: this.lastActivityAt,
      idleDurationMs: Date.now() - this.lastActivityAt,
      activeSessions: this.activeSessions.size,
    };
  }

  /**
   * Get current status
   */
  getStatus(): SleepAgentStatus {
    return {
      isRunning: this.isRunning,
      idleDetectionEnabled: this.idleCheckInterval !== null,
      idleState: this.getIdleState(),
      lastCycle: this.lastCycle,
      stats: { ...this.stats },
    };
  }

  /**
   * Get sleep cycle history
   */
  getCycleHistory(limit: number = 10): SleepCycleRow[] {
    return this.sessionStore.db.prepare(`
      SELECT * FROM sleep_cycles
      ORDER BY started_at_epoch DESC
      LIMIT ?
    `).all(limit) as SleepCycleRow[];
  }

  /**
   * Get the supersession detector (for API route access)
   */
  getSupersessionDetector(): SupersessionDetector {
    return this.supersessionDetector;
  }

  /**
   * Run a micro cycle for a specific session (P0 optimization)
   *
   * Called when a session ends (summary is generated).
   * Only processes observations from that session against recent observations.
   * This is O(N*M) where N = session obs, M = recent obs (typically small).
   * Uses P1 priority-based processing for faster consolidation of high-priority types.
   *
   * @param claudeSessionId The session to process
   * @param lookbackDays How far back to look (default 7 days)
   * @returns Micro cycle result
   */
  async runMicroCycle(
    claudeSessionId: string,
    lookbackDays: number = 7
  ): Promise<SleepCycleResult> {
    const startedAt = Date.now();
    const cycleId = this.recordCycleStart('micro' as SleepCycleType);

    // P1: Use micro cycle's priority config
    const microConfig = SLEEP_CYCLE_DEFAULTS.micro;
    this.supersessionDetector.setPriorityConfig(microConfig.priority);

    logger.debug('SLEEP_AGENT', 'Starting micro sleep cycle', {
      cycleId,
      claudeSessionId,
      lookbackDays,
      priorityEnabled: microConfig.priority.enabled,
    });

    const result: SleepCycleResult = {
      cycleId,
      type: 'micro' as SleepCycleType,
      startedAt,
      completedAt: 0,
      duration: 0,
      supersession: null,
      chains: null,
      summary: {
        observationsProcessed: 0,
        supersessionsDetected: 0,
        chainsConsolidated: 0,
        memoriesDeprecated: 0,
        byPriorityTier: { critical: 0, high: 0, medium: 0, low: 0 },
        // P2: Initialize memory tier stats (micro cycles don't reclassify)
        byMemoryTier: { core: 0, working: 0, archive: 0, ephemeral: 0 },
        memoryTierUpdates: 0,
      },
    };

    try {
      // Detect supersessions for this session
      const supersessionResult = await this.supersessionDetector.detectForSession(
        claudeSessionId,
        lookbackDays
      );

      result.supersession = supersessionResult;
      result.summary.observationsProcessed = supersessionResult.processedCount;

      // Apply supersessions (not dry run)
      for (const candidate of supersessionResult.candidates) {
        const applied = await this.supersessionDetector.applySupersession(
          candidate,
          false // not dry run
        );
        if (applied) {
          result.summary.supersessionsDetected++;
          // P1: Track by priority tier
          if (result.summary.byPriorityTier) {
            result.summary.byPriorityTier[candidate.priorityTier]++;
          }
          // P2: Increment reference count for the newer observation
          this.supersessionDetector.incrementReferenceCount(candidate.newerId);
          this.supersessionDetector.updateLastAccessed(candidate.newerId);
          this.supersessionDetector.updateLastAccessed(candidate.olderId);
        }
      }

      result.completedAt = Date.now();
      result.duration = result.completedAt - startedAt;

      // Update stats
      this.stats.totalCycles++;
      this.stats.totalSupersessions += result.summary.supersessionsDetected;

      // Record completion
      this.recordCycleComplete(cycleId, result);
      this.lastCycle = result;

      logger.debug('SLEEP_AGENT', 'Completed micro sleep cycle', {
        cycleId,
        claudeSessionId,
        duration: result.duration,
        observationsProcessed: result.summary.observationsProcessed,
        supersessionsDetected: result.summary.supersessionsDetected,
        byPriorityTier: result.summary.byPriorityTier,
      });

      return result;
    } catch (error) {
      result.completedAt = Date.now();
      result.duration = result.completedAt - startedAt;
      result.error = (error as Error).message;

      this.recordCycleFailed(cycleId, (error as Error).message);
      this.lastCycle = result;

      logger.error('SLEEP_AGENT', 'Failed micro sleep cycle', {
        cycleId,
        claudeSessionId,
        duration: result.duration,
      }, error as Error);

      return result;
    }
  }

  /**
   * Get all projects from database
   */
  private getAllProjects(): string[] {
    const rows = this.sessionStore.db.prepare(`
      SELECT DISTINCT project FROM observations
      WHERE deprecated = 0
    `).all() as { project: string }[];
    return rows.map(r => r.project);
  }

  /**
   * Record cycle start in database
   */
  private recordCycleStart(type: SleepCycleType): number {
    const result = this.sessionStore.db.run(`
      INSERT INTO sleep_cycles (
        started_at_epoch, cycle_type, status,
        observations_processed, supersessions_detected,
        chains_consolidated, memories_deprecated
      ) VALUES (?, ?, 'running', 0, 0, 0, 0)
    `, Date.now(), type);
    return Number(result.lastInsertRowid);
  }

  /**
   * Record cycle completion in database
   */
  private recordCycleComplete(cycleId: number, result: SleepCycleResult): void {
    this.sessionStore.db.run(`
      UPDATE sleep_cycles SET
        completed_at_epoch = ?,
        status = 'completed',
        observations_processed = ?,
        supersessions_detected = ?,
        chains_consolidated = ?,
        memories_deprecated = ?
      WHERE id = ?
    `,
      result.completedAt,
      result.summary.observationsProcessed,
      result.summary.supersessionsDetected,
      result.summary.chainsConsolidated,
      result.summary.memoriesDeprecated,
      cycleId
    );
  }

  /**
   * Record cycle failure in database
   */
  private recordCycleFailed(cycleId: number, errorMessage: string): void {
    this.sessionStore.db.run(`
      UPDATE sleep_cycles SET
        completed_at_epoch = ?,
        status = 'failed',
        error_message = ?
      WHERE id = ?
    `, Date.now(), errorMessage, cycleId);
  }
}
