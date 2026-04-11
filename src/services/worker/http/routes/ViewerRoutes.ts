/**
 * Viewer Routes
 *
 * Handles health check, viewer UI, and SSE stream endpoints.
 * These are used by the web viewer UI at http://localhost:37777
 */

import express, { Request, Response } from 'express';
import path from 'path';
import { readFileSync, existsSync } from 'fs';
import { logger } from '../../../../utils/logger.js';
import { getPackageRoot } from '../../../../shared/paths.js';
import { getNetworkMode } from '../../../../shared/node-identity.js';
import { SSEBroadcaster } from '../../SSEBroadcaster.js';
import { DatabaseManager } from '../../DatabaseManager.js';
import { SessionManager } from '../../SessionManager.js';
import { BaseRouteHandler } from '../BaseRouteHandler.js';
import { clientRegistry } from '../../../server/ClientRegistry.js';

export class ViewerRoutes extends BaseRouteHandler {
  constructor(
    private sseBroadcaster: SSEBroadcaster,
    private dbManager: DatabaseManager,
    private sessionManager: SessionManager
  ) {
    super();
  }

  setupRoutes(app: express.Application): void {
    // Serve static UI assets (JS, CSS, fonts, etc.)
    const packageRoot = getPackageRoot();
    app.use(express.static(path.join(packageRoot, 'ui')));

    app.get('/health', this.handleHealth.bind(this));
    app.get('/', this.handleViewerUI.bind(this));
    app.get('/stream', this.handleSSEStream.bind(this));
    app.get('/api/clients', this.handleGetClients.bind(this));
  }

  /**
   * Health check endpoint
   */
  private handleHealth = this.wrapHandler((req: Request, res: Response): void => {
    res.json({ status: 'ok', timestamp: Date.now(), mode: getNetworkMode() });
  });

  /**
   * Serve viewer UI
   */
  private handleViewerUI = this.wrapHandler((req: Request, res: Response): void => {
    const packageRoot = getPackageRoot();

    // Try cache structure first (ui/viewer.html), then marketplace structure (plugin/ui/viewer.html)
    const viewerPaths = [
      path.join(packageRoot, 'ui', 'viewer.html'),
      path.join(packageRoot, 'plugin', 'ui', 'viewer.html')
    ];

    const viewerPath = viewerPaths.find(p => existsSync(p));

    if (!viewerPath) {
      throw new Error('Viewer UI not found at any expected location');
    }

    const html = readFileSync(viewerPath, 'utf-8');
    res.setHeader('Content-Type', 'text/html');
    res.send(html);
  });

  /**
   * GET /api/clients — return connected client list from the registry
   */
  private handleGetClients = this.wrapHandler((_req: Request, res: Response): void => {
    res.json({ clients: clientRegistry.getClients() });
  });

  /**
   * SSE stream endpoint
   */
  private handleSSEStream = this.wrapHandler((req: Request, res: Response): void => {
    // Guard: if DB is not yet initialized, return 503 before registering client
    try {
      this.dbManager.getSessionStore();
    } catch {
      res.status(503).json({ error: 'Service initializing' });
      return;
    }

    // Setup SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    // Add client to broadcaster
    this.sseBroadcaster.addClient(res);

    // Send initial_load event with project/source catalog
    const projectCatalog = this.dbManager.getSessionStore().getProjectCatalog();
    this.sseBroadcaster.broadcast({
      type: 'initial_load',
      projects: projectCatalog.projects,
      sources: projectCatalog.sources,
      projectsBySource: projectCatalog.projectsBySource,
      timestamp: Date.now()
    });

    // Send initial processing status (based on queue depth + active generators)
    const isProcessing = this.sessionManager.isAnySessionProcessing();
    const queueDepth = this.sessionManager.getTotalActiveWork(); // Includes queued + actively processing
    this.sseBroadcaster.broadcast({
      type: 'processing_status',
      isProcessing,
      queueDepth
    });
  });
}
