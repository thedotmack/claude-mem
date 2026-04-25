/**
 * Chroma Routes
 *
 * Provides diagnostic endpoints for ChromaDB integration.
 */

import express, { Request, Response } from 'express';
import { BaseRouteHandler } from '../BaseRouteHandler.js';
import { ChromaMcpManager } from '../../../sync/ChromaMcpManager.js';
import { logger } from '../../../../utils/logger.js';
import { SettingsDefaultsManager } from '../../../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../../../shared/paths.js';

export class ChromaRoutes extends BaseRouteHandler {
  setupRoutes(app: express.Application): void {
    app.get('/api/chroma/status', this.handleGetStatus.bind(this));
  }

  /**
   * GET /api/chroma/status
   * Returns current health and connection status of chroma-mcp.
   */
  private handleGetStatus = this.wrapHandler(async (_req: Request, res: Response): Promise<void> => {
    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
    const chromaEnabled = settings.CLAUDE_MEM_CHROMA_ENABLED !== 'false';

    if (!chromaEnabled) {
      res.json({
        status: 'disabled',
        connected: false,
        timestamp: new Date().toISOString(),
        details: 'Chroma is disabled via CLAUDE_MEM_CHROMA_ENABLED=false'
      });
      return;
    }

    const chromaMcp = ChromaMcpManager.getInstance();
    const isHealthy = await chromaMcp.isHealthy();
    
    res.json({
      status: isHealthy ? 'healthy' : 'unhealthy',
      connected: isHealthy,
      timestamp: new Date().toISOString(),
      details: isHealthy ? 'chroma-mcp is responding to tool calls' : 'chroma-mcp health check failed'
    });
  });
}
