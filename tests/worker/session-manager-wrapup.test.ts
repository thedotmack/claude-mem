import { afterAll, afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';

import * as realTelegramWrapupNotifier from '../../src/services/integrations/TelegramWrapupNotifier.js';
import * as realProcessRegistry from '../../src/supervisor/process-registry.js';
import * as realSupervisor from '../../src/supervisor/index.js';

const realTelegramWrapupNotifierSnapshot = { ...realTelegramWrapupNotifier };
const realProcessRegistrySnapshot = { ...realProcessRegistry };
const realSupervisorSnapshot = { ...realSupervisor };
const deliverSessionWrapup = mock(async () => 'sent');
const reapSession = mock(async () => 0);

mock.module('../../src/services/integrations/TelegramWrapupNotifier.js', () => ({
  ...realTelegramWrapupNotifierSnapshot,
  deliverSessionWrapup,
}));

mock.module('../../src/supervisor/process-registry.js', () => ({
  ...realProcessRegistrySnapshot,
  getSdkProcessForSession: () => undefined,
  ensureSdkProcessExit: async () => {},
}));

mock.module('../../src/supervisor/index.js', () => ({
  ...realSupervisorSnapshot,
  getSupervisor: () => ({
    getRegistry: () => ({ reapSession }),
  }),
}));

import { logger } from '../../src/utils/logger.js';
import { SessionManager, SESSION_END_WRAPUP_GRACE_MS } from '../../src/services/worker/SessionManager.js';
import type { DatabaseManager } from '../../src/services/worker/DatabaseManager.js';

function makeDbManager(): DatabaseManager {
  const store = {
    getPromptNumberFromUserPrompts: () => 1,
    getLatestPromptTextFromUserPrompts: () => null,
  };
  return {
    getSessionById: () => ({
      content_session_id: 'session-content-id',
      memory_session_id: null,
      project: 'test-project',
      platform_source: 'claude',
      user_prompt: 'test prompt',
      observed_model: null,
      observed_billing: null,
    }),
    getSessionStore: () => store,
  } as unknown as DatabaseManager;
}

let scheduledCallback: (() => void) | undefined;
let timerHandle: { unref: ReturnType<typeof mock> };
let setTimeoutSpy: ReturnType<typeof spyOn>;
let clearTimeoutSpy: ReturnType<typeof spyOn>;
let warnSpy: ReturnType<typeof spyOn>;
let loggerSpies: ReturnType<typeof spyOn>[] = [];

function flushBackgroundWork(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
}

beforeEach(() => {
  deliverSessionWrapup.mockClear();
  reapSession.mockClear();
  reapSession.mockImplementation(async () => 0);
  scheduledCallback = undefined;
  timerHandle = { unref: mock(() => {}) };
  setTimeoutSpy = spyOn(globalThis, 'setTimeout').mockImplementation((callback: TimerHandler) => {
    scheduledCallback = callback as () => void;
    return timerHandle as unknown as ReturnType<typeof setTimeout>;
  });
  clearTimeoutSpy = spyOn(globalThis, 'clearTimeout').mockImplementation(() => {});
  warnSpy = spyOn(logger, 'warn').mockImplementation(() => {});
  loggerSpies = [
    spyOn(logger, 'debug').mockImplementation(() => {}),
    spyOn(logger, 'info').mockImplementation(() => {}),
    warnSpy,
    spyOn(logger, 'error').mockImplementation(() => {}),
  ];
});

afterEach(() => {
  setTimeoutSpy.mockRestore();
  clearTimeoutSpy.mockRestore();
  loggerSpies.forEach(spy => spy.mockRestore());
});

afterAll(() => {
  mock.module('../../src/services/integrations/TelegramWrapupNotifier.js', () => realTelegramWrapupNotifierSnapshot);
  mock.module('../../src/supervisor/process-registry.js', () => realProcessRegistrySnapshot);
  mock.module('../../src/supervisor/index.js', () => realSupervisorSnapshot);
});

describe('SessionManager SessionEnd wrap-up requests', () => {
  it('marks a live session and arms the fixed grace timer', async () => {
    const manager = new SessionManager(makeDbManager());
    const session = manager.initializeSession(1);

    await manager.requestSessionWrapup(1);

    expect(session.telegramWrapupRequestedAt).toEqual(expect.any(Number));
    expect(session.telegramWrapupTimer).toBe(timerHandle);
    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), SESSION_END_WRAPUP_GRACE_MS);
    expect(timerHandle.unref).toHaveBeenCalledTimes(1);
    expect(deliverSessionWrapup).not.toHaveBeenCalled();
  });

  it('delivers once when the live-session grace timer fires', async () => {
    const manager = new SessionManager(makeDbManager());
    manager.initializeSession(2);

    await manager.requestSessionWrapup(2);
    if (!scheduledCallback) throw new Error('wrap-up timer was not armed');
    scheduledCallback();
    await Promise.resolve();

    expect(deliverSessionWrapup).toHaveBeenCalledTimes(1);
    expect(deliverSessionWrapup).toHaveBeenCalledWith({
      sessionStore: expect.any(Object),
      sessionDbId: 2,
    });
  });

  it('delivers immediately when the session is not live in this worker', async () => {
    const manager = new SessionManager(makeDbManager());

    await manager.requestSessionWrapup(3);

    expect(deliverSessionWrapup).toHaveBeenCalledTimes(1);
    expect(deliverSessionWrapup).toHaveBeenCalledWith({
      sessionStore: expect.any(Object),
      sessionDbId: 3,
    });
    expect(setTimeoutSpy).not.toHaveBeenCalled();
  });

  it('starts non-live delivery immediately without awaiting its I/O', async () => {
    const manager = new SessionManager(makeDbManager());
    let resolveDelivery!: (result: 'sent') => void;
    deliverSessionWrapup.mockImplementationOnce(() => new Promise<'sent'>(resolve => {
      resolveDelivery = resolve;
    }));

    const request = manager.requestSessionWrapup(4);

    expect(deliverSessionWrapup).toHaveBeenCalledTimes(1);
    const completedPromptly = await Promise.race([
      request.then(() => true),
      new Promise<boolean>(resolve => setImmediate(() => resolve(false))),
    ]);
    expect(completedPromptly).toBeTrue();

    resolveDelivery('sent');
    await flushBackgroundWork();
  });

  it('handles a rejected non-live delivery without rejecting the request', async () => {
    const manager = new SessionManager(makeDbManager());
    const error = new Error('non-live delivery failed');
    deliverSessionWrapup.mockImplementationOnce(async () => {
      throw error;
    });

    await expect(manager.requestSessionWrapup(5)).resolves.toBeUndefined();
    await flushBackgroundWork();

    expect(warnSpy).toHaveBeenCalledWith(
      'TELEGRAM',
      'Failed to deliver Telegram session wrap-up from SessionManager',
      { sessionId: 5 },
      error,
    );
  });

  it('handles a rejected grace-timer delivery without an unhandled rejection', async () => {
    const manager = new SessionManager(makeDbManager());
    manager.initializeSession(6);
    await manager.requestSessionWrapup(6);
    const error = new Error('timer delivery failed');
    deliverSessionWrapup.mockImplementationOnce(async () => {
      throw error;
    });

    if (!scheduledCallback) throw new Error('wrap-up timer was not armed');
    expect(() => scheduledCallback!()).not.toThrow();
    await flushBackgroundWork();

    expect(warnSpy).toHaveBeenCalledWith(
      'TELEGRAM',
      'Failed to deliver Telegram session wrap-up from SessionManager',
      { sessionId: 6 },
      error,
    );
  });

  it('clears the grace timer and handles a rejected delivery during immediate teardown at timestamp zero', async () => {
    const manager = new SessionManager(makeDbManager());
    const session = manager.initializeSession(7);
    await manager.requestSessionWrapup(7);
    session.telegramWrapupRequestedAt = 0;
    const error = new Error('immediate teardown delivery failed');
    deliverSessionWrapup.mockImplementationOnce(async () => {
      throw error;
    });

    expect(() => manager.removeSessionImmediate(7)).not.toThrow();
    await flushBackgroundWork();

    expect(clearTimeoutSpy).toHaveBeenCalledWith(timerHandle);
    expect(session.telegramWrapupTimer).toBeNull();
    expect(deliverSessionWrapup).toHaveBeenCalledTimes(1);
    expect(deliverSessionWrapup).toHaveBeenCalledWith({
      sessionStore: expect.any(Object),
      sessionDbId: 7,
    });
    expect(manager.getSession(7)).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(
      'TELEGRAM',
      'Failed to deliver Telegram session wrap-up from SessionManager',
      { sessionId: 7 },
      error,
    );
  });

  it('clears the grace timer and handles a rejected delivery during awaited teardown at timestamp zero', async () => {
    const manager = new SessionManager(makeDbManager());
    const session = manager.initializeSession(8);
    await manager.requestSessionWrapup(8);
    session.telegramWrapupRequestedAt = 0;
    const error = new Error('awaited teardown delivery failed');
    deliverSessionWrapup.mockImplementationOnce(async () => {
      throw error;
    });

    await expect(manager.deleteSession(8)).resolves.toBeUndefined();
    await flushBackgroundWork();

    expect(clearTimeoutSpy).toHaveBeenCalledWith(timerHandle);
    expect(session.telegramWrapupTimer).toBeNull();
    expect(deliverSessionWrapup).toHaveBeenCalledTimes(1);
    expect(deliverSessionWrapup).toHaveBeenCalledWith({
      sessionStore: expect.any(Object),
      sessionDbId: 8,
    });
    expect(manager.getSession(8)).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(
      'TELEGRAM',
      'Failed to deliver Telegram session wrap-up from SessionManager',
      { sessionId: 8 },
      error,
    );
  });

  it('takes and clears a SessionEnd request that arrives while awaited teardown is in progress', async () => {
    const manager = new SessionManager(makeDbManager());
    const session = manager.initializeSession(9);
    let resolveReap!: (result: number) => void;
    reapSession.mockImplementationOnce(() => new Promise<number>(resolve => {
      resolveReap = resolve;
    }));

    const deletion = manager.deleteSession(9);
    expect(reapSession).toHaveBeenCalledWith(9);

    await manager.requestSessionWrapup(9);
    expect(session.telegramWrapupTimer).toBe(timerHandle);
    resolveReap(0);
    await deletion;

    expect(clearTimeoutSpy).toHaveBeenCalledWith(timerHandle);
    expect(session.telegramWrapupTimer).toBeNull();
    expect(deliverSessionWrapup).toHaveBeenCalledTimes(1);
    expect(deliverSessionWrapup).toHaveBeenCalledWith({
      sessionStore: expect.any(Object),
      sessionDbId: 9,
    });
    expect(manager.getSession(9)).toBeUndefined();
  });
});
