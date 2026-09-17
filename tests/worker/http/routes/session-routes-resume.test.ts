import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import type { Request, Response, NextFunction } from 'express';
import { SessionManager } from '../../../../src/services/worker/SessionManager.js';
import { SessionRoutes } from '../../../../src/services/worker/http/routes/SessionRoutes.js';
import * as providerDispatch from '../../../../src/services/worker/provider-dispatch.js';
import {
  recordQuotaExhausted, resetQuotaCooldownsForTesting, QUOTA_EXHAUSTED_RECHECK_COOLDOWN_MS,
} from '../../../../src/shared/quota-cooldown.js';
import { guardSharedQuotaCooldownSingleton } from '../../../shared/quota-cooldown-singleton-guard.js';
import { logger } from '../../../../src/utils/logger.js';

guardSharedQuotaCooldownSingleton('session-routes-resume.test.ts');

function fixture() {
  const db = {
    getSessionById: mock((id: number) => ({
      content_session_id: `content-${id}`, project: 'test', user_prompt: 'original prompt',
    })),
    getSessionStore: mock(() => { throw new Error('Resume must not access the database'); }),
  };
  const manager = new SessionManager(db as any);
  for (const id of [1, 2, 3]) manager.initializeSession(id, 'original prompt', 1);
  const buffer = manager.getMessageBuffer();
  const messageId = buffer.enqueue(1, { type: 'observation', tool_name: 'Read', tool_input: { path: 'file' } });
  buffer.enqueue(2, { type: 'summarize', last_assistant_message: 'original summary' });
  manager.getSession(2)!.generatorPromise = new Promise(() => {});
  db.getSessionById.mockClear();
  const mutate = mock(() => {});
  manager.setOnPendingMutate(mutate);
  const agent = { startSession: mock(() => new Promise<void>(() => {})) };
  const routes = new SessionRoutes(manager, db as any, agent as any, agent as any, agent as any,
    {} as any, {} as any, {} as any);
  // Tier selection is unrelated to retries; keep this suite independent of user settings.
  spyOn(routes as any, 'applyTierRouting').mockResolvedValue(undefined);
  return { manager, buffer, messageId, routes, db, mutate, agent };
}

function postProcessing(routes: SessionRoutes, body: unknown): Promise<{ status: number; body: any }> {
  type Handler = (req: Request, res: Response, next: NextFunction) => void;
  let handlers: Handler[] = [];
  routes.setupRoutes({ post: (path: string, ...registered: Handler[]) => {
    if (path === '/api/processing') handlers = registered;
  } } as any);
  expect(handlers.length).toBe(2);
  return new Promise(resolve => {
    let status = 200;
    const res = {
      status: (code: number) => { status = code; return res; },
      json: (response: unknown) => resolve({ status, body: response }),
    };
    const req = { path: '/api/processing', body };
    let index = 0;
    const next = () => handlers[index++]?.(req as Request, res as Response, next);
    next();
  });
}

async function flushStarts() {
  await new Promise<void>(resolve => setImmediate(resolve));
}

