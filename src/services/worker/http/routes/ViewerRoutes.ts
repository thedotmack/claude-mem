/**
 * Viewer Routes
 *
 * Handles health check, viewer UI, and SSE stream endpoints.
 * These are used by the web viewer UI at http://localhost:37777
 */

import type { Request, Response } from 'express';
import express from 'express';
import path from 'path';
import { logger } from '../../../../utils/logger.js'; // eslint-disable-line @typescript-eslint/no-unused-vars -- required by logger-usage-standards
import { readFileSync, existsSync } from 'fs';
import { getPackageRoot } from '../../../../shared/paths.js';
import type { SSEBroadcaster } from '../../SSEBroadcaster.js';
import type { DatabaseManager } from '../../DatabaseManager.js';
import type { SessionManager } from '../../SessionManager.js';
import { BaseRouteHandler } from '../BaseRouteHandler.js';

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
  }

  /**
   * Health check endpoint
   */
  private handleHealth = this.wrapHandler((req: Request, res: Response): void => {
    res.json({ status: 'ok', timestamp: Date.now() });
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
   * Detect the most recent session with unsummarized observations.
   * Returns session info for the SSE initial_load event, or null if none.
   */
  private getActiveSessionInfo(): { memorySessionId: string; contentSessionId: string; project: string; observationCount: number } | null {
    const db = this.dbManager.getSessionStore().db;

    // Find the most recent observation's session, then check if it has unsummarized content
    const latestObs = db.prepare(`
      SELECT o.memory_session_id, s.content_session_id, o.project
      FROM observations o
      LEFT JOIN sdk_sessions s ON o.memory_session_id = s.memory_session_id
      ORDER BY o.created_at_epoch DESC
      LIMIT 1
    `).get() as { memory_session_id: string; content_session_id: string | null; project: string } | undefined;

    if (!latestObs) return null;

    // Find the latest summary epoch for this session
    const latestSummary = db.prepare(`
      SELECT MAX(created_at_epoch) as epoch
      FROM session_summaries
      WHERE memory_session_id = ?
    `).get(latestObs.memory_session_id) as { epoch: number | null } | undefined;

    const afterEpoch = latestSummary?.epoch ?? 0;

    // Count unsummarized observations
    const countResult = db.prepare(`
      SELECT COUNT(*) as count
      FROM observations
      WHERE memory_session_id = ?
        AND created_at_epoch > ?
    `).get(latestObs.memory_session_id, afterEpoch) as { count: number };

    return {
      memorySessionId: latestObs.memory_session_id,
      contentSessionId: latestObs.content_session_id ?? latestObs.memory_session_id,
      project: latestObs.project,
      observationCount: countResult.count,
    };
  }

  /**
   * SSE stream endpoint
   */
  private handleSSEStream = this.wrapHandler((req: Request, res: Response): void => {
    // Setup SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    // Add client to broadcaster
    this.sseBroadcaster.addClient(res);

    // Send initial_load event with projects list and active session info
    const allProjects = this.dbManager.getSessionStore().getAllProjects();
    const activeSession = this.getActiveSessionInfo();
    this.sseBroadcaster.broadcast({
      type: 'initial_load',
      projects: allProjects,
      activeSession,
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
