/**
 * Pro Routes
 *
 * Handles Claude-Mem Pro setup and status endpoints.
 * Used by the /pro-setup command and Pro features.
 */

import express, { Request, Response } from 'express';
import { logger } from '../../../../utils/logger.js';
import { BaseRouteHandler } from '../BaseRouteHandler.js';
import {
  loadProConfig,
  setupProUser,
  removeProConfig,
  isProUser,
  completeProSetup,
  updateMigrationStatus,
  ProUserConfig
} from '../../../pro/ProConfig.js';
import { CloudSync, ALL_PROJECTS_SENTINEL } from '../../../sync/CloudSync.js';
import { SessionStore } from '../../../sqlite/SessionStore.js';

// Default Pro API URL (can be overridden)
const DEFAULT_PRO_API_URL = 'https://claude-mem.com';

export class ProRoutes extends BaseRouteHandler {
  setupRoutes(app: express.Application): void {
    app.get('/api/pro/status', this.handleGetStatus.bind(this));
    app.post('/api/pro/setup', this.handleSetup.bind(this));
    app.post('/api/pro/disconnect', this.handleDisconnect.bind(this));
    // Legacy route for /pro/setup without api prefix
    app.post('/pro/setup', this.handleSetup.bind(this));
  }

  /**
   * GET /api/pro/status
   * Returns Pro status and config (without sensitive data)
   */
  private handleGetStatus = this.wrapHandler((req: Request, res: Response): void => {
    const config = loadProConfig();

    if (!config) {
      res.json({
        isPro: false,
        message: 'Not configured for Pro. Run /pro-setup to connect.'
      });
      return;
    }

    res.json({
      isPro: true,
      userId: config.userId.substring(0, 8) + '...', // Truncated for privacy
      planTier: config.planTier,
      configuredAt: config.configuredAt,
      expiresAt: config.expiresAt,
      features: this.getProFeatures(config.planTier),
      migration: config.migration || null
    });
  });

  /**
   * POST /api/pro/setup
   * Set up Pro with a setup token
   * Body: { setupToken: string, apiUrl?: string }
   *
   * This endpoint:
   * 1. Validates the setup token with mem-pro API
   * 2. Saves config locally
   * 3. Migrates existing local data to cloud
   * 4. Marks setup as complete
   */
  private handleSetup = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const { setupToken, apiUrl } = req.body;

    if (!setupToken) {
      res.status(400).json({
        success: false,
        error: 'Setup token is required'
      });
      return;
    }

    // Validate token format
    if (!setupToken.startsWith('cm_pro_') || setupToken.length !== 39) {
      res.status(400).json({
        success: false,
        error: 'Invalid token format. Expected format: cm_pro_<32-char-hex>'
      });
      return;
    }

    const effectiveApiUrl = apiUrl || DEFAULT_PRO_API_URL;

    logger.info('PRO_ROUTES', 'Processing Pro setup request', {
      apiUrl: effectiveApiUrl,
      tokenPrefix: setupToken.substring(0, 12) + '...'
    });

