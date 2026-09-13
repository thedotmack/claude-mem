import { describe, expect, it, mock } from 'bun:test';
import type { Request, Response } from 'express';
import { SessionRoutes } from '../../../src/services/worker/http/routes/SessionRoutes.js';

type Handler = (req: Request, res: Response) => void;

function captureSessionEndHandler(routes: SessionRoutes): Handler {
  let handler: Handler | undefined;
  const app = {
    post: mock((path: string, ...handlers: Handler[]) => {
      if (path === '/api/sessions/session-end') {
        handler = handlers.at(-1);
      }
    }),
  };

  routes.setupRoutes(app as any);
  if (!handler) throw new Error('SessionEnd route was not registered');
  return handler;
}

function makeRequest(body: Record<string, unknown>): Request {
  return {
    path: '/api/sessions/session-end',
    body,
    query: {},
    get: () => undefined,
  } as unknown as Request;
}

function makeResponse(): { res: Response; json: ReturnType<typeof mock> } {
  const json = mock(() => {});
  return {
    res: { headersSent: false, json } as unknown as Response,
    json,
  };
}

async function flushAsyncHandler(): Promise<void> {
  await new Promise<void>(resolve => setImmediate(resolve));
}

function makeRoutes(findSessionDbIdByContentSessionId: ReturnType<typeof mock>, requestSessionWrapup: ReturnType<typeof mock>): SessionRoutes {
  return new SessionRoutes(
    { requestSessionWrapup } as any,
    { getSessionStore: () => ({ findSessionDbIdByContentSessionId }) } as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
  );
}

describe('SessionEnd route', () => {
  it('returns unknown_session and does not request a wrap-up when no matching platform-scoped session exists', async () => {
    const findSessionDbIdByContentSessionId = mock(() => null);
    const requestSessionWrapup = mock(async () => {});
    const handler = captureSessionEndHandler(makeRoutes(findSessionDbIdByContentSessionId, requestSessionWrapup));
    const { res, json } = makeResponse();

    handler(makeRequest({ contentSessionId: 'missing-session', platformSource: 'Cursor' }), res);
    await flushAsyncHandler();

    expect(findSessionDbIdByContentSessionId).toHaveBeenCalledWith('missing-session', 'cursor');
    expect(requestSessionWrapup).not.toHaveBeenCalled();
    expect(json).toHaveBeenCalledWith({ status: 'unknown_session' });
  });

  it('accepts a known session and requests its wrap-up exactly once', async () => {
    const findSessionDbIdByContentSessionId = mock(() => 42);
    const requestSessionWrapup = mock(async () => {});
    const handler = captureSessionEndHandler(makeRoutes(findSessionDbIdByContentSessionId, requestSessionWrapup));
    const { res, json } = makeResponse();

    handler(makeRequest({ contentSessionId: 'known-session', platformSource: 'Claude Code', reason: 'clear' }), res);
    await flushAsyncHandler();

    expect(findSessionDbIdByContentSessionId).toHaveBeenCalledWith('known-session', 'claude');
    expect(requestSessionWrapup).toHaveBeenCalledTimes(1);
    expect(requestSessionWrapup).toHaveBeenCalledWith(42);
    expect(json).toHaveBeenCalledWith({ status: 'accepted' });
  });
});
