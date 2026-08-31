import { describe, it, expect, mock } from 'bun:test';
import type { Request, Response } from 'express';
import { ViewerRoutes } from '../../../../src/services/worker/http/routes/ViewerRoutes.js';

/**
 * The restart page is the target of the link in the observer-outage warning.
 * Two properties keep a hostile page from bouncing someone's worker: the GET is
 * inert (the restart is a POST behind a real click, so an <img> cannot fire it),
 * and the route refuses to be framed (so an attacker cannot frame the page and
 * harvest that click through an overlay).
 */
function captureHandler(route: string, routes?: ViewerRoutes): (req: Request, res: Response) => void {
  let captured: ((req: Request, res: Response) => void) | undefined;
  const mockApp: any = {
    use: mock(() => {}),
    get: mock((path: string, handler: (req: Request, res: Response) => void) => {
      if (path === route) captured = handler;
    }),
  };

  (routes ?? new ViewerRoutes(null as any, null as any, null as any)).setupRoutes(mockApp);
  if (!captured) throw new Error(`ViewerRoutes did not register GET ${route}`);
  return captured;
}

function renderRestartPage(): { html: string; headers: Record<string, string> } {
  const headers: Record<string, string> = {};
  let html = '';
  const res = {
    setHeader: (name: string, value: string) => { headers[name.toLowerCase()] = value; },
    send: (body: string) => { html = body; },
  } as unknown as Response;

  captureHandler('/restart')({} as Request, res);
  return { html, headers };
}

describe('GET /restart', () => {
  it('serves an HTML page', () => {
    const { html, headers } = renderRestartPage();
    expect(headers['content-type']).toContain('text/html');
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('Restart the claude-mem memory worker');
  });

  it('never restarts on load — the POST is bound to a click, so an <img> or <iframe> cannot fire it', () => {
    const { html } = renderRestartPage();
    const clickBinding = html.indexOf("addEventListener('click'");
    const restartPost = html.indexOf("fetch('/api/admin/restart'");

    expect(clickBinding).toBeGreaterThan(-1);
    expect(restartPost).toBeGreaterThan(clickBinding);
    expect(html).toContain("method: 'POST'");
  });

  it('is self-contained, so a blocked CDN cannot leave a blank page', () => {
    const { html } = renderRestartPage();
    expect(html).not.toContain('<script src');
    expect(html).not.toContain('<link rel="stylesheet"');
    expect(html).not.toContain('//cdn');
  });

  it('sends the reader to doctor when the worker does not come back', () => {
    const { html } = renderRestartPage();
    expect(html).toContain('npx claude-mem doctor');
  });

  // A click requirement alone does not stop clickjacking: an attacker who can
  // frame the page can collect a real click through an overlay.
  it('refuses to be framed, so an overlay cannot harvest the click', () => {
    const { headers } = renderRestartPage();
    expect(headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(headers['x-frame-options']).toBe('DENY');
  });

  // The dying worker answers /health for the whole graceful-shutdown window,
  // so "healthy" alone reports success against the worker we just killed.
  it('waits for a different pid rather than any healthy response', () => {
    const { html } = renderRestartPage();
    expect(html).toContain(`const outgoingPid = ${process.pid};`);
    expect(html).toContain('body.pid !== outgoingPid');
  });

  it('still finishes against a worker too old to report a pid', () => {
    const { html } = renderRestartPage();
    expect(html).toContain("typeof body.pid !== 'number'");
  });
});

describe('GET /health', () => {
  function readHealth(): Record<string, unknown> {
    let payload: Record<string, unknown> = {};
    const res = { json: (body: Record<string, unknown>) => { payload = body; } } as unknown as Response;
    const routes = new ViewerRoutes(null as any, null as any, { getActiveSessionCount: () => 0 } as any);
    captureHandler('/health', routes)({} as Request, res);
    return payload;
  }

  it('reports the serving process identity so a restart can be confirmed', () => {
    expect(readHealth().pid).toBe(process.pid);
    expect(readHealth().status).toBe('ok');
  });
});
