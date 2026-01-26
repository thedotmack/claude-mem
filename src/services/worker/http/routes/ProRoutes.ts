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
  ProUserConfig
} from '../../../pro/ProConfig.js';

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
      features: this.getProFeatures(config.planTier)
    });
  });

  /**
   * POST /api/pro/setup
   * Set up Pro with a setup token
   * Body: { setupToken: string, apiUrl?: string }
   */
  private handleSetup = this.wrapAsyncHandler(async (req: Request, res: Response): Promise<void> => {
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
      const config = await setupProUser(effectiveApiUrl, setupToken);

      res.json({
        success: true,
        userId: config.userId,
        planTier: config.planTier,
        features: this.getProFeatures(config.planTier),
        message: 'Pro setup complete! Your memories will now sync to the cloud.'
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
