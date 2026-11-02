
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
// never serve the viewer or Observation TV, so reading at import made every
// hook spawn read both HTML files and log a boot line for nothing (#3665).
//
// Only a successful read is cached. A miss checks the disk again on the next
// request, so a worker that outlives its plugin folder (an update that swaps
// the cache directory) recovers once the file is back, instead of failing
// every page load until a restart.
export function lazyUiHtml(
  fileName: string,
  resolvePackageRoot: () => string = getPackageRoot,
): () => Buffer | null {
  let cached: Buffer | undefined;
  return () => {
    if (cached) {
      return cached;
    }
    const packageRoot = resolvePackageRoot();
    const candidates = [
      path.join(packageRoot, 'ui', fileName),
      path.join(packageRoot, 'plugin', 'ui', fileName),
    ];
    const resolvedPath = candidates.find((candidate) => existsSync(candidate));
    if (!resolvedPath) {
      logger.warn('SYSTEM', `${fileName} not found at any expected location`, { candidates });
      return null;
    }
    cached = readFileSync(resolvedPath);
    logger.debug('SYSTEM', `Cached ${fileName} on first request`, {
      path: resolvedPath,
      bytes: cached.byteLength,
    });
    return cached;
  };
}

const getViewerHtmlBytes = lazyUiHtml('viewer.html');
const getWorkViewHtmlBytes = lazyUiHtml('work-view/index.html');
const getTvHtmlBytes = lazyUiHtml('tv.html');

/**
 * Served with a 503 when a UI file is missing from the install. This is an
 * install state, not a worker fault, so it does not go to error tracking. The
 * usual cause is a worker that kept running while an update replaced its
 * plugin folder; a restart loads the new install.
 */
