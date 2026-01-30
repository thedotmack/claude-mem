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
const DEFAULT_PRO_API_URL = process.env.CLAUDE_MEM_PRO_API_URL || 'https://claude-mem-pro.vercel.app';

export class ProRoutes extends BaseRouteHandler {
  setupRoutes(app: express.Application): void {
    app.get('/api/pro/status', this.handleGetStatus.bind(this));
    app.post('/api/pro/setup', this.handleSetup.bind(this));
    app.post('/api/pro/disconnect', this.handleDisconnect.bind(this));
    app.post('/api/pro/import', this.handleImport.bind(this));
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
   * POST /api/pro/import
   * Import data from cloud to local SQLite
   * Downloads all observations, summaries, and prompts from cloud
   */
  private handleImport = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const config = loadProConfig();

    if (!config) {
      res.status(401).json({
        success: false,
        error: 'Not configured as Pro user. Run /pro-setup first.'
      });
      return;
    }

    logger.info('PRO_ROUTES', 'Starting cloud import');

    try {
      // Fetch all data from cloud
      const exportResponse = await fetch(`${config.apiUrl}/api/pro/export`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${config.setupToken}`,
          'X-User-Id': config.userId,
        },
      });

      if (!exportResponse.ok) {
        const errorText = await exportResponse.text();
        throw new Error(`Failed to fetch cloud data: ${exportResponse.status} - ${errorText}`);
      }

      const exportData = await exportResponse.json();

      if (!exportData.success) {
        throw new Error(exportData.error || 'Export failed');
      }

      // Import into local SQLite
      const db = new SessionStore();
      let importedObs = 0;
      let importedSum = 0;
      let importedPrompts = 0;

      // Import observations
      for (const obs of exportData.data.observations || []) {
        try {
          // Check if already exists
          const existing = db.db.prepare(
            'SELECT id FROM observations WHERE id = ? OR (memory_session_id = ? AND prompt_number = ?)'
          ).get(obs.id, obs.memory_session_id, obs.prompt_number);

          if (!existing) {
            db.db.prepare(`
              INSERT INTO observations (
                memory_session_id, project, type, title, subtitle,
                facts, narrative, concepts, files_read, files_modified,
                prompt_number, discovery_tokens, created_at, created_at_epoch
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
              obs.memory_session_id, obs.project, obs.type, obs.title, obs.subtitle,
              obs.facts, obs.narrative, obs.concepts, obs.files_read, obs.files_modified,
              obs.prompt_number, obs.discovery_tokens, obs.created_at, obs.created_at_epoch
            );
            importedObs++;
          }
        } catch (err) {
          logger.warn('PRO_ROUTES', 'Failed to import observation', { id: obs.id }, err as Error);
        }
      }

      // Import summaries
      for (const sum of exportData.data.summaries || []) {
        try {
          const existing = db.db.prepare(
            'SELECT id FROM session_summaries WHERE id = ? OR (memory_session_id = ? AND prompt_number = ?)'
          ).get(sum.id, sum.memory_session_id, sum.prompt_number);

          if (!existing) {
            db.db.prepare(`
              INSERT INTO session_summaries (
                memory_session_id, project, request, investigated, learned,
                completed, next_steps, notes, prompt_number, discovery_tokens,
                created_at, created_at_epoch
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
              sum.memory_session_id, sum.project, sum.request, sum.investigated, sum.learned,
              sum.completed, sum.next_steps, sum.notes, sum.prompt_number, sum.discovery_tokens,
              sum.created_at, sum.created_at_epoch
            );
            importedSum++;
          }
        } catch (err) {
          logger.warn('PRO_ROUTES', 'Failed to import summary', { id: sum.id }, err as Error);
        }
      }

      // Import prompts
      for (const prompt of exportData.data.prompts || []) {
        try {
          const existing = db.db.prepare(
            'SELECT id FROM user_prompts WHERE id = ? OR (memory_session_id = ? AND prompt_number = ?)'
          ).get(prompt.id, prompt.memory_session_id, prompt.prompt_number);

          if (!existing) {
            db.db.prepare(`
              INSERT INTO user_prompts (
                content_session_id, memory_session_id, project,
                prompt_number, prompt_text, created_at, created_at_epoch
              ) VALUES (?, ?, ?, ?, ?, ?, ?)
            `).run(
              prompt.content_session_id, prompt.memory_session_id, prompt.project,
              prompt.prompt_number, prompt.prompt_text, prompt.created_at, prompt.created_at_epoch
            );
            importedPrompts++;
          }
        } catch (err) {
          logger.warn('PRO_ROUTES', 'Failed to import prompt', { id: prompt.id }, err as Error);
        }
      }

      db.close();

      logger.info('PRO_ROUTES', 'Cloud import complete', {
        imported: { observations: importedObs, summaries: importedSum, prompts: importedPrompts },
        skipped: {
          observations: (exportData.data.observations?.length || 0) - importedObs,
          summaries: (exportData.data.summaries?.length || 0) - importedSum,
          prompts: (exportData.data.prompts?.length || 0) - importedPrompts,
        },
        subscriptionActive: exportData.subscriptionActive
      });

      // Check if user's subscription is inactive (downgraded)
      const isDowngraded = exportData.subscriptionActive === false;

      res.json({
        success: true,
        imported: {
          observations: importedObs,
          summaries: importedSum,
          prompts: importedPrompts,
        },
        cloudStats: exportData.stats,
        // Include downgrade info so client can inform user
        subscriptionActive: exportData.subscriptionActive,
        downgradeNotice: isDowngraded
          ? 'Your subscription is no longer active. Your data has been imported locally. To continue using Claude-Mem with local storage, run /pro-disconnect to reset to free mode.'
          : null,
      });

    } catch (error) {
      logger.error('PRO_ROUTES', 'Cloud import failed', {}, error as Error);
      res.status(500).json({
        success: false,
        error: (error as Error).message || 'Import failed'
      });
    }
  });

  /**
   * POST /api/pro/disconnect
   * Remove Pro configuration (logout/downgrade to free)
   * After disconnect, future observations will use local Chroma storage
   */
  private handleDisconnect = this.wrapHandler((req: Request, res: Response): void => {
    const wasPro = isProUser();

    removeProConfig();

    logger.info('PRO_ROUTES', 'Pro disconnected', { wasPro });

    res.json({
      success: true,
      message: wasPro
        ? 'Pro disconnected. Your local data is preserved. Please restart claude-mem for changes to take effect (run: claude-mem restart).'
        : 'No Pro configuration found.',
      restartRequired: wasPro, // Signal that worker needs restart to use Chroma
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
