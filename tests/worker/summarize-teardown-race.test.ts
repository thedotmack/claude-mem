import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { logger } from '../../src/utils/logger.js';
import { SessionManager } from '../../src/services/worker/SessionManager.js';
import { handleGeneratorExit } from '../../src/services/worker/session/GeneratorExitHandler.js';
import { startGeneratorWithProvider } from '../../src/services/worker/session/GeneratorRunner.js';
import type { DatabaseManager } from '../../src/services/worker/DatabaseManager.js';
import type { ActiveSession } from '../../src/services/worker-types.js';

// #3419 / plan-21 step 4: a summarize that lands while an idle generator is
// stopping was disposed of with the buffer, because its own start request saw
// the old generator still in place and the exit then finalized the session.
// And an unclassified failure dropped a buffered summarize with no second try.

function makeDbManager(): DatabaseManager {
  return {
    getSessionById: () => ({
      content_session_id: 'content-3419',
      project: 'proj',
      platform_source: 'claude',
      user_prompt: 'do the thing',
      memory_session_id: null,
    }),
    getSessionStore: () => ({ getPromptNumberFromUserPrompts: () => 1 }),
    getChromaSync: () => undefined,
  } as unknown as DatabaseManager;
}

let spies: ReturnType<typeof spyOn>[] = [];

beforeEach(() => {
  spies = [
    spyOn(logger, 'info').mockImplementation(() => {}),
    spyOn(logger, 'debug').mockImplementation(() => {}),
    spyOn(logger, 'warn').mockImplementation(() => {}),
    spyOn(logger, 'error').mockImplementation(() => {}),
  ];
});

afterEach(() => {
  spies.forEach(spy => spy.mockRestore());
  mock.restore();
});

function exitDeps(sm: SessionManager) {
  const finalizeSession = mock(() => Promise.resolve());
  const resumeGenerator = mock((_source: string) => {});
  return {
    finalizeSession,
    resumeGenerator,
    deps: { sessionManager: sm, completionHandler: { finalizeSession } as any, resumeGenerator },
  };
}

describe('a summarize that lands during an idle teardown (#3419)', () => {
  it('hands the new work to a fresh generator instead of finalizing it away', async () => {
    const sm = new SessionManager(makeDbManager());
    const session = sm.initializeSession(1, 'do the thing', 1);
    // The idle timeout fired on an empty queue; the turn's summarize arrived
    // while the generator was still stopping.
    await sm.queueSummarize(1, 'all done');
    const { finalizeSession, resumeGenerator, deps } = exitDeps(sm);

    await handleGeneratorExit(session, 'idle', deps);

    expect(resumeGenerator).toHaveBeenCalledTimes(1);
    expect(resumeGenerator).toHaveBeenCalledWith('idle-teardown');
    expect(finalizeSession).not.toHaveBeenCalled();
    expect(sm.getSession(1)).toBe(session);
    expect(sm.getMessageBuffer().getPendingCount(1)).toBe(1);
  });

  it('still finalizes an idle exit with nothing buffered', async () => {
    const sm = new SessionManager(makeDbManager());
    const session = sm.initializeSession(2, 'do the thing', 1);
    const { finalizeSession, resumeGenerator, deps } = exitDeps(sm);

    await handleGeneratorExit(session, 'idle', deps);

    expect(resumeGenerator).not.toHaveBeenCalled();
    expect(finalizeSession).toHaveBeenCalledWith(2);
    expect(sm.getSession(2)).toBeUndefined();
  });

  it('starts the fresh generator through the runner on the next tick', async () => {
    const sm = new SessionManager(makeDbManager());
    const session = sm.initializeSession(3, 'do the thing', 1);
    const ensureGeneratorRunning = mock(async () => {});
    const finalizeSession = mock(() => Promise.resolve());

    await startGeneratorWithProvider(session, 'claude', 'observation', null, null, {
      sessionManager: sm,
      sdkAgent: {
        startSession: async (current: ActiveSession) => {
          // The idle timeout aborts the run; the summarize lands before the
          // exit handler runs.
          current.abortReason = 'idle';
          current.abortController.abort();
          await sm.queueSummarize(current.sessionDbId, 'all done');
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

    expect(finalizeSession).not.toHaveBeenCalled();
    expect(session.scheduledResumeTimer).toBeDefined();
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(ensureGeneratorRunning).toHaveBeenCalledWith(3, 'idle-teardown');
  });
});

describe('an unclassified failure with a summarize buffered (#3419)', () => {
  it('gets exactly one rescue pass, then the session finalizes', async () => {
    const sm = new SessionManager(makeDbManager());
    const session = sm.initializeSession(4, 'do the thing', 1);
    await sm.queueSummarize(4, 'all done');
    // The failed generator had claimed it.
    const iterator = sm.getMessageIterator(4);
    expect((await iterator.next()).done).toBe(false);
    await iterator.return?.();
    const resetSpy = spyOn(sm, 'resetProcessingToPending');
    const { finalizeSession, resumeGenerator, deps } = exitDeps(sm);

    await handleGeneratorExit(session, null, deps);

    expect(resetSpy).toHaveBeenCalledWith(4);
    expect(resumeGenerator).toHaveBeenCalledWith('summarize-rescue');
    expect(finalizeSession).not.toHaveBeenCalled();
    expect(sm.getMessageBuffer().getPendingCount(4)).toBe(1);

    // The rescue pass fails the same way: no second rescue.
    await handleGeneratorExit(session, null, deps);

    expect(resumeGenerator).toHaveBeenCalledTimes(1);
    expect(finalizeSession).toHaveBeenCalledWith(4);
    expect(sm.getSession(4)).toBeUndefined();
  });

  it('does not rescue an unclassified failure with no summarize buffered', async () => {
    const sm = new SessionManager(makeDbManager());
    const session = sm.initializeSession(5, 'do the thing', 1);
    await sm.queueObservation(5, { tool_name: 'Read', tool_input: {}, tool_response: {}, prompt_number: 1, toolUseId: 'tu-5' });
    const { finalizeSession, resumeGenerator, deps } = exitDeps(sm);

    await handleGeneratorExit(session, null, deps);

    expect(resumeGenerator).not.toHaveBeenCalled();
    expect(finalizeSession).toHaveBeenCalledWith(5);
  });
});
