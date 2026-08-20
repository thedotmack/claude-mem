
import express, { Request, Response } from 'express';
import path from 'path';
import { readFileSync, existsSync } from 'fs';
import { logger } from '../../../../utils/logger.js';
import { getPackageRoot } from '../../../../shared/paths.js';
import { SSEBroadcaster } from '../../SSEBroadcaster.js';
import { DatabaseManager } from '../../DatabaseManager.js';
import { SessionManager } from '../../SessionManager.js';
import { BaseRouteHandler } from '../BaseRouteHandler.js';

// Read on first request, not at import. Hook processes share this module but
// never serve the viewer, so caching at import made every hook spawn read
// viewer.html and log a boot line for nothing (#3665).
let viewerHtmlCache: { bytes: Buffer | null } | undefined;

function getViewerHtmlBytes(): Buffer | null {
  if (viewerHtmlCache) {
    return viewerHtmlCache.bytes;
  }
  const packageRoot = getPackageRoot();
  const candidates = [
    path.join(packageRoot, 'ui', 'viewer.html'),
    path.join(packageRoot, 'plugin', 'ui', 'viewer.html'),
  ];
  const resolvedPath = candidates.find((candidate) => existsSync(candidate)) ?? null;
  const bytes = resolvedPath ? readFileSync(resolvedPath) : null;
  if (resolvedPath) {
    logger.debug('SYSTEM', 'Cached viewer.html on first request', {
      path: resolvedPath,
      bytes: bytes!.byteLength,
    });
  } else {
    logger.warn('SYSTEM', 'viewer.html not found at any expected location', {
      candidates,
    });
  }
  viewerHtmlCache = { bytes };
  return bytes;
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
    const packageRoot = getPackageRoot();
    app.use(express.static(path.join(packageRoot, 'ui')));

    app.get('/health', this.handleHealth.bind(this));
    app.get('/', this.handleViewerUI.bind(this));
    app.get('/stream', this.handleSSEStream.bind(this));
  }

  private handleHealth = this.wrapHandler((req: Request, res: Response): void => {
    const activeSessions = this.sessionManager.getActiveSessionCount();

    res.json({
      status: 'ok',
      timestamp: Date.now(),
      activeSessions
    });
  });

  private handleViewerUI = this.wrapHandler((req: Request, res: Response): void => {
    const viewerHtmlBytes = getViewerHtmlBytes();
    if (!viewerHtmlBytes) {
      throw new Error('Viewer UI not found at any expected location');
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(viewerHtmlBytes);
  });

  private handleSSEStream = this.wrapHandler((req: Request, res: Response): void => {
    try {
      this.dbManager.getSessionStore();
    } catch (initError: unknown) {
      if (initError instanceof Error) {
        logger.warn('HTTP', 'SSE stream requested before DB initialization', {}, initError);
      }
      res.status(503).json({ error: 'Service initializing' });
      return;
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    this.sseBroadcaster.addClient(res);

    const projectCatalog = this.dbManager.getSessionStore().getProjectCatalog();
    this.sseBroadcaster.broadcast({
      type: 'initial_load',
      projects: projectCatalog.projects,
      sources: projectCatalog.sources,
      projectsBySource: projectCatalog.projectsBySource,
      timestamp: Date.now()
    });

    void (async () => {
      try {
        const isProcessing = await this.sessionManager.isAnySessionProcessing();
        const queueDepth = await this.sessionManager.getTotalActiveWork();
        this.sseBroadcaster.broadcast({
          type: 'processing_status',
          isProcessing,
          queueDepth
        });
      } catch (error) {
        logger.warn('HTTP', 'Failed to broadcast initial processing status', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    })();
  });
}
