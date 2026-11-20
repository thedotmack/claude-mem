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

  it('is self-contained, so a blocked CDN cannot leave a blank page', () => {
    const { html } = renderRestartPage();
    expect(html).not.toContain('<script src');
    expect(html).not.toContain('<link rel="stylesheet"');
    expect(html).not.toContain('//cdn');
  });

  // A click requirement alone does not stop clickjacking: an attacker who can
  // frame the page can collect a real click through an overlay.
  it('refuses to be framed, so an overlay cannot harvest the click', () => {
    const { headers } = renderRestartPage();
    expect(headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(headers['x-frame-options']).toBe('DENY');
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

// Local API token mode (#5141): the worker refuses /health, /api/readiness and the restart
// POST without the token, so the page must send it. Runs the page's own inline script
// against a stand-in window and clicks the button.
describe('GET /restart with a local API token', () => {
  const TOKEN_KEY = 'claude-mem.local-api-token';

  async function clickRestart(pageUrl: string, storedToken?: string) {
    const { html } = renderRestartPage();
    const script = html.slice(html.indexOf('<script>') + '<script>'.length, html.indexOf('</script>'));
    let onClick: (() => Promise<void>) | undefined;
    const button = { disabled: false, addEventListener: (_type: string, handler: () => Promise<void>) => { onClick = handler; } };
    const status = { textContent: '' };
    const storage = new Map<string, string>(storedToken ? [[TOKEN_KEY, storedToken]] : []);
    let addressBar: string | undefined;
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fakeWindow = {
      document: { getElementById: (id: string) => (id === 'go' ? button : status) },
      location: { href: pageUrl },
      sessionStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => { storage.set(key, value); } },
      history: { state: null, replaceState: (_state: unknown, _unused: string, url: string) => { addressBar = url; } },
      fetch: async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return { ok: true, status: 200, json: async () => ({ pid: -1 }) };
      },
    };
    new Function(...Object.keys(fakeWindow), script)(...Object.values(fakeWindow));
    await onClick!();
    return { calls, addressBar, storage, status: status.textContent };
  }

  const tokenOf = (init: RequestInit) => (init.headers as Record<string, string> | undefined)?.['X-Claude-Mem-Token'];

  it("sends the page URL's ?token= on the restart POST and both checks, then drops it from the address bar", async () => {
    const run = await clickRestart('http://localhost:37777/restart?token=restart-secret');
    expect(run.calls.map(call => call.url)).toEqual(['/api/admin/restart', '/health', '/api/readiness']);
    for (const call of run.calls) expect(tokenOf(call.init)).toBe('restart-secret');
    expect(run.addressBar).toBe('/restart');
    expect(run.storage.get(TOKEN_KEY)).toBe('restart-secret');
    expect(run.status).toContain('restarted');
  });

  it('uses the token a viewer tab kept when the URL has none', async () => {
    const run = await clickRestart('http://localhost:37777/restart', 'kept-secret');
    for (const call of run.calls) expect(tokenOf(call.init)).toBe('kept-secret');
    expect(run.addressBar).toBeUndefined();
  });

  it('sends no header at all when there is no token', async () => {
    const run = await clickRestart('http://localhost:37777/restart');
    expect(run.calls).toHaveLength(3);
    for (const call of run.calls) expect(call.init.headers).toBeUndefined();
  });
});