describe('paused in-memory session recovery', () => {
  beforeEach(() => {
    for (const level of ['info', 'debug', 'warn', 'error'] as const) {
      spyOn(logger, level).mockImplementation(() => {});
    }
    spyOn(providerDispatch, 'selectProviderForGenerator')
      .mockReturnValue({ provider: 'openrouter', gatewayProbeClaimId: null });
  });

  afterEach(() => {
    resetQuotaCooldownsForTesting();
    mock.restore();
  });

  it('only returns buffered active sessions without a generator, including unconfirmed claimed work', async () => {
    const { manager, buffer, messageId, db, mutate } = fixture();
    // An orphaned buffer is not permission to load a DB session.
    buffer.enqueue(99, { type: 'summarize' });
    const iterator = manager.getMessageIterator(1);
    await iterator.next();
    await iterator.return(undefined);
    mutate.mockClear();
    const before = buffer.getMessagesByIds(1, [messageId]);
    expect(manager.getResumableSessionIds()).toEqual([1]);
    const snapshot = manager.getResumableSessionIds();
    snapshot.push(123);
    expect(manager.getResumableSessionIds()).toEqual([1]);
    expect(manager.getClaimedMessages(1)).toEqual(before);
    expect(manager.getTotalQueueDepth()).toBe(3);
    expect(mutate).not.toHaveBeenCalled();
    expect(db.getSessionById).not.toHaveBeenCalled();
    expect(db.getSessionStore).not.toHaveBeenCalled();
  });

  it('false resumes existing work without enqueueing, clearing buffers, or accessing the DB', async () => {
    const { routes, manager, buffer, messageId, db, mutate, agent } = fixture();
    const before = buffer.getMessagesByIds(1, [messageId]);
    const sweep = spyOn(routes, 'resumePendingSessions');
    const response = await postProcessing(routes, { isProcessing: false });
    await flushStarts();
    expect(response).toEqual({ status: 200, body: {
      status: 'ok', isProcessing: true, queueDepth: 2, activeSessions: 3, scheduledSessions: 1,
    } });
    expect(sweep).toHaveBeenCalledWith('processing-api', true);
    expect(agent.startSession).toHaveBeenCalledTimes(1);
    expect(manager.getTotalQueueDepth()).toBe(2);
    expect(buffer.getMessagesByIds(1, [messageId])).toEqual(before);
    expect(manager.getSession(1)!.userPrompt).toBe('original prompt');
    expect(mutate).not.toHaveBeenCalled();
    expect(db.getSessionById).not.toHaveBeenCalled();
    expect(db.getSessionStore).not.toHaveBeenCalled();
  });

  it('true is a compatible no-op and does not claim that the queue is empty', async () => {
    const { routes, manager, db, mutate, agent } = fixture();
    const sweep = spyOn(routes, 'resumePendingSessions');
    expect(await postProcessing(routes, { isProcessing: true })).toEqual({ status: 200, body: {
      status: 'ok', isProcessing: true, queueDepth: 2, activeSessions: 3, scheduledSessions: 0,
    } });
    await flushStarts();
    expect(sweep).not.toHaveBeenCalled();
    expect(agent.startSession).not.toHaveBeenCalled();
    expect(manager.getResumableSessionIds()).toEqual([1]);
    expect(mutate).not.toHaveBeenCalled();
    expect(db.getSessionById).not.toHaveBeenCalled();
    expect(db.getSessionStore).not.toHaveBeenCalled();
  });

  it.each([{}, { isProcessing: 'false' }, { isProcessing: 0 }, { isProcessing: null }])(
    'rejects invalid processing bodies: %j', async body => {
      const { routes, agent, mutate } = fixture();
      const sweep = spyOn(routes, 'resumePendingSessions');
      expect((await postProcessing(routes, body)).status).toBe(400);
      expect(sweep).not.toHaveBeenCalled();
      expect(agent.startSession).not.toHaveBeenCalled();
      expect(mutate).not.toHaveBeenCalled();
    },
  );

  it('concurrent periodic, endpoint, and ingest calls start only one generator', async () => {
    const { routes, manager, agent } = fixture();
    expect(routes.resumePendingSessions('periodic-resume')).toBe(1);
    await Promise.all([
      postProcessing(routes, { isProcessing: false }),
      routes.ensureGeneratorRunning(1, 'observation'),
    ]);
    await flushStarts();
    expect(agent.startSession).toHaveBeenCalledTimes(1);
    expect(manager.getResumableSessionIds()).toEqual([]);
    expect(routes.resumePendingSessions('periodic-resume')).toBe(0);
  });

  it('preserves work during quota cooldown and admits just one probe after expiry', async () => {
    const { routes, manager, buffer, db, mutate, agent } = fixture();
    buffer.enqueue(3, { type: 'summarize' });
    mutate.mockClear();
    const now = Date.now();
    spyOn(Date, 'now').mockReturnValue(now);
    recordQuotaExhausted('openrouter', 'Quota exhausted');
    expect(routes.resumePendingSessions('periodic-resume')).toBe(2);
    await flushStarts();
    expect(agent.startSession).not.toHaveBeenCalled();
    expect(manager.getResumableSessionIds()).toEqual([1, 3]);
    spyOn(Date, 'now').mockReturnValue(now + QUOTA_EXHAUSTED_RECHECK_COOLDOWN_MS + 1);
    expect(routes.resumePendingSessions('periodic-resume')).toBe(2);
    await flushStarts();
    expect(agent.startSession).toHaveBeenCalledTimes(1);
    expect(manager.getResumableSessionIds()).toHaveLength(1);
    expect(manager.getTotalQueueDepth()).toBe(3);
    expect(mutate).not.toHaveBeenCalled();
    expect(db.getSessionById).not.toHaveBeenCalled();
    expect(db.getSessionStore).not.toHaveBeenCalled();
  });

  it('handles an individual rejected start without preventing other attempts', async () => {
    const { routes, buffer } = fixture();
    buffer.enqueue(3, { type: 'summarize' });
    const ensure = spyOn(routes, 'ensureGeneratorRunning').mockImplementation(async id => {
      if (id === 1) throw new Error('start failed');
    });
    expect(routes.resumePendingSessions('periodic-resume')).toBe(2);
    await flushStarts();
    expect(ensure).toHaveBeenCalledWith(3, 'periodic-resume');
    expect(logger.warn).toHaveBeenCalledWith('SESSION', 'Failed to resume buffered session',
      { sessionId: 1, source: 'periodic-resume' }, expect.any(Error));
  });

  it('leaves auth and transport pauses for an explicit operator retry', () => {
    const { routes, manager, buffer } = fixture();
    buffer.enqueue(3, { type: 'summarize' });
    manager.getSession(1)!.pausedReason = 'auth';
    manager.getSession(3)!.pausedReason = 'transport';
    expect(manager.getResumableSessionIds()).toEqual([]);
    expect(manager.getResumableSessionIds(true)).toEqual([1, 3]);
    expect(routes.resumePendingSessions('periodic-resume')).toBe(0);
    expect(routes.resumePendingSessions('processing-api', true)).toBe(2);
  });
});
