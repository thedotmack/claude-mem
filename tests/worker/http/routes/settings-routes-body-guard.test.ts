
import { describe, it, expect, mock, beforeEach, afterEach, spyOn } from 'bun:test';
import type { Request, Response } from 'express';
import { logger } from '../../../../src/utils/logger.js';
import { SettingsRoutes } from '../../../../src/services/worker/http/routes/SettingsRoutes.js';

let loggerSpies: ReturnType<typeof spyOn>[] = [];

function captureUpdateSettingsChain(routes: SettingsRoutes): Array<(req: Request, res: Response, next: () => void) => void> {
  let chain: Array<(req: Request, res: Response, next: () => void) => void> | undefined;
  const mockApp: any = {
    get: mock(() => {}),
    post: mock((path: string, ...handlers: Array<(req: Request, res: Response, next: () => void) => void>) => {
      if (path === '/api/settings') chain = handlers;
    }),
    delete: mock(() => {}),
    use: mock(() => {}),
  };
  routes.setupRoutes(mockApp);
  expect(chain).toBeDefined();
  return chain!;
}

function runChain(
  chain: Array<(req: Request, res: Response, next: () => void) => void>,
  req: Partial<Request>,
  res: Partial<Response>,
): void {
  let index = 0;
  const next = (): void => {
    const handler = chain[index++];
    if (handler) handler(req as Request, res as Response, next);
  };
  next();
}

describe('SettingsRoutes — POST /api/settings body guard', () => {
  beforeEach(() => {
    loggerSpies = [
      spyOn(logger, 'info').mockImplementation(() => {}),
      spyOn(logger, 'debug').mockImplementation(() => {}),
      spyOn(logger, 'warn').mockImplementation(() => {}),
      spyOn(logger, 'error').mockImplementation(() => {}),
      spyOn(logger, 'failure').mockImplementation(() => {}),
    ];
  });

  afterEach(() => {
    loggerSpies.forEach(spy => spy.mockRestore());
    mock.restore();
  });

  it('returns 400, not a TypeError, when the request has no body', () => {
    const chain = captureUpdateSettingsChain(new SettingsRoutes({} as any));

    const jsonSpy = mock(() => {});
    const statusSpy = mock(() => ({ json: jsonSpy }));
    const req: Partial<Request> = { path: '/api/settings', body: undefined };
    const res = { json: jsonSpy, status: statusSpy } as unknown as Partial<Response>;

    expect(() => runChain(chain, req, res)).not.toThrow();
    expect(statusSpy).toHaveBeenCalledWith(400);
  });
});
