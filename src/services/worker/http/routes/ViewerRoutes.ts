
import express, { Request, Response } from 'express';
import path from 'path';
import { readFileSync, existsSync } from 'fs';
import { logger } from '../../../../utils/logger.js';
import { getPackageRoot } from '../../../../shared/paths.js';
import { SSEBroadcaster } from '../../SSEBroadcaster.js';
import { DatabaseManager } from '../../DatabaseManager.js';
import { SessionManager } from '../../SessionManager.js';
import { BaseRouteHandler } from '../BaseRouteHandler.js';

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

/**
 * Self-contained (no external resources — the worker serves this on localhost
 * and a blocked CDN would leave a blank page). Polls /health after the POST
 * because the restart kills this worker and its successor needs a moment to
 * bind the port.
 */
const RESTART_PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Restart claude-mem worker</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center;
         font: 15px/1.55 ui-sans-serif, system-ui, -apple-system, sans-serif;
         background: #f6f6f5; color: #1c1c1a; }
  @media (prefers-color-scheme: dark) { body { background: #161614; color: #eeeeec; } }
  main { width: min(30rem, 90vw); text-align: center; }
  h1 { font-size: 1.25rem; margin: 0 0 .5rem; }
  p { margin: 0 0 1.5rem; opacity: .75; }
  button { font: inherit; font-weight: 600; padding: .7rem 1.4rem; border: 0; border-radius: .5rem;
           background: #c15f3c; color: #fff; cursor: pointer; }
  button:hover:not(:disabled) { background: #a94f30; }
  button:disabled { opacity: .5; cursor: default; }
  #status { margin-top: 1.25rem; min-height: 1.5rem; font-variant-numeric: tabular-nums; }
</style>
</head>
<body>
<main>
  <h1>Restart the claude-mem memory worker</h1>
  <p>The memory observer stopped saving. A restart clears almost every outage.</p>
  <button id="go" type="button">Restart worker</button>
  <div id="status" role="status" aria-live="polite"></div>
</main>
<script>
  const button = document.getElementById('go');
  const status = document.getElementById('status');

  async function waitForWorker(deadlineMs) {
    while (Date.now() < deadlineMs) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      try {
        const health = await fetch('/health', { cache: 'no-store' });
        if (health.ok) return true;
      } catch {
        // Expected while the old worker is down and the successor is booting.
      }
    }
    return false;
  }

  button.addEventListener('click', async () => {
    button.disabled = true;
    status.textContent = 'Restarting…';
    try {
      await fetch('/api/admin/restart', { method: 'POST' });
    } catch {
      // The worker often dies before the response lands — that is the restart
      // working, so fall through to the health poll either way.
    }
    if (await waitForWorker(Date.now() + 30000)) {
      status.textContent = 'Memory worker restarted. You can close this tab.';
    } else {
      status.textContent = 'Still not answering. Run: npx claude-mem doctor';
      button.disabled = false;
    }
  });
</script>
</body>
</html>`;

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
    app.get('/restart', this.handleRestartPage.bind(this));
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
    if (!viewerHtmlBytes) {
      throw new Error('Viewer UI not found at any expected location');
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(viewerHtmlBytes);
  });

  /**
   * The target of the restart link in the observer-outage warning
   * (renderObserverHealthWarning). Serves an INERT page: the restart itself is
   * the POST /api/admin/restart behind the button, never this GET.
   *
   * A GET that restarted the worker would fire from any page that could name
   * the URL — `<img src="http://localhost:PORT/restart">` on a site the user
   * happens to open is enough. Same reason the page does not POST on load: an
   * <iframe> would run that script. It takes a real click, on a page served
   * from the worker's own origin.
   */
  private handleRestartPage = this.wrapHandler((req: Request, res: Response): void => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.send(RESTART_PAGE_HTML);
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
