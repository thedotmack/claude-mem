/**
 * SessionStart freshness with cloud sync (Greptile PRRT_kwDOPng1J86osrIw):
 * when the sync client's Realtime channel is not live, the live context route
 * pulls once (bounded) before rendering, so another device's change that has
 * not arrived yet is in the block. With Realtime live, ops already arrive as
 * they happen and the route does not pull.
 */
import { describe, expect, it, mock } from 'bun:test';
import type { Request, Response } from 'express';
import { SearchRoutes } from '../../../../src/services/worker/http/routes/SearchRoutes.js';

function contextInjectHandler(routes: SearchRoutes): (req: Request, res: Response) => void {
  let captured: ((req: Request, res: Response) => void) | undefined;
  routes.setupRoutes({
    get: (path: string, handler: (req: Request, res: Response) => void) => {
      if (path === '/api/context/inject') captured = handler;
    },
    post: () => {}, delete: () => {}, use: () => {},
  } as any);
  if (!captured) throw new Error('no /api/context/inject handler');
  return captured;
}

async function runSessionStart(socketLive: boolean) {
  const events: string[] = [];
  const syncClient = {
    isSocketLive: () => socketLive,
    pullOnce: mock(async (options?: { timeoutMs?: number }) => {
      events.push(`pull:${options?.timeoutMs}`);
    }),
  };
  const sessionStore = {
    db: { prepare: () => ({ get: () => ({ count: 0 }) }) },
    getWorkStateEntries: () => {
      events.push('render');
      return [];
    },
  };
  const routes = new SearchRoutes({ getSessionStore: () => sessionStore } as any, null, syncClient);
  const sent = new Promise<string>(resolve => {
    const res = {
      setHeader: () => {}, status: () => res, json: () => {}, headersSent: false,
      send: (body: string) => resolve(body),
    };
    contextInjectHandler(routes)({ query: { projects: 'sync-pull-proj' }, get: () => undefined } as any, res as any);
  });
  await sent;
  return { events, syncClient };
}

describe('SessionStart sync pull', () => {
  it('pulls once, bounded to 1.5s, before rendering while Realtime is not live', async () => {
    const { events, syncClient } = await runSessionStart(false);
    expect(syncClient.pullOnce).toHaveBeenCalledTimes(1);
    expect(events).toEqual(['pull:1500', 'render']);
  });

  it('does not pull while Realtime is live', async () => {
    const { events, syncClient } = await runSessionStart(true);
    expect(syncClient.pullOnce).not.toHaveBeenCalled();
    expect(events).toEqual(['render']);
  });
});