export function sendUiMissingPage(res: Response, uiName: string): void {
  res.status(503);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.send(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${uiName} unavailable</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center;
         font: 15px/1.55 ui-sans-serif, system-ui, -apple-system, sans-serif; }
  main { width: min(30rem, 90vw); text-align: center; }
  h1 { font-size: 1.25rem; margin: 0 0 .5rem; }
  p { margin: 0 0 1rem; opacity: .75; }
</style>
</head>
<body>
<main>
  <h1>${uiName} files are missing</h1>
  <p>The claude-mem worker cannot find its UI files. This usually happens when claude-mem updates while the worker keeps running.</p>
  <p><a href="/restart">Restart the worker</a> to load the current install. If the page stays missing, run <code>npx claude-mem doctor</code>.</p>
</main>
</body>
</html>`);
}

/**
 * Self-contained (no external resources — the worker serves this on localhost
 * and a blocked CDN would leave a blank page).
 *
 * Success requires two things of the successor, because each without the other
 * reports a restart that has not happened:
 *
 * - A DIFFERENT pid on /health than the worker that served this page. The dying
 *   worker keeps answering through the whole graceful-shutdown window, far
 *   longer than the first poll, so "healthy" alone confirms the corpse.
 * - /api/readiness ok. A bound port is not a ready worker; the successor opens
 *   the database, bootstraps chroma and connects MCP after it starts listening.
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

  const outgoingPid = ${process.pid};

  // A stalled connection or JSON body must not hold the recovery page forever.
  // Each operation is bounded, within the same overall restart deadline.
  async function withRequestDeadline(deadlineMs, operation) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(5000, Math.max(0, deadlineMs - Date.now())));
    try {
      return await operation(controller.signal);
    } finally {
      clearTimeout(timer);
    }
  }

  async function successorIsReady(deadlineMs) {
    return withRequestDeadline(deadlineMs, async (signal) => {
      const health = await fetch('/health', { cache: 'no-store', signal });
      if (!health.ok) return false;
      const body = await health.json();
      // No pid means a worker too old to report one — fall back to "healthy"
      // rather than hanging until the deadline.
      if (typeof body.pid === 'number' && body.pid === outgoingPid) return false;
  
      // Binding the port is not being ready to observe: the successor opens the
      // database, bootstraps chroma and connects MCP after it starts listening,
      // and readiness stays 503 through all of it. This is the same signal the
      // CLI restart path verifies. 404 means a worker too old to expose it.
      const readiness = await fetch('/api/readiness', { cache: 'no-store', signal });
      return readiness.ok || readiness.status === 404;
    });
  }

  async function waitForSuccessor(deadlineMs) {
    while (Date.now() < deadlineMs) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(500, Math.max(0, deadlineMs - Date.now()))));
      try {
        if (Date.now() < deadlineMs && await successorIsReady(deadlineMs) && Date.now() < deadlineMs) return true;
      } catch {
        // Expected while the old worker is down and the successor is booting.
      }
    }
    return false;
  }

  button.addEventListener('click', async () => {
    button.disabled = true;
    status.textContent = 'Restarting…';
    const deadlineMs = Date.now() + 60000;
    try {
      await withRequestDeadline(deadlineMs, signal => fetch('/api/admin/restart', { method: 'POST', signal }));
    } catch {
      // The worker often dies before the response lands — that is the restart
      // working, so fall through to the health poll either way.
    }
    if (await waitForSuccessor(deadlineMs)) {
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
    app.use('/work-view', (_req, res, next) => {
      // The static entry point needs the same clickjacking protection as /.
      res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
      res.setHeader('X-Frame-Options', 'DENY');
      next();
    });
    app.use(express.static(path.join(packageRoot, 'ui')));

    app.get('/health', this.handleHealth.bind(this));
    app.get('/', this.handleWorkViewUI.bind(this));
    app.get('/viewer', this.handleViewerUI.bind(this));
    app.get('/tv', this.handleTvUI.bind(this));
    app.get('/restart', this.handleRestartPage.bind(this));
    app.get('/stream', this.handleSSEStream.bind(this));
  }

  private handleHealth = this.wrapHandler((req: Request, res: Response): void => {
    const activeSessions = this.sessionManager.getActiveSessionCount();

    res.json({
      status: 'ok',
      timestamp: Date.now(),
      activeSessions,
      // Per-process identity, so a caller waiting out a restart can tell the
      // successor from the worker it just asked to die. The dying worker keeps
      // answering here for the whole graceful-shutdown window.
      pid: process.pid,
    });
  });

  private handleViewerUI = this.wrapHandler((req: Request, res: Response): void => {
    // The viewer can delete observations and save settings, and its requests
    // are same-origin, so the worker's foreign-page guards treat them as its
    // own. Refuse framing here like the work-view and restart routes do.
    res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
    res.setHeader('X-Frame-Options', 'DENY');
    const viewerHtmlBytes = getViewerHtmlBytes();
    if (!viewerHtmlBytes) {
      sendUiMissingPage(res, 'Viewer');
      return;
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(viewerHtmlBytes);
  });

  private handleWorkViewUI = this.wrapHandler((req: Request, res: Response): void => {
    const html = getWorkViewHtmlBytes();
    if (!html) {
      sendUiMissingPage(res, 'My Work');
      return;
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
    res.setHeader('X-Frame-Options', 'DENY');
    res.send(html);
  });

  /**
   * Observation TV: the same /stream the viewer consumes, rendered as a
   * full-screen fading title card. Static, dependency-free, and served from
   * the same origin so the EventSource needs no CORS of its own.
   */
  private handleTvUI = this.wrapHandler((req: Request, res: Response): void => {
    const tvHtmlBytes = getTvHtmlBytes();
    if (!tvHtmlBytes) {
      sendUiMissingPage(res, 'Observation TV');
      return;
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(tvHtmlBytes);
  });

  /**
   * The target of the restart link in the observer-outage warning
   * (renderObserverHealthWarning). Serves an INERT page: the restart itself is
   * the POST /api/admin/restart behind the button, never this GET.
   *
   * A GET that restarted the worker would fire from any page that could name
   * the URL — `<img src="http://localhost:PORT/restart">` on a site the user
   * happens to open is enough. Same reason the page does not POST on load: an
   * <iframe> would run that script.
   *
   * Requiring a click is NOT on its own enough, though: an attacker who frames
   * this page can still collect a real click through an overlay. So the route
   * also refuses to be framed at all — frame-ancestors 'none' for modern
   * browsers, X-Frame-Options for the rest.
   */
  private handleRestartPage = this.wrapHandler((req: Request, res: Response): void => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
    res.setHeader('X-Frame-Options', 'DENY');
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
