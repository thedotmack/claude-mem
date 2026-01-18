/**
 * SleepRoutes - HTTP API for Sleep Agent memory consolidation
 *
 * Provides endpoints for:
 * - Getting Sleep Agent status
 * - Manually triggering sleep cycles
 * - Managing idle detection
 * - Viewing sleep cycle history
 */

import express, { Request, Response } from 'express';
import { BaseRouteHandler } from '../BaseRouteHandler.js';
import { SleepAgent } from '../../SleepAgent.js';
import { SupersessionDetector } from '../../SupersessionDetector.js';
import { SleepCycleType, SLEEP_CYCLE_DEFAULTS, MemoryTier } from '../../../../types/sleep-agent.js';
import { logger } from '../../../../utils/logger.js';

/**
 * HTTP routes for Sleep Agent functionality
 */
export class SleepRoutes extends BaseRouteHandler {
  constructor(
    private sleepAgent: SleepAgent,
    private supersessionDetector: SupersessionDetector
  ) {
    super();
  }

  setupRoutes(app: express.Application): void {
    // Status endpoints
    app.get('/api/sleep/status', this.handleGetStatus.bind(this));

    // Cycle endpoints
    app.post('/api/sleep/cycle', this.handleRunCycle.bind(this));
    app.post('/api/sleep/micro-cycle', this.handleRunMicroCycle.bind(this));
    app.get('/api/sleep/cycles', this.handleGetCycleHistory.bind(this));

    // Supersession endpoints
    app.get('/api/sleep/superseded', this.handleGetSuperseded.bind(this));

    // P2: Memory Tier endpoints
    app.get('/api/sleep/memory-tiers', this.handleGetMemoryTiers.bind(this));
    app.get('/api/sleep/memory-tiers/stats', this.handleGetMemoryTierStats.bind(this));
    app.post('/api/sleep/memory-tiers/reclassify', this.handleReclassifyMemoryTiers.bind(this));

    // P3: Learned Model endpoints
    app.get('/api/sleep/learned-model/stats', this.handleGetLearnedModelStats.bind(this));
    app.post('/api/sleep/learned-model/train', this.handleTrainLearnedModel.bind(this));
    app.post('/api/sleep/learned-model/enable', this.handleSetLearnedModelEnabled.bind(this));
    app.post('/api/sleep/learned-model/reset', this.handleResetLearnedModel.bind(this));
    app.post('/api/sleep/learned-model/generate-training-data', this.handleGenerateTrainingData.bind(this));

    // Idle detection control
    app.post('/api/sleep/idle-detection/start', this.handleStartIdleDetection.bind(this));
    app.post('/api/sleep/idle-detection/stop', this.handleStopIdleDetection.bind(this));
  }

  /**
   * GET /api/sleep/status
   * Get current Sleep Agent status including idle state and last cycle results
   */
  private handleGetStatus = this.wrapHandler((req: Request, res: Response): void => {
    const status = this.sleepAgent.getStatus();
    res.json(status);
  });

  /**
   * POST /api/sleep/cycle
   * Manually trigger a sleep cycle
   *
   * Body: {
   *   type: 'light' | 'deep' | 'manual' (optional, defaults to 'manual')
   *   dryRun: boolean (optional, defaults to false)
   *   supersessionThreshold: number (optional, 0-1)
   *   maxObservationsPerCycle: number (optional)
   * }
   */
  private handleRunCycle = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const {
      type = 'manual',
      dryRun = false,
      supersessionThreshold,
      maxObservationsPerCycle,
    } = req.body;

    // Validate type
    if (!['light', 'deep', 'manual'].includes(type)) {
      this.badRequest(res, 'type must be "light", "deep", or "manual"');
      return;
    }

    // Validate optional parameters
    if (supersessionThreshold !== undefined) {
      if (typeof supersessionThreshold !== 'number' || supersessionThreshold < 0 || supersessionThreshold > 1) {
        this.badRequest(res, 'supersessionThreshold must be a number between 0 and 1');
        return;
      }
    }

    if (maxObservationsPerCycle !== undefined) {
      if (typeof maxObservationsPerCycle !== 'number' || maxObservationsPerCycle < 1) {
        this.badRequest(res, 'maxObservationsPerCycle must be a positive integer');
        return;
      }
    }

