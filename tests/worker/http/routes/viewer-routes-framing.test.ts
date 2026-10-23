import { describe, it, expect, mock } from 'bun:test';
import express, { type Request, type Response } from 'express';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { ViewerRoutes } from '../../../../src/services/worker/http/routes/ViewerRoutes.js';
import { createMiddleware } from '../../../../src/services/worker/http/middleware.js';

/**
 * The viewer is the page that can delete observations and save settings. Its
 * requests are same-origin, so the worker's foreign-origin DELETE and settings
 * guards correctly treat them as the viewer's own page. A hostile site that can
 * frame the viewer can therefore harvest real clicks on those actions through an
 * overlay. The work-view and restart routes already refuse framing; the viewer
 * must too, through both the `/viewer` handler and the `/viewer.html` static
 * file the build also ships, however its URL is spelled.
 */
function captureRoutes(route: string): {
  get: ((req: Request, res: Response) => void) | undefined;
} {
  const getHandlers = new Map<string, (req: Request, res: Response) => void>();
  const mockApp: any = {
    use: mock(() => {}),
    get: mock((path: string, handler: (req: Request, res: Response) => void) => {
      getHandlers.set(path, handler);
    }),
  };

  new ViewerRoutes(null as any, null as any, null as any).setupRoutes(mockApp);
  const get = getHandlers.get(route);
  if (!get) throw new Error(`ViewerRoutes did not register GET ${route}`);
  return { get };
}

function mockResponse(headers: Record<string, string>): Response {
  return {
    statusCode: 200,
    setHeader: (name: string, value: string) => { headers[name.toLowerCase()] = value; },
    status(code: number) { this.statusCode = code; return this; },
    type() { return this; },
    send() { return this; },
    json() { return this; },
  } as unknown as Response;
}

describe('GET /viewer', () => {
  it('refuses to be framed, so an overlay cannot harvest clicks on delete or settings', () => {
    const headers: Record<string, string> = {};
    const { get } = captureRoutes('/viewer');

    get({} as Request, mockResponse(headers));

    expect(headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(headers['x-frame-options']).toBe('DENY');
  });
});

describe('static /viewer.html', () => {
  /**
   * The real worker order: createMiddleware() first, then the static UI mount
   * ViewerRoutes adds. `send` decodes and normalizes the URL before it picks a
   * file, so a check keyed on `req.path` alone misses these spellings.
   */
  async function withWorkerStaticMount(run: (baseUrl: string) => Promise<void>): Promise<void> {
    const dir = mkdtempSync(join(tmpdir(), 'claude-mem-viewer-static-'));
    writeFileSync(join(dir, 'viewer.html'), '<html>viewer</html>');
    writeFileSync(join(dir, 'tv.html'), '<html>tv</html>');

    const app = express();
    createMiddleware().forEach((middleware) => app.use(middleware));
    app.use(express.static(dir));
    app.get('/tv', (_req, res) => { res.send('<html>tv</html>'); });
    const server = await new Promise<ReturnType<typeof app.listen>>((resolve, reject) => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
      listening.once('error', reject);
    });

    try {
      const { port } = server.address() as AddressInfo;
      await run(`http://127.0.0.1:${port}`);
    } finally {
      (server as any).closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  }

  // `fetch` would normalize some of these spellings itself, so send them raw.
  function getRaw(baseUrl: string, rawPath: string): Promise<{ status: number; headers: Record<string, string | string[] | undefined> }> {
    const { hostname, port } = new URL(baseUrl);
    return new Promise((resolve, reject) => {
      const req = httpRequest({ hostname, port, path: rawPath, method: 'GET' }, (res) => {
        res.resume();
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers }));
      });
      req.once('error', reject);
      req.end();
    });
  }

  for (const rawPath of ['/viewer.html', '/viewer%2Ehtml', '/%76iewer.html', '/Viewer.html', '//viewer.html']) {
    it(`refuses framing for ${rawPath}, so the same page cannot be framed by file URL`, async () => {
      await withWorkerStaticMount(async (baseUrl) => {
        const response = await getRaw(baseUrl, rawPath);
        // `/Viewer.html` only reaches the file on a case-insensitive disk
        // (macOS, Windows); elsewhere it is a 404 with no page to frame.
        if (rawPath === '/Viewer.html' && response.status === 404) return;
        expect(response.status).toBe(200);
        expect(response.headers['content-security-policy']).toContain("frame-ancestors 'none'");
        expect(response.headers['x-frame-options']).toBe('DENY');
      });
    });
  }

  it('serves the encoded and double-slash spellings as the viewer file itself', async () => {
    await withWorkerStaticMount(async (baseUrl) => {
      for (const rawPath of ['/viewer%2Ehtml', '/%76iewer.html', '//viewer.html']) {
        expect((await getRaw(baseUrl, rawPath)).status).toBe(200);
      }
    });
  });

  it('still lets Observation TV be framed', async () => {
    await withWorkerStaticMount(async (baseUrl) => {
      for (const rawPath of ['/tv.html', '/tv']) {
        const response = await getRaw(baseUrl, rawPath);
        expect(response.status).toBe(200);
        expect(response.headers['x-frame-options']).toBeUndefined();
        expect(response.headers['content-security-policy']).toBeUndefined();
      }
    });
  });
});
