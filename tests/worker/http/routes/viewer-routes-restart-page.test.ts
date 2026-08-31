import { describe, it, expect, mock } from 'bun:test';
import type { Request, Response } from 'express';
import { ViewerRoutes } from '../../../../src/services/worker/http/routes/ViewerRoutes.js';

/**
 * The restart page is the target of the link in the observer-outage warning.
 * Its whole safety property is that the GET is inert: the restart is a POST
 * behind a real click, so a page that merely names this URL — in an <img>, in
 * an <iframe> — cannot bounce someone's worker.
 */
function captureRestartHandler(): (req: Request, res: Response) => void {
  let captured: ((req: Request, res: Response) => void) | undefined;
  const mockApp: any = {
    use: mock(() => {}),
    get: mock((path: string, handler: (req: Request, res: Response) => void) => {
      if (path === '/restart') captured = handler;
    }),
  };

  new ViewerRoutes(null as any, null as any, null as any).setupRoutes(mockApp);
  if (!captured) throw new Error('ViewerRoutes did not register GET /restart');
  return captured;
}

function renderRestartPage(): { html: string; headers: Record<string, string> } {
  const headers: Record<string, string> = {};
  let html = '';
  const res = {
    setHeader: (name: string, value: string) => { headers[name.toLowerCase()] = value; },
    send: (body: string) => { html = body; },
  } as unknown as Response;

  captureRestartHandler()({} as Request, res);
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
});
