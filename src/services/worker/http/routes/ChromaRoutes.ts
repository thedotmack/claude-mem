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
   *
   * Pass `?deep=1` (or `?deep=true`) to additionally run a real
   * semantic-search round-trip via ChromaMcpManager.probeSemanticSearch().
   * The cheap path (no `deep`) stays cheap — it only calls isHealthy().
   */
  private handleGetStatus = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
    const chromaEnabled = settings.CLAUDE_MEM_CHROMA_ENABLED !== 'false';

    // Truthy check: any non-empty, non-"false"/"0" value enables deep probe.
    // Bare `?deep` (no value) shows up as '' in Express, which we treat as enabled.
    const deepRaw = req.query.deep;
    const deepEnabled =
      deepRaw !== undefined &&
      deepRaw !== 'false' &&
      deepRaw !== '0';

    if (!chromaEnabled) {
      res.json({
        status: 'disabled',
        connected: false,
        timestamp: new Date().toISOString(),
        details: 'Chroma is disabled via CLAUDE_MEM_CHROMA_ENABLED=false',
        deep: deepEnabled
      });
      return;
    }

    const chromaMcp = ChromaMcpManager.getInstance();
    const isHealthy = await chromaMcp.isHealthy();

    if (!deepEnabled) {
      res.json({
        status: isHealthy ? 'healthy' : 'unhealthy',
        connected: isHealthy,
        timestamp: new Date().toISOString(),
        details: isHealthy ? 'chroma-mcp is responding to tool calls' : 'chroma-mcp health check failed',
        deep: false
      });
      return;
    }

    const probe = await chromaMcp.probeSemanticSearch();
    const status = probe.ok ? 'healthy' : 'unhealthy';

    res.json({
      status,
      connected: isHealthy,
      timestamp: new Date().toISOString(),
      details: probe.ok
        ? 'chroma-mcp semantic search round-trip succeeded'
        : `chroma-mcp deep probe failed at stage '${probe.stage}'`,
      deep: true,
      probe
    });
  });
}