    logger.debug('SLEEP_ROUTES', 'Manual sleep cycle requested', {
      type,
      dryRun,
      supersessionThreshold,
      maxObservationsPerCycle,
    });

    // Build config overrides
    const configOverrides: Record<string, any> = { dryRun };
    if (supersessionThreshold !== undefined) {
      configOverrides.supersessionThreshold = supersessionThreshold;
    }
    if (maxObservationsPerCycle !== undefined) {
      configOverrides.maxObservationsPerCycle = maxObservationsPerCycle;
    }

    // Run the cycle
    const result = await this.sleepAgent.runCycle(type as SleepCycleType, configOverrides);

    res.json({
      success: !result.error,
      result,
    });
  });

  /**
   * POST /api/sleep/micro-cycle
   * Run a micro cycle for a specific session (P0 optimization)
   *
   * Body: {
   *   claudeSessionId: string (required)
   *   lookbackDays: number (optional, defaults to 7)
   * }
   */
  private handleRunMicroCycle = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const { claudeSessionId, lookbackDays = 7 } = req.body;

    if (!claudeSessionId) {
      this.badRequest(res, 'claudeSessionId is required');
      return;
    }

    logger.debug('SLEEP_ROUTES', 'Micro cycle requested', {
      claudeSessionId,
      lookbackDays,
    });

    const result = await this.sleepAgent.runMicroCycle(claudeSessionId, lookbackDays);

    res.json({
      success: !result.error,
      result,
    });
  });

  /**
   * GET /api/sleep/cycles
   * Get sleep cycle history
   *
   * Query params:
   *   limit: number (optional, defaults to 10)
   */
  private handleGetCycleHistory = this.wrapHandler((req: Request, res: Response): void => {
    const limit = Math.min(
      parseInt(req.query.limit as string, 10) || 10,
      100
    );

    const cycles = this.sleepAgent.getCycleHistory(limit);

    res.json({
      cycles,
      count: cycles.length,
    });
  });

  /**
   * GET /api/sleep/superseded
   * Get observations that have been superseded
   *
   * Query params:
   *   project: string (optional)
   *   limit: number (optional, defaults to 50)
   */
  private handleGetSuperseded = this.wrapHandler((req: Request, res: Response): void => {
    // This would need access to SupersessionDetector directly
    // For now, query from database through status
    const status = this.sleepAgent.getStatus();

    res.json({
      idleState: status.idleState,
      lastCycle: status.lastCycle,
      stats: status.stats,
      message: 'Use /api/observations?superseded=true to list superseded observations',
    });
  });

  /**
   * POST /api/sleep/idle-detection/start
   * Start idle detection (auto-triggers sleep cycles)
   */
  private handleStartIdleDetection = this.wrapHandler((req: Request, res: Response): void => {
    this.sleepAgent.startIdleDetection();

    logger.debug('SLEEP_ROUTES', 'Idle detection started via API', {});

    res.json({
      success: true,
      status: this.sleepAgent.getStatus(),
    });
  });

  /**
   * POST /api/sleep/idle-detection/stop
   * Stop idle detection
   */
  private handleStopIdleDetection = this.wrapHandler((req: Request, res: Response): void => {
    this.sleepAgent.stopIdleDetection();

    logger.debug('SLEEP_ROUTES', 'Idle detection stopped via API', {});

    res.json({
      success: true,
      status: this.sleepAgent.getStatus(),
    });
  });

  /**
   * GET /api/sleep/memory-tiers
   * Get observations by memory tier
   *
   * Query params:
   *   project: string (optional)
   *   tier: 'core' | 'working' | 'archive' | 'ephemeral' (required)
   *   limit: number (optional, defaults to 50)
   */
  private handleGetMemoryTiers = this.wrapHandler((req: Request, res: Response): void => {
    const { project, tier } = req.query;
    const limit = Math.min(
      parseInt(req.query.limit as string, 10) || 50,
      200
    );

    if (!tier) {
      this.badRequest(res, 'tier parameter is required');
      return;
    }

    if (!['core', 'working', 'archive', 'ephemeral'].includes(tier as string)) {
      this.badRequest(res, 'tier must be one of: core, working, archive, ephemeral');
      return;
    }

    if (!project) {
      this.badRequest(res, 'project parameter is required');
      return;
    }

    const observations = this.supersessionDetector.getObservationsByMemoryTier(
      project as string,
      tier as MemoryTier,
      limit
    );

    res.json({
      tier,
      project,
      count: observations.length,
      observations,
    });
  });

  /**
   * GET /api/sleep/memory-tiers/stats
   * Get memory tier statistics for a project
   *
   * Query params:
   *   project: string (required)
   */
  private handleGetMemoryTierStats = this.wrapHandler((req: Request, res: Response): void => {
    const { project } = req.query;

    if (!project) {
      this.badRequest(res, 'project parameter is required');
      return;
    }

    const stats = this.supersessionDetector.getMemoryTierStats(project as string);

    res.json({
      project,
      stats,
      total: Object.values(stats).reduce((sum, count) => sum + count, 0),
    });
  });

  /**
   * POST /api/sleep/memory-tiers/reclassify
   * Manually trigger memory tier reclassification for a project
   *
   * Body: {
   *   project: string (required)
   * }
   */
  private handleReclassifyMemoryTiers = this.wrapHandler((req: Request, res: Response): void => {
    const { project } = req.body;

    if (!project) {
      this.badRequest(res, 'project is required');
      return;
    }

    const tierUpdates = this.supersessionDetector.batchClassifyMemoryTiers(project);

    logger.debug('SLEEP_ROUTES', 'Manual memory tier reclassification triggered', {
      project,
      tierUpdates,
    });

    res.json({
      success: true,
      project,
      tierUpdates,
    });
  });

  /**
   * GET /api/sleep/learned-model/stats
   * Get learned model statistics and current weights
   */
  private handleGetLearnedModelStats = this.wrapHandler((req: Request, res: Response): void => {
    const stats = this.supersessionDetector.getLearnedModelStats();

    res.json({
      config: stats.config,
      weights: stats.weights,
      training: stats.stats,
      recentExamples: stats.recentExamples,
      canUseLearnedWeights: stats.stats.canUseLearnedWeights,
    });
  });

  /**
   * POST /api/sleep/learned-model/train
   * Train the learned model on collected examples
   */
  private handleTrainLearnedModel = this.wrapHandler((req: Request, res: Response): void => {
    const result = this.supersessionDetector.trainLearnedModel();

    logger.debug('SLEEP_ROUTES', 'Manual model training triggered', {
      examplesUsed: result.examplesUsed,
      loss: result.loss,
      accuracy: result.accuracy,
    });

    res.json({
      success: true,
      result: {
        examplesUsed: result.examplesUsed,
        loss: result.loss,
        accuracy: result.accuracy,
        weights: result.weights,
        timestamp: result.timestamp,
      },
    });
  });

  /**
   * POST /api/sleep/learned-model/enable
   * Enable or disable the learned model
   *
   * Body: {
   *   enabled: boolean (required)
   * }
   */
  private handleSetLearnedModelEnabled = this.wrapHandler((req: Request, res: Response): void => {
    const { enabled } = req.body;

    if (typeof enabled !== 'boolean') {
      this.badRequest(res, 'enabled must be a boolean');
      return;
    }

    this.supersessionDetector.setLearnedModelEnabled(enabled);

    logger.debug('SLEEP_ROUTES', 'Learned model enabled state changed', { enabled });

    res.json({
      success: true,
      enabled,
    });
  });

  /**
   * POST /api/sleep/learned-model/reset
   * Reset the learned model to initial weights
   */
  private handleResetLearnedModel = this.wrapHandler((req: Request, res: Response): void => {
    this.supersessionDetector.resetLearnedModel();

    logger.debug('SLEEP_ROUTES', 'Learned model reset to initial weights');

    res.json({
      success: true,
      message: 'Model reset to initial weights',
    });
  });

  /**
   * POST /api/sleep/learned-model/generate-training-data
   * Generate training examples from existing supersession relationships
   *
   * Body: {
   *   project: string (optional)
   *   limit: number (optional, defaults to 1000)
   * }
   */
  private handleGenerateTrainingData = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const { project, limit = 1000 } = req.body;

    if (limit && typeof limit !== 'number') {
      this.badRequest(res, 'limit must be a number');
      return;
    }

    logger.debug('SLEEP_ROUTES', 'Generating training data from existing supersessions', {
      project,
      limit,
    });

    const generated = await this.supersessionDetector.generateTrainingDataFromExistingSupersessions(
      project,
      limit
    );

    res.json({
      success: true,
      generated,
      project,
      limit,
    });
  });
}
