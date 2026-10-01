import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import type { Request, Response, NextFunction } from 'express';
import { SessionManager } from '../../../../src/services/worker/SessionManager.js';
import { SessionRoutes } from '../../../../src/services/worker/http/routes/SessionRoutes.js';
import * as providerDispatch from '../../../../src/services/worker/provider-dispatch.js';
import {
  clearQuotaCooldown, recordQuotaExhausted, resetQuotaCooldownsForTesting, QUOTA_EXHAUSTED_RECHECK_COOLDOWN_MS,
} from '../../../../src/shared/quota-cooldown.js';
import { guardSharedQuotaCooldownSingleton } from '../../../shared/quota-cooldown-singleton-guard.js';
import { logger } from '../../../../src/utils/logger.js';
import { ClassifiedProviderError } from '../../../../src/services/worker/provider-errors.js';
import type { ActiveSession } from '../../../../src/services/worker-types.js';

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

function postProcessing(
  routes: SessionRoutes,
  body: unknown,
  ip: string = '127.0.0.1',
): Promise<{ status: number; body: any }> {
  type Handler = (req: Request, res: Response, next: NextFunction) => void;
  let handlers: Handler[] = [];
  routes.setupRoutes({ post: (path: string, ...registered: Handler[]) => {
    if (path === '/api/processing') handlers = registered;
  } } as any);
  expect(handlers.length).toBe(3);
  return new Promise(resolve => {
    let status = 200;
    const res = {
      status: (code: number) => { status = code; return res; },
      json: (response: unknown) => resolve({ status, body: response }),
    };
    const req = { path: '/api/processing', method: 'POST', ip, body };
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
    spyOn(providerDispatch, 'getSelectedProvider').mockReturnValue('openrouter');
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

  it('schedules nothing during quota cooldown and one recovery probe after expiry', async () => {
    const { routes, manager, buffer, db, mutate, agent } = fixture();
    buffer.enqueue(3, { type: 'summarize' });
    mutate.mockClear();
    const now = Date.now();
    spyOn(Date, 'now').mockReturnValue(now);
    recordQuotaExhausted('openrouter', 'Quota exhausted');
    const ensure = spyOn(routes, 'ensureGeneratorRunning');
    expect(routes.resumePendingSessions('periodic-resume')).toBe(0);
    await flushStarts();
    expect(ensure).not.toHaveBeenCalled();
    expect(agent.startSession).not.toHaveBeenCalled();
    expect(manager.getResumableSessionIds()).toEqual([1, 3]);
    spyOn(Date, 'now').mockReturnValue(now + QUOTA_EXHAUSTED_RECHECK_COOLDOWN_MS + 1);
    expect(routes.resumePendingSessions('periodic-resume')).toBe(1);
    await flushStarts();
    expect(agent.startSession).toHaveBeenCalledTimes(1);
    expect(manager.getResumableSessionIds()).toEqual([3]);
    expect(manager.getTotalQueueDepth()).toBe(3);
    expect(mutate).not.toHaveBeenCalled();
    expect(db.getSessionById).not.toHaveBeenCalled();
    expect(db.getSessionStore).not.toHaveBeenCalled();
  });

  it('resumes the remaining sessions once the recovery probe clears the breaker', async () => {
    const { routes, manager, buffer, agent } = fixture();
    buffer.enqueue(3, { type: 'summarize' });
    const now = Date.now();
    spyOn(Date, 'now').mockReturnValue(now);
    recordQuotaExhausted('openrouter', 'Quota exhausted');
    spyOn(Date, 'now').mockReturnValue(now + QUOTA_EXHAUSTED_RECHECK_COOLDOWN_MS + 1);
    expect(routes.resumePendingSessions('periodic-resume')).toBe(1);
    await flushStarts();
    expect(manager.getResumableSessionIds()).toEqual([3]);

    clearQuotaCooldown('openrouter'); // the probe generated successfully
    expect(routes.resumePendingSessions('periodic-resume')).toBe(1);
    await flushStarts();
    expect(agent.startSession).toHaveBeenCalledTimes(2);
    expect(manager.getResumableSessionIds()).toEqual([]);
  });

  it('retries a provider-switch pause after the replacement provider cooldown expires', async () => {
    const { routes, manager, buffer, agent } = fixture();
    manager.getSession(1)!.pausedReason = 'provider_switch';
    const pending = buffer.getPendingCount(1);
    const now = Date.now();
    spyOn(Date, 'now').mockReturnValue(now);
    recordQuotaExhausted('openrouter', 'Quota exhausted');

    expect(routes.resumePendingSessions('periodic-resume')).toBe(0);
    await flushStarts();
    expect(agent.startSession).not.toHaveBeenCalled();
    expect(buffer.getPendingCount(1)).toBe(pending);

    spyOn(Date, 'now').mockReturnValue(now + QUOTA_EXHAUSTED_RECHECK_COOLDOWN_MS + 1);
    expect(routes.resumePendingSessions('periodic-resume')).toBe(1);
    await flushStarts();
    expect(agent.startSession).toHaveBeenCalledTimes(1);
    expect(buffer.getPendingCount(1)).toBe(pending);
  });

  it('retries a rate-limit pause once the breaker it armed lets a probe through', async () => {
    // A 429 without Retry-After (or past the resume cap) arms the breaker and
    // leaves the session paused for 'rate_limit', the same shape as a quota pause.
    const { routes, manager, agent } = fixture();
    manager.getSession(1)!.pausedReason = 'rate_limit';
    const now = Date.now();
    spyOn(Date, 'now').mockReturnValue(now);
    recordQuotaExhausted('openrouter', 'Rate limit exceeded: free-models-per-day', 'rate_limit');

    expect(routes.resumePendingSessions('periodic-resume')).toBe(0);
    await flushStarts();
    expect(agent.startSession).not.toHaveBeenCalled();

    spyOn(Date, 'now').mockReturnValue(now + QUOTA_EXHAUSTED_RECHECK_COOLDOWN_MS + 1);
    expect(routes.resumePendingSessions('periodic-resume')).toBe(1);
    await flushStarts();
    expect(agent.startSession).toHaveBeenCalledTimes(1);
  });

  it('leaves a rate-limit pause to its own Retry-After resume while that is pending', async () => {
    const { routes, manager, agent } = fixture();
    agent.startSession.mockImplementationOnce(async (session: ActiveSession) => {
      // What OpenAICompatibleProvider does with a rate limit that outlived its
      // retries: pause, then rethrow with the provider's Retry-After.
      session.abortReason = 'rate_limit:rate_limit';
      session.abortController.abort();
      throw new ClassifiedProviderError('Too many observer requests', { kind: 'rate_limit', cause: null, retryAfterMs: 60_000 });
    });
    const session = manager.getSession(1)!;

    await routes.ensureGeneratorRunning(1, 'observation');
    await session.generatorPromise;
    await flushStarts();

    try {
      expect(session.pausedReason).toBe('rate_limit');
      // The periodic sweep must not start it before Retry-After has passed...
      expect(manager.getResumableSessionIds()).toEqual([]);
      expect(routes.resumePendingSessions('periodic-resume')).toBe(0);
      expect(agent.startSession).toHaveBeenCalledTimes(1);
      // ...while an operator retry still may.
      expect(manager.getResumableSessionIds(true)).toEqual([1]);
    } finally {
      clearTimeout(session.scheduledResumeTimer);
    }
  });

  it('retries a stalled response after its timer fires during quota cooldown', async () => {
    const { routes, manager, agent } = fixture();
    const session = manager.getSession(1)!;
    session.pausedReason = 'response_stall';
    session.stallResumeTimer = setTimeout(() => {}, 60_000);
    session.stallResumeTimer.unref?.();
    expect(manager.getResumableSessionIds()).toEqual([]);
    clearTimeout(session.stallResumeTimer);
    session.stallResumeTimer = undefined;

    const now = Date.now();
    spyOn(Date, 'now').mockReturnValue(now);
    recordQuotaExhausted('openrouter', 'Quota exhausted');
    expect(routes.resumePendingSessions('periodic-resume')).toBe(0);
    await flushStarts();
    expect(agent.startSession).not.toHaveBeenCalled();
    expect(session.pausedReason).toBe('response_stall');

    spyOn(Date, 'now').mockReturnValue(now + QUOTA_EXHAUSTED_RECHECK_COOLDOWN_MS + 1);
    expect(routes.resumePendingSessions('periodic-resume')).toBe(1);
    await flushStarts();
    expect(agent.startSession).toHaveBeenCalledTimes(1);
  });

  it('lets an operator retry a stalled response before its automatic timer fires', async () => {
    const { routes, manager, agent } = fixture();
    const session = manager.getSession(1)!;
    session.pausedReason = 'response_stall';
    session.stallResumeTimer = setTimeout(() => {}, 60_000);
    session.stallResumeTimer.unref?.();

    expect(manager.getResumableSessionIds()).toEqual([]);
    expect(manager.getResumableSessionIds(true)).toEqual([1]);
    const response = await postProcessing(routes, { isProcessing: false });
    await flushStarts();
    expect(response.body.scheduledSessions).toBe(1);
    expect(agent.startSession).toHaveBeenCalledTimes(1);
    expect(session.stallResumeTimer).toBeUndefined();
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

  it('clears the pause reason when a generator starts, so later pauses are swept again', async () => {
    const { routes, manager } = fixture();
    const session = manager.getSession(1)!;
    session.pausedReason = 'auth';
    expect(manager.getResumableSessionIds()).toEqual([]);

    await postProcessing(routes, { isProcessing: false });
    await flushStarts();
    expect(session.generatorPromise).toBeDefined();
    expect(session.pausedReason).toBeNull();

    // The run ends without a new pause reason: the automatic sweep may retry it.
    session.generatorPromise = null;
    expect(manager.getResumableSessionIds()).toEqual([1]);
  });

  it('leaves an observer that spent its overflow recycles to the next event, even after its cooldown', () => {
    // A message that fits no generation aborts again on every retry: the
    // sweep retried it every cooldown (~11 min), forever.
    const { manager } = fixture();
    const session = manager.getSession(1)!;
    session.pausedReason = 'overflow';
    session.overflowPausedUntilMs = Date.now() - 1;
    expect(manager.getResumableSessionIds()).toEqual([]);
    expect(manager.getResumableSessionIds(true)).toEqual([1]);
  });

  it('still sweeps a recycled conversation whose own resume was turned away', () => {
    const { manager } = fixture();
    manager.getSession(1)!.pausedReason = 'overflow';
    expect(manager.getResumableSessionIds()).toEqual([1]);
  });

  it('leaves a setup failure to the next event or an operator retry', async () => {
    // Nothing on a timer repairs a missing Claude CLI or an unusable data
    // directory; the start gate rechecks it when the next event arrives.
    const { routes, manager, agent } = fixture();
    manager.getSession(1)!.pausedReason = 'setup_required';
    expect(manager.getResumableSessionIds()).toEqual([]);
    expect(routes.resumePendingSessions('periodic-resume')).toBe(0);
    await flushStarts();
    expect(agent.startSession).not.toHaveBeenCalled();
    expect(manager.getResumableSessionIds(true)).toEqual([1]);
  });

  it('refuses the operator retry from a non-local address', async () => {
    const { routes, agent } = fixture();
    const sweep = spyOn(routes, 'resumePendingSessions');
    expect((await postProcessing(routes, { isProcessing: false }, '203.0.113.7')).status).toBe(403);
    expect(sweep).not.toHaveBeenCalled();
    expect(agent.startSession).not.toHaveBeenCalled();
  });
});