    try {
      // Step 1: Validate token and save config
      const config = await setupProUser(effectiveApiUrl, setupToken);

      // Step 2: Get local data stats for migration
      let localStats = { observations: 0, summaries: 0, prompts: 0 };
      try {
        const sessionStore = new SessionStore();
        const obsCount = sessionStore.db.prepare('SELECT COUNT(*) as count FROM observations').get() as { count: number };
        const sumCount = sessionStore.db.prepare('SELECT COUNT(*) as count FROM session_summaries').get() as { count: number };
        const promptCount = sessionStore.db.prepare('SELECT COUNT(*) as count FROM user_prompts').get() as { count: number };
        localStats = {
          observations: obsCount.count,
          summaries: sumCount.count,
          prompts: promptCount.count
        };
        sessionStore.close();
      } catch (statsError) {
        logger.warn('PRO_ROUTES', 'Failed to get local stats', {}, statsError as Error);
      }

      logger.info('PRO_ROUTES', 'Local data stats', localStats);

      // Step 3: Migrate data in background (don't block response)
      // If already completed, skip migration
      if (!config.setupCompleted && localStats.observations > 0) {
        this.runMigrationInBackground(config, localStats, setupToken);
      } else if (config.setupCompleted) {
        logger.info('PRO_ROUTES', 'Setup already completed, skipping migration');
      } else {
        logger.info('PRO_ROUTES', 'No local data to migrate');
        // Mark setup complete with zero migration
        this.completeSetupWithStats(config.apiUrl, setupToken, {
          observationsMigrated: 0,
          summariesMigrated: 0,
          promptsMigrated: 0,
          vectorsMigrated: 0
        });
      }

      res.json({
        success: true,
        userId: config.userId,
        planTier: config.planTier,
        features: this.getProFeatures(config.planTier),
        localDataToMigrate: localStats,
        migrationStatus: config.setupCompleted ? 'already_complete' : (localStats.observations > 0 ? 'in_progress' : 'skipped'),
        message: config.setupCompleted
          ? 'Pro already configured! Cloud sync is active.'
          : localStats.observations > 0
            ? 'Pro setup started! Migrating your data to the cloud in the background...'
            : 'Pro setup complete! Your memories will now sync to the cloud.'
      });
    } catch (error) {
      logger.error('PRO_ROUTES', 'Pro setup failed', {}, error as Error);

      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      // Provide helpful error messages
      if (errorMessage.includes('401') || errorMessage.includes('Invalid')) {
        res.status(401).json({
          success: false,
          error: 'Invalid or expired setup token. Please get a new token from the dashboard.'
        });
      } else if (errorMessage.includes('404')) {
        res.status(404).json({
          success: false,
          error: 'Pro API endpoint not found. Please check the API URL.'
        });
      } else if (errorMessage.includes('fetch') || errorMessage.includes('network')) {
        res.status(503).json({
          success: false,
          error: 'Unable to reach Pro API. Please check your internet connection.'
        });
      } else {
        res.status(500).json({
          success: false,
          error: errorMessage
        });
      }
    }
  });

  /**
   * Run data migration in background
   */
  private runMigrationInBackground(
    config: ProUserConfig,
    localStats: { observations: number; summaries: number; prompts: number },
    setupToken: string
  ): void {
    // Mark migration as started
    updateMigrationStatus({
      status: 'in_progress',
      startedAt: Date.now()
    });

    // Don't await - run in background
    this.performMigration(config, localStats, setupToken).catch((error) => {
      logger.error('PRO_ROUTES', 'Background migration failed', {}, error as Error);
      // Track the error so status endpoint can report it
      updateMigrationStatus({
        status: 'failed',
        startedAt: config.migration?.startedAt,
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    });
  }

  /**
   * Perform the actual data migration
   */
  private async performMigration(
    config: ProUserConfig,
    localStats: { observations: number; summaries: number; prompts: number },
    setupToken: string
  ): Promise<void> {
    logger.info('PRO_ROUTES', 'Starting background migration', {
      userId: config.userId.substring(0, 8) + '...',
      localStats
    });

    try {
      // Create CloudSync instance for migration
      // ALL_PROJECTS_SENTINEL = migrate ALL projects (ensureBackfilled reads projects from SQLite)
      const cloudSync = new CloudSync({
        apiUrl: config.apiUrl,
        setupToken: config.setupToken,
        userId: config.userId,
        project: ALL_PROJECTS_SENTINEL // Explicit sentinel: ensureBackfilled() iterates all projects from local DB
      });

      // Run the backfill (this syncs all local data to cloud)
      await cloudSync.ensureBackfilled();

      // Get final stats
      const stats = await cloudSync.getStats();

      const migrationStats = {
        observationsMigrated: stats.observations || localStats.observations,
        summariesMigrated: stats.summaries || localStats.summaries,
        promptsMigrated: stats.prompts || localStats.prompts,
        vectorsMigrated: stats.vectors || 0
      };

      logger.info('PRO_ROUTES', 'Migration complete', {
        userId: config.userId.substring(0, 8) + '...',
        migratedStats: migrationStats
      });

      // Track successful migration
      updateMigrationStatus({
        status: 'complete',
        startedAt: config.migration?.startedAt,
        completedAt: Date.now(),
        stats: migrationStats
      });

      // Mark setup as complete with mem-pro API
      await this.completeSetupWithStats(config.apiUrl, setupToken, migrationStats);

      await cloudSync.close();
    } catch (error) {
      logger.error('PRO_ROUTES', 'Migration failed', {}, error as Error);

      // Track the failure with error details
      updateMigrationStatus({
        status: 'failed',
        startedAt: config.migration?.startedAt,
        error: error instanceof Error ? error.message : 'Unknown error'
      });

      // Still try to mark as complete even if migration partially failed
      try {
        await this.completeSetupWithStats(config.apiUrl, setupToken, {
          observationsMigrated: 0,
          summariesMigrated: 0,
          promptsMigrated: 0,
          vectorsMigrated: 0
        });
      } catch (completeError) {
        logger.error('PRO_ROUTES', 'Failed to mark setup complete after migration error', {}, completeError as Error);
      }
    }
  }

  /**
   * Complete setup by calling mem-pro API
   */
  private async completeSetupWithStats(
    apiUrl: string,
    setupToken: string,
    stats: {
      observationsMigrated: number;
      summariesMigrated: number;
      promptsMigrated: number;
      vectorsMigrated: number;
    }
  ): Promise<void> {
    try {
      await completeProSetup(apiUrl, setupToken, stats);
      logger.info('PRO_ROUTES', 'Setup marked complete with stats', stats);
    } catch (error) {
      logger.error('PRO_ROUTES', 'Failed to complete setup', {}, error as Error);
      throw error;
    }
  }

  /**
   * POST /api/pro/disconnect
   * Remove Pro configuration (logout)
   */
  private handleDisconnect = this.wrapHandler((req: Request, res: Response): void => {
    const wasPro = isProUser();

    removeProConfig();

    logger.info('PRO_ROUTES', 'Pro disconnected', { wasPro });

    res.json({
      success: true,
      message: wasPro
        ? 'Pro disconnected. Your local data is preserved.'
        : 'No Pro configuration found.'
    });
  });

  /**
   * Get list of features for a plan tier
   */
  private getProFeatures(planTier: string): string[] {
    const features = [
      'cloud_sync',
      'cross_device',
      'web_dashboard',
      'semantic_search',
      'unlimited_observations'
    ];

    if (planTier === 'enterprise') {
      features.push('team_sharing', 'api_access', 'priority_support');
    }

    return features;
  }
}
