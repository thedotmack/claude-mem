/**
 * Viewer Routes
 *
 * Handles health check, viewer UI, and SSE stream endpoints.
 * These are used by the web viewer UI at http://localhost:37777
 */

import express, { Request, Response } from 'express';
import path from 'path';
import { readFileSync } from 'fs';
import { getPackageRoot } from '../../../../shared/paths.js';
import { logger } from '../../../../utils/logger.js';
import { SSEBroadcaster } from '../../SSEBroadcaster.js';
import { DatabaseManager } from '../../DatabaseManager.js';
import { SessionManager } from '../../SessionManager.js';

export class ViewerRoutes {
  constructor(
    private sseBroadcaster: SSEBroadcaster,
    private dbManager: DatabaseManager,
    private sessionManager: SessionManager
  ) {}

  setupRoutes(app: express.Application): void {
    app.get('/health', this.handleHealth.bind(this));
    app.get('/', this.handleViewerUI.bind(this));
    app.get('/stream', this.handleSSEStream.bind(this));
  }

  /**
   * Health check endpoint
   */
  private handleHealth(req: Request, res: Response): void {
    res.json({ status: 'ok', timestamp: Date.now() });
  }

  /**
   * Serve viewer UI
   */
  private handleViewerUI(req: Request, res: Response): void {
    try {
      const packageRoot = getPackageRoot();
      const viewerPath = path.join(packageRoot, 'plugin', 'ui', 'viewer.html');
      const html = readFileSync(viewerPath, 'utf-8');
      res.setHeader('Content-Type', 'text/html');
      res.send(html);
    } catch (error) {
      logger.failure('WORKER', 'Viewer UI error', {}, error as Error);
      res.status(500).json({ error: 'Failed to load viewer UI' });
    }
  }

  /**
   * SSE stream endpoint
   */
  private handleSSEStream(req: Request, res: Response): void {
    // Setup SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    // Add client to broadcaster
    this.sseBroadcaster.addClient(res);

    // Send initial_load event with projects list
    const allProjects = this.dbManager.getSessionStore().getAllProjects();
    this.sseBroadcaster.broadcast({
      type: 'initial_load',
      projects: allProjects,
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
  }
}
