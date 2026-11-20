// The four session write endpoints (init/observations/summarize/session-end)
// create sessions, store prompts and kick off provider-bound generation, so a
// browser page served from a different localhost port must not reach them.
// Origin-less callers (hooks, the CLI, curl) keep working, including from a
// non-loopback peer: remote capture (docs/remote-worker-capture.md), Docker
// bridge clients and the OpenCode/Pi/DSH integrations post here over the
// network.
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

describe('POST /api/sessions/* write endpoints origin guard', () => {
  it('refuses every session write endpoint from a different localhost origin, before body validation', () => {
    const chains = capturePostChains(createRoutes());

    for (const path of WRITE_PATHS) {
      const chain = chains.get(path);
      expect(chain, `route ${path} must be registered`).toBeDefined();
      const { res, statusSpy, jsonSpy } = createMockRes();
      runChain(chain!, {
        ip: '127.0.0.1',
        body: {},
        headers: { origin: 'http://localhost:3000', host: '127.0.0.1:37777' },
      } as unknown as Request, res as Response);

      expect(statusSpy, path).toHaveBeenCalledWith(403);
      expect(statusSpy, path).not.toHaveBeenCalledWith(400);
      expect(jsonSpy, path).toHaveBeenCalledWith(expect.objectContaining({
        error: expect.stringContaining('origin'),
      }));
    }
  });

  it('lets an Origin-less loopback caller past the guard (it fails later on validation)', () => {
    const chains = capturePostChains(createRoutes());

    for (const path of WRITE_PATHS) {
      const { res, statusSpy } = createMockRes();
      runChain(chains.get(path)!, {
        ip: '127.0.0.1',
        body: {},
        headers: {},
      } as unknown as Request, res as Response);

      expect(statusSpy, path).not.toHaveBeenCalledWith(403);
      expect(statusSpy, path).toHaveBeenCalledWith(400);
    }
  });

  it('lets an Origin-less non-loopback peer past the guard (remote capture keeps working)', () => {
    const chains = capturePostChains(createRoutes());

    for (const path of WRITE_PATHS) {
      const { res, statusSpy } = createMockRes();
      runChain(chains.get(path)!, {
        ip: '10.0.0.5',
        body: {},
        headers: {},
      } as unknown as Request, res as Response);

      expect(statusSpy, path).not.toHaveBeenCalledWith(403);
      // Reached validateBody, which answers 400 for the empty body.
      expect(statusSpy, path).toHaveBeenCalledWith(400);
    }
  });
});
