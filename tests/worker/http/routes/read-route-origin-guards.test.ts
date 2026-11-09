// A read route that resolves a project from a caller-supplied `cwd` runs `git`
// in that directory (src/utils/project-name.ts findGitRepoRoot). The write half
// of the same route already refuses another localhost origin (#5200); a read
// half that executes a process must refuse every other browser page too, so a
// page served anywhere cannot steer the worker into a directory it names. A
// `no-cors` fetch or an `<img src>` sends no Origin, so the guard also reads
// Referer and Sec-Fetch-Site.
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import type { Request, Response } from 'express';
import * as projectName from '../../../../src/utils/project-name.js';
import { WorkStateRoutes } from '../../../../src/services/worker/http/routes/WorkStateRoutes.js';
import { SearchRoutes } from '../../../../src/services/worker/http/routes/SearchRoutes.js';
import { isForeignBrowserRead } from '../../../../src/services/worker/http/routes/SettingsRoutes.js';

const WORKER_HOST = '127.0.0.1:37777';

/** Browser requests that must not reach project resolution. */
const FOREIGN_BROWSER_HEADERS: Array<[string, Record<string, string>]> = [
  ['another localhost Origin', { origin: 'http://localhost:3000', host: WORKER_HOST }],
  ['a same-site fetch with no Origin (no-cors from another localhost port)', { 'sec-fetch-site': 'same-site', host: WORKER_HOST }],
  ['a cross-site fetch with no Origin (an <img src> on a public page)', { 'sec-fetch-site': 'cross-site', host: WORKER_HOST }],
  ['a foreign Referer with no Origin', { referer: 'http://localhost:3000/', host: WORKER_HOST }],
];

/** Callers that must keep working: hooks/CLI/MCP send no browser headers; the viewer is same-origin. */
const ALLOWED_HEADERS: Array<[string, Record<string, string>]> = [
  ['no browser headers (hooks, the CLI and the MCP tool)', {}],
  ['the viewer on the same loopback host and port', { origin: 'http://localhost:37777', referer: 'http://localhost:37777/', 'sec-fetch-site': 'same-origin', host: WORKER_HOST }],
];

interface CapturedResponse {
  res: Response;
  done: Promise<void>;
  statusCode: () => number;
  body: () => unknown;
}

/** A response that records its status and body and resolves once the handler answers. */
function captureResponse(): CapturedResponse {
  let statusCode = 200;
  let body: unknown;
  let finish!: () => void;
  const done = new Promise<void>(resolve => { finish = resolve; });
  const res = {
    headersSent: false,
    setHeader: () => res,
    status(code: number) { statusCode = code; return res; },
    json(payload: unknown) { body = payload; finish(); return res; },
    send(payload: unknown) { body = payload; finish(); return res; },
    end() { finish(); return res; },
    on: () => res,
    off: () => res,
  } as unknown as Response;
  return { res, done, statusCode: () => statusCode, body: () => body };
}

/** Mounts a route class on a fake express app and returns the handler registered for a GET path. */
function captureGetHandler(routes: { setupRoutes: (app: any) => void }, routePath: string): (req: Request, res: Response) => void {
  let handler: ((req: Request, res: Response) => void) | undefined;
  routes.setupRoutes({
    use: mock(() => {}),
    get: mock((registered: string, routeHandler: (req: Request, res: Response) => void) => {
      if (registered === routePath) handler = routeHandler;
    }),
    post: mock(() => {}),
    delete: mock(() => {}),
  } as any);
  if (!handler) throw new Error(`route GET ${routePath} was not registered`);
  return handler;
}

function request(query: Record<string, string>, headers: Record<string, string>): Request {
  return { query, headers, path: '/', get: (name: string) => headers[name.toLowerCase()] } as unknown as Request;
}

let checkoutDir: string;
let projectContextSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  checkoutDir = mkdtempSync(path.join(tmpdir(), 'read-route-guard-'));
  projectContextSpy = spyOn(projectName, 'getProjectContext');
});

afterEach(() => {
  projectContextSpy.mockRestore();
  rmSync(checkoutDir, { recursive: true, force: true });
});

describe('isForeignBrowserRead', () => {
  for (const [label, headers] of FOREIGN_BROWSER_HEADERS) {
    it(`refuses ${label}`, () => {
      expect(isForeignBrowserRead({ headers } as any)).toBe(true);
    });
  }
  for (const [label, headers] of ALLOWED_HEADERS) {
    it(`allows ${label}`, () => {
      expect(isForeignBrowserRead({ headers } as any)).toBe(false);
    });
  }
  it('allows a same-site fetch that carries the worker page as its Referer', () => {
    expect(isForeignBrowserRead({ headers: { 'sec-fetch-site': 'same-site', referer: 'http://localhost:37777/', host: WORKER_HOST } } as any)).toBe(false);
  });
  it('refuses a Referer that is not a URL', () => {
    expect(isForeignBrowserRead({ headers: { referer: 'not a url', host: WORKER_HOST } } as any)).toBe(true);
  });
});

describe('GET /api/work-state origin guard', () => {
  function workStateRoutes(getWorkStateEntries: () => unknown[]) {
    return new WorkStateRoutes({
      getSessionStore: () => ({ getWorkStateEntries, appendWorkStateEntry: () => 1 }),
      getCloudSync: () => null,
    } as any);
  }

  for (const [label, headers] of FOREIGN_BROWSER_HEADERS) {
    it(`answers 403 to ${label} without resolving the project`, async () => {
      const getWorkStateEntries = mock(() => []);
      const handler = captureGetHandler(workStateRoutes(getWorkStateEntries), '/api/work-state');
      const captured = captureResponse();

      handler(request({ cwd: checkoutDir }, headers), captured.res);
      await captured.done;

      expect(captured.statusCode()).toBe(403);
      expect(captured.body()).toEqual(expect.objectContaining({ error: 'Forbidden' }));
      expect(projectContextSpy).not.toHaveBeenCalled();
      expect(getWorkStateEntries).not.toHaveBeenCalled();
    });
  }

  for (const [label, headers] of ALLOWED_HEADERS) {
    it(`answers ${label} with the open work state`, async () => {
      const getWorkStateEntries = mock(() => []);
      const handler = captureGetHandler(workStateRoutes(getWorkStateEntries), '/api/work-state');
      const captured = captureResponse();

      handler(request({ cwd: checkoutDir }, headers), captured.res);
      await captured.done;

      expect(captured.statusCode()).toBe(200);
      expect(projectContextSpy).toHaveBeenCalledWith(checkoutDir);
      expect(getWorkStateEntries).toHaveBeenCalledTimes(1);
      expect(String(captured.body())).toStartWith('Nothing open for ');
    });
  }
});

describe('GET /api/context/inject origin guard', () => {
  // The context read worker resolves the checkout's projects when present; a
  // stub that knows no project makes the route answer its own 400.
  function searchRoutes(projectsForCwd: (cwd: string) => Promise<string[]>) {
    return new SearchRoutes({} as any, null, null, { projectsForCwd } as any);
  }

  for (const [label, headers] of FOREIGN_BROWSER_HEADERS) {
    it(`answers 403 to ${label} without resolving the project`, async () => {
      const projectsForCwd = mock(async () => []);
      const handler = captureGetHandler(searchRoutes(projectsForCwd), '/api/context/inject');
      const captured = captureResponse();

      handler(request({ cwd: checkoutDir }, headers), captured.res);
      await captured.done;

      expect(captured.statusCode()).toBe(403);
      expect(captured.body()).toEqual(expect.objectContaining({ error: 'Forbidden' }));
      expect(projectsForCwd).not.toHaveBeenCalled();
      expect(projectContextSpy).not.toHaveBeenCalled();
    });
  }

  for (const [label, headers] of ALLOWED_HEADERS) {
    it(`resolves the project for ${label}`, async () => {
      const projectsForCwd = mock(async () => []);
      const handler = captureGetHandler(searchRoutes(projectsForCwd), '/api/context/inject');
      const captured = captureResponse();

      handler(request({ cwd: checkoutDir }, headers), captured.res);
      await captured.done;

      expect(projectsForCwd).toHaveBeenCalledWith(checkoutDir);
      // No project for this checkout: the route's own answer, not a crash.
      expect(captured.statusCode()).toBe(400);
      expect(captured.body()).toEqual({ error: 'Project(s) parameter is required' });
    });
  }
});
