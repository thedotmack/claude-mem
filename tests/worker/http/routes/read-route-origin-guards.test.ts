// A read route that resolves a project from a caller-supplied `cwd` runs `git`
// in that directory (src/utils/project-name.ts findGitRepoRoot). The write half
// of the same route already refuses another localhost origin (#5200); a read
// half that executes a process must refuse it too, so a page served on any
// other localhost port cannot steer the worker into a directory it names.
import { describe, expect, it, mock } from 'bun:test';
import type { Request, Response } from 'express';
import { WorkStateRoutes } from '../../../../src/services/worker/http/routes/WorkStateRoutes.js';
import { SearchRoutes } from '../../../../src/services/worker/http/routes/SearchRoutes.js';

function createMockRes(): { res: Response; statusSpy: ReturnType<typeof mock>; jsonSpy: ReturnType<typeof mock> } {
  const jsonSpy = mock(() => {});
  const statusSpy = mock(() => ({ json: jsonSpy }));
  const res = {
    headersSent: false,
    json: jsonSpy,
    status: statusSpy,
    setHeader: mock(() => {}),
    send: mock(() => {}),
    end: mock(() => {}),
    on: mock(() => {}),
    off: mock(() => {}),
  } as unknown as Response;
  return { res, statusSpy, jsonSpy };
}

/** Mounts a route class on a fake express app and returns the handler registered for a GET path. */
function captureGetHandler(routes: { setupRoutes: (app: any) => void }, path: string): (req: Request, res: Response) => void {
  let handler: ((req: Request, res: Response) => void) | undefined;
  routes.setupRoutes({
    use: mock(() => {}),
    get: mock((registered: string, routeHandler: (req: Request, res: Response) => void) => {
      if (registered === path) handler = routeHandler;
    }),
    post: mock(() => {}),
    delete: mock(() => {}),
  } as any);
  if (!handler) throw new Error(`route GET ${path} was not registered`);
  return handler;
}

function workStateRoutes() {
  return new WorkStateRoutes({
    getSessionStore: () => ({ getWorkStateEntries: () => [], appendWorkStateEntry: () => 1 }),
    getCloudSync: () => null,
  } as any);
}

function searchRoutes() {
  return new SearchRoutes({} as any);
}

describe('GET /api/work-state origin guard', () => {
  it('rejects a read from a different localhost origin before resolving the project', () => {
    const handler = captureGetHandler(workStateRoutes(), '/api/work-state');
    const { res, statusSpy, jsonSpy } = createMockRes();

    handler(
      {
        query: { cwd: '/tmp/proj' },
        headers: { origin: 'http://localhost:3000', host: '127.0.0.1:37777' },
      } as unknown as Request,
      res,
    );

    expect(statusSpy).toHaveBeenCalledWith(403);
    expect(jsonSpy).toHaveBeenCalled();
    expect(jsonSpy).toHaveBeenCalledWith(expect.objectContaining({ error: 'Forbidden' }));
  });

  it('allows an origin-less read, which is how hooks, the CLI and the MCP tool call it', () => {
    const handler = captureGetHandler(workStateRoutes(), '/api/work-state');
    const { res, statusSpy } = createMockRes();

    handler({ query: { cwd: '/tmp/proj' }, headers: {} } as unknown as Request, res);

    expect(statusSpy).not.toHaveBeenCalledWith(403);
  });

  it('allows the viewer read from the same loopback host and port', () => {
    const handler = captureGetHandler(workStateRoutes(), '/api/work-state');
    const { res, statusSpy } = createMockRes();

    handler(
      {
        query: { cwd: '/tmp/proj' },
        headers: { origin: 'http://localhost:37777', host: '127.0.0.1:37777' },
      } as unknown as Request,
      res,
    );

    expect(statusSpy).not.toHaveBeenCalledWith(403);
  });
});

describe('GET /api/context/inject origin guard', () => {
  it('rejects a read from a different localhost origin before resolving the project', () => {
    const handler = captureGetHandler(searchRoutes(), '/api/context/inject');
    const { res, statusSpy, jsonSpy } = createMockRes();

    handler(
      {
        query: { cwd: '/tmp/proj' },
        headers: { origin: 'http://localhost:3000', host: '127.0.0.1:37777' },
        get: () => undefined,
      } as unknown as Request,
      res,
    );

    expect(statusSpy).toHaveBeenCalledWith(403);
    expect(jsonSpy).toHaveBeenCalledWith(expect.objectContaining({ error: 'Forbidden' }));
  });

  it('allows an origin-less read, which is how the session-start hook calls it', () => {
    const handler = captureGetHandler(searchRoutes(), '/api/context/inject');
    const { res, statusSpy } = createMockRes();

    handler(
      { query: { cwd: '/tmp/proj' }, headers: {}, get: () => undefined } as unknown as Request,
      res,
    );

    expect(statusSpy).not.toHaveBeenCalledWith(403);
  });
});