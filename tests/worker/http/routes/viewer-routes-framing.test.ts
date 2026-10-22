import { describe, it, expect, mock } from 'bun:test';
import express, { type NextFunction, type Request, type Response } from 'express';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ViewerRoutes,
  refuseViewerHtmlFraming,
} from '../../../../src/services/worker/http/routes/ViewerRoutes.js';

/**
 * The viewer is the page that can delete observations and save settings. Its
 * requests are same-origin, so the worker's foreign-origin DELETE and settings
 * guards correctly treat them as the viewer's own page. A hostile site that can
 * frame the viewer can therefore harvest real clicks on those actions through an
 * overlay. The work-view and restart routes already refuse framing; the viewer
 * must too, through both the `/viewer` handler and the `/viewer.html` static
 * file the build also ships.
 */
function captureRoutes(route: string): {
  get: ((req: Request, res: Response) => void) | undefined;
  use: Array<(req: Request, res: Response, next: NextFunction) => void>;
} {
  const getHandlers = new Map<string, (req: Request, res: Response) => void>();
  const useHandlers: Array<(req: Request, res: Response, next: NextFunction) => void> = [];
  const mockApp: any = {
    use: mock((first: unknown, second?: unknown) => {
      const handler = typeof first === 'function' ? first : second;
      if (typeof handler === 'function') useHandlers.push(handler);
    }),
    get: mock((path: string, handler: (req: Request, res: Response) => void) => {
      getHandlers.set(path, handler);
    }),
  };

  new ViewerRoutes(null as any, null as any, null as any).setupRoutes(mockApp);
  const get = getHandlers.get(route);
  if (!get) throw new Error(`ViewerRoutes did not register GET ${route}`);
  return { get, use: useHandlers };
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
  it('is guarded before the static mount, so the same page cannot be framed by file URL', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-mem-viewer-static-'));
    writeFileSync(join(dir, 'viewer.html'), '<html>viewer</html>');
    writeFileSync(join(dir, 'tv.html'), '<html>tv</html>');

    const app = express();
    app.use(refuseViewerHtmlFraming);
    app.use(express.static(dir));
    const server = await new Promise<ReturnType<typeof app.listen>>((resolve, reject) => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
      listening.once('error', reject);
    });

    try {
      const { port } = server.address() as AddressInfo;
      const viewer = await fetch(`http://127.0.0.1:${port}/viewer.html`);
      await viewer.text();
      expect(viewer.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
      expect(viewer.headers.get('x-frame-options')).toBe('DENY');

      const tv = await fetch(`http://127.0.0.1:${port}/tv.html`);
      await tv.text();
      expect(tv.headers.get('x-frame-options')).toBeNull();
    } finally {
      (server as any).closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('registers that guard on the real route table', () => {
    const { use } = captureRoutes('/viewer');

    expect(use).toContain(refuseViewerHtmlFraming);
  });
});
