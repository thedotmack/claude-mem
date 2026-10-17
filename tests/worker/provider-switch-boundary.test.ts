import { describe, it, expect, mock, beforeEach, afterEach, spyOn } from 'bun:test';
import { logger } from '../../src/utils/logger.js';
import { SessionManager } from '../../src/services/worker/SessionManager.js';
import { startGeneratorWithProvider } from '../../src/services/worker/session/GeneratorRunner.js';
import type { ActiveSession } from '../../src/services/worker-types.js';
import type { DatabaseManager } from '../../src/services/worker/DatabaseManager.js';

/**
 * #4846: a running generator in an active session never idles out, so a
 * provider change (the primary back after a fallback) must take effect at the
 * next message boundary, not when the generator finishes.
 */

function makeDbManager(): DatabaseManager {
  return {
    getSessionById: () => ({
      content_session_id: 'content-switch',
      project: 'proj',
      platform_source: 'claude',
      user_prompt: 'do the thing',
      memory_session_id: null,
    }),
    getSessionStore: () => ({
      getPromptNumberFromUserPrompts: () => 1,
    }),
    getChromaSync: () => undefined,
  } as unknown as DatabaseManager;
}

function queue(sm: SessionManager, sessionDbId: number, toolUseId: string): void {
  sm.queueObservation(sessionDbId, {
    tool_name: 'Read',
    tool_input: {},
    tool_response: {},
    prompt_number: 1,
    toolUseId,
  });
}

let spies: ReturnType<typeof spyOn>[] = [];

describe('provider switch at the next message boundary (#4846)', () => {
  beforeEach(() => {
    spies = [
      spyOn(logger, 'info').mockImplementation(() => {}),
      spyOn(logger, 'debug').mockImplementation(() => {}),
      spyOn(logger, 'warn').mockImplementation(() => {}),
      spyOn(logger, 'error').mockImplementation(() => {}),
    ];
  });

  afterEach(() => {
    spies.forEach(s => s.mockRestore());
  });

  it('ends the message iterator before it hands out the next message, keeping the queue', async () => {
    const sm = new SessionManager(makeDbManager());
    const session = sm.initializeSession(41, 'do the thing', 1);
    queue(sm, 41, 'tu-41-a');
    queue(sm, 41, 'tu-41-b');

    const iterator = sm.getMessageIterator(41);
    const first = await iterator.next();
    expect(first.done).toBe(false);
    await sm.confirmClaimedMessages(41);

    session.providerSwitchPending = true;
    const second = await iterator.next();

    expect(second.done).toBe(true);
    expect(session.abortReason).toBe('provider_switch:boundary');
    expect(session.abortController.signal.aborted).toBe(true);
    expect(session.claimedMessageIds).toEqual([]);
    expect(sm.getMessageBuffer().getPendingCount(41)).toBe(1);

    // The next generator gets the message the switch held back.
    session.abortController = new AbortController();
    session.abortReason = null;
    session.providerSwitchPending = false;
    const next = sm.getMessageIterator(41);
    const reclaimed = await next.next();
    expect(reclaimed.done).toBe(false);
    expect(reclaimed.value?.toolUseId).toBe('tu-41-b');
    session.abortController.abort();
    await next.return?.(undefined);
  });

  it('keeps the session and resumes on the selected provider after the boundary switch', async () => {
    const sm = new SessionManager(makeDbManager());
    const session = sm.initializeSession(42, 'do the thing', 1);
    queue(sm, 42, 'tu-42-a');
    queue(sm, 42, 'tu-42-b');
    session.providerSwitchPending = true;
    const ensureGeneratorRunning = mock(async () => {});
    const finalizeSession = mock(() => Promise.resolve());
    let pendingAtStart: boolean | undefined;

    await startGeneratorWithProvider(session, 'claude', 'observation', null, null, {
      sessionManager: sm,
      // A fallback generator: answers one message, then SessionRoutes sees the
      // primary selected again and asks for the switch.
      sdkAgent: {
        startSession: async (current: ActiveSession) => {
          pendingAtStart = current.providerSwitchPending;
          for await (const _message of sm.getMessageIterator(current.sessionDbId)) {
            await sm.confirmClaimedMessages(current.sessionDbId);
            current.providerSwitchPending = true;
          }
        },
      } as any,
      geminiAgent: {} as any,
      openRouterAgent: {} as any,
      workerService: {} as any,
      completionHandler: { finalizeSession } as any,
      ensureGeneratorRunning,
      maybeSelfHealStaleClaudeSpawn: () => false,
    });
    await session.generatorPromise;

    expect(pendingAtStart).toBe(false);
    expect(finalizeSession).not.toHaveBeenCalled();
    expect(sm.getSession(42)).toBe(session);
    expect(session.pausedReason).toBe('provider_switch');
    expect(sm.getMessageBuffer().getPendingCount(42)).toBe(1);
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(ensureGeneratorRunning).toHaveBeenCalledWith(42, 'provider-switch');
  });
});
