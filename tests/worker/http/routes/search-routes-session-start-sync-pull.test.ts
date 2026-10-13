/**
 * SessionStart is local-first: the live context route renders from the local db
 * at once and never waits on the sync hub. While Realtime is not live it only
 * nudges a pull (fire-and-forget) so the sync loop catches up for next time.
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
    // A hub that never answers: SessionStart must not wait on it.
    pullOnce: mock((_options?: { timeoutMs?: number }) => {
      events.push('pull');
      return new Promise<void>(() => {});
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
  it('renders without waiting on the pull while Realtime is not live, and nudges one pull', async () => {
    const { events, syncClient } = await runSessionStart(false);
    expect(syncClient.pullOnce).toHaveBeenCalledTimes(1);
    expect(events).toEqual(['pull', 'render']);
  });

  it('does not pull while Realtime is live', async () => {
    const { events, syncClient } = await runSessionStart(true);
    expect(syncClient.pullOnce).not.toHaveBeenCalled();
    expect(events).toEqual(['render']);
  });
});
