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
import { SSEBroadcaster } from '../../SSEBroadcaster.js';
import { DatabaseManager } from '../../DatabaseManager.js';
import { SessionManager } from '../../SessionManager.js';
import { BaseRouteHandler } from '../BaseRouteHandler.js';

/**
 * Plan 06 Phase 6 — viewer.html is loaded once at module init and held in
 * memory for the lifetime of the worker process. Process restart is the
 * cache-invalidation event; no fs.watch, no TTL, no refresh.
 *
 * We probe the same two on-disk locations the legacy handler did so the
 * dev (cache) and installed (marketplace) layouts both keep working.
 */
const VIEWER_HTML_CANDIDATE_PATHS: readonly string[] = (() => {
  const packageRoot = getPackageRoot();
  return [
    path.join(packageRoot, 'ui', 'viewer.html'),
    path.join(packageRoot, 'plugin', 'ui', 'viewer.html'),
  ];
})();

const resolvedViewerHtmlPath: string | null =
  VIEWER_HTML_CANDIDATE_PATHS.find((candidate) => existsSync(candidate)) ?? null;

const viewerHtmlBytes: Buffer | null = resolvedViewerHtmlPath
  ? readFileSync(resolvedViewerHtmlPath)
  : null;

if (resolvedViewerHtmlPath) {
  logger.info('SYSTEM', 'Cached viewer.html at boot', {
    path: resolvedViewerHtmlPath,
    bytes: viewerHtmlBytes!.byteLength,
  });
} else {
  logger.warn('SYSTEM', 'viewer.html not found at any expected location at boot', {
    candidates: VIEWER_HTML_CANDIDATE_PATHS,
  });
}

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
    // Include queue liveness info so monitoring can detect dead queues (#1867)
    const activeSessions = this.sessionManager.getActiveSessionCount();

    res.json({
      status: 'ok',
      timestamp: Date.now(),
      activeSessions
    });
  });

  /**
   * Serve viewer UI from the in-memory cache populated at module init.
   * Plan 06 Phase 6 — single read at boot, no per-request fs hit.
   */
  private handleViewerUI = this.wrapHandler((req: Request, res: Response): void => {
    if (!viewerHtmlBytes) {
      throw new Error('Viewer UI not found at any expected location');
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(viewerHtmlBytes);
  });

  /**
   * SSE stream endpoint
   */
  private handleSSEStream = this.wrapHandler((req: Request, res: Response): void => {
    // Guard: if DB is not yet initialized, return 503 before registering client
    try {
      this.dbManager.getSessionStore();
    } catch (initError: unknown) {
      if (initError instanceof Error) {
        logger.warn('HTTP', 'SSE stream requested before DB initialization', {}, initError);
      }
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
