// The four session write endpoints (init/observations/summarize/session-end)
// create sessions, store prompts and kick off provider-bound generation, so
// they get the same localhost-only posture as their sibling /api/processing
// (which already mounts requireLocalhost "like the other admin routes").
// Origin-less loopback callers (hooks, the viewer) keep working: only a
// non-loopback socket peer is refused.
import { describe, expect, it, mock } from 'bun:test';
import type { Request, Response } from 'express';
import { SessionRoutes } from '../../../../src/services/worker/http/routes/SessionRoutes.js';

const WRITE_PATHS = [
  '/api/sessions/init',
  '/api/sessions/observations',
  '/api/sessions/summarize',
  '/api/sessions/session-end',
] as const;

function createMockRes(): {
  res: Partial<Response>;
  jsonSpy: ReturnType<typeof mock>;
  statusSpy: ReturnType<typeof mock>;
} {
  const jsonSpy = mock(() => {});
  const statusSpy = mock(() => ({ json: jsonSpy }));
  return {
    res: { json: jsonSpy, status: statusSpy, headersSent: false } as unknown as Partial<Response>,
    jsonSpy,
    statusSpy,
  };
}

function createRoutes(): SessionRoutes {
  const dummy = {} as never;
  return new SessionRoutes(dummy, dummy, dummy, dummy, dummy, dummy, dummy, dummy);
}

function capturePostChains(routes: SessionRoutes): Map<string, Array<(req: Request, res: Response, next: () => void) => void>> {
  const chains = new Map<string, Array<(req: Request, res: Response, next: () => void) => void>>();
  const mockApp: any = {
    get: mock(() => {}),
    post: mock((path: string, ...handlers: Array<(req: Request, res: Response, next: () => void) => void>) => {
      chains.set(path, handlers);
    }),
  };
  routes.setupRoutes(mockApp);
  return chains;
}

function runChain(
  chain: Array<(req: Request, res: Response, next: () => void) => void>,
  req: Request,
  res: Response,
): void {
  let index = 0;
  const next = (): void => {
    const handler = chain[index++];
    if (handler) handler(req, res, next);
  };
  next();
}

describe('POST /api/sessions/* write endpoints localhost guard', () => {
  it('refuses every session write endpoint from a non-loopback peer', () => {
    const chains = capturePostChains(createRoutes());

    for (const path of WRITE_PATHS) {
      const chain = chains.get(path);
      expect(chain, `route ${path} must be registered`).toBeDefined();
      // The guard must run before body validation.
      const { res, statusSpy, jsonSpy } = createMockRes();
      runChain(chain!, {
        ip: '10.0.0.5',
        body: {},
        headers: {},
      } as unknown as Request, res as Response);

      expect(statusSpy, path).toHaveBeenCalledWith(403);
      expect(jsonSpy, path).toHaveBeenCalledWith(expect.objectContaining({
        message: expect.stringContaining('localhost'),
      }));
    }
  });

  it('lets a loopback peer past the guard (it fails later on validation, not the guard)', () => {
    const chains = capturePostChains(createRoutes());

    for (const path of WRITE_PATHS) {
      const { res, statusSpy } = createMockRes();
      runChain(chains.get(path)!, {
        ip: '127.0.0.1',
        body: {},
        headers: {},
      } as unknown as Request, res as Response);

      expect(statusSpy, path).not.toHaveBeenCalledWith(403);
      // Reached validateBody, which answers 400 for the empty body.
      expect(statusSpy, path).toHaveBeenCalledWith(400);
    }
  });

  it('rejects a same-origin-but-other-port browser page on every session write endpoint', () => {
    const chains = capturePostChains(createRoutes());

    for (const path of WRITE_PATHS) {
      const chain = chains.get(path);
      expect(chain, `route ${path} must be registered`).toBeDefined();
      const { res, statusSpy, jsonSpy } = createMockRes();
      runChain(chain!, {
        ip: '127.0.0.1',
        body: {},
        headers: { origin: 'http://localhost:5173', host: '127.0.0.1:37777' },
      } as unknown as Request, res as Response);

      expect(statusSpy, path).toHaveBeenCalledWith(403);
      expect(jsonSpy, path).toHaveBeenCalledWith(expect.objectContaining({
        error: expect.stringContaining('origin'),
      }));
    }
  });
});