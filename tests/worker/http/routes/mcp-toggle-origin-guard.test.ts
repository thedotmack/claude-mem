import { describe, expect, it, mock } from 'bun:test';
import type { Request, Response } from 'express';
import { SettingsRoutes } from '../../../../src/services/worker/http/routes/SettingsRoutes.js';

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

function captureMcpToggleHandler(routes: SettingsRoutes): (req: Request, res: Response) => void {
  let handler!: (req: Request, res: Response) => void;
  const mockApp: any = {
    get: mock(() => {}),
    post: mock((path: string, ...handlers: Array<(req: Request, res: Response) => void>) => {
      if (path === '/api/mcp/toggle') {
        handler = handlers[handlers.length - 1];
      }
    }),
  };
  routes.setupRoutes(mockApp);
  return (req: Request, res: Response): void => handler(req, res);
}

describe('POST /api/mcp/toggle origin guard', () => {
  it('rejects a browser toggle from a different localhost origin', () => {
    const routes = new SettingsRoutes({} as any);
    const toggleSpy = mock(() => {});
    (routes as any).toggleMcp = toggleSpy;
    const handler = captureMcpToggleHandler(routes);

    const { res, statusSpy, jsonSpy } = createMockRes();
    handler({
      body: { enabled: false },
      headers: { origin: 'http://localhost:3000', host: '127.0.0.1:37777' },
    } as unknown as Request, res as Response);

    expect(statusSpy).toHaveBeenCalledWith(403);
    expect(jsonSpy).toHaveBeenCalledWith(expect.objectContaining({ success: false }));
    expect(toggleSpy).not.toHaveBeenCalled();
  });

  it('allows an Origin-less toggle and a same-port browser toggle', () => {
    const routes = new SettingsRoutes({} as any);
    const toggleSpy = mock(() => {});
    (routes as any).toggleMcp = toggleSpy;
    (routes as any).isMcpEnabled = () => true;
    const handler = captureMcpToggleHandler(routes);

    const originless = createMockRes();
    handler({ body: { enabled: false }, headers: {} } as unknown as Request, originless.res as Response);
    expect(toggleSpy).toHaveBeenCalledWith(false);
    expect(originless.statusSpy).not.toHaveBeenCalled();

    const samePort = createMockRes();
    handler({
      body: { enabled: true },
      headers: { origin: 'http://localhost:37777', host: '127.0.0.1:37777' },
    } as unknown as Request, samePort.res as Response);
    expect(toggleSpy).toHaveBeenCalledWith(true);
    expect(samePort.statusSpy).not.toHaveBeenCalled();
  });
});
