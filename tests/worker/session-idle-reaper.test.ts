import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';

import type { DatabaseManager } from '../../src/services/worker/DatabaseManager.js';
import type { ActiveSession } from '../../src/services/worker-types.js';
import { SESSION_REAP_IDLE_MS, SessionManager } from '../../src/services/worker/SessionManager.js';
import { getSupervisor } from '../../src/supervisor/index.js';
import * as processRegistry from '../../src/supervisor/process-registry.js';
import { logger } from '../../src/utils/logger.js';

let spies: ReturnType<typeof spyOn>[];
let warnSpy: ReturnType<typeof spyOn>;

function makeManager(): SessionManager {
  const dbManager = {
    getSessionById: (sessionDbId: number) => ({
      content_session_id: `content-${sessionDbId}`,
      memory_session_id: null,
      project: 'test-project',
      platform_source: 'claude',
      user_prompt: 'test prompt',
    }),
    getSessionStore: () => ({
      getPromptNumberFromUserPrompts: () => 1,
      getLatestPromptTextFromUserPrompts: () => null,
    }),
  } as unknown as DatabaseManager;
  return new SessionManager(dbManager);
}

async function enqueue(manager: SessionManager, sessionDbId: number, toolUseId: string): Promise<void> {
  await manager.queueObservation(sessionDbId, {
    tool_name: 'Read',
    tool_input: { content: 'synthetic private input' },
    tool_response: { content: 'synthetic private response' },
    prompt_number: 1,
    toolUseId,
  });
}

/** Pretend a session's buffer has been sitting paused with no events for a long time. */
function setAge(session: ActiveSession, ageMs: number): void {
  session.earliestPendingTimestamp = Date.now() - ageMs;
}

beforeEach(() => {
  warnSpy = spyOn(logger, 'warn').mockImplementation(() => {});
  spies = [
    warnSpy,
    spyOn(getSupervisor().getRegistry(), 'reapSession').mockResolvedValue(0),
    spyOn(processRegistry, 'getSdkProcessForSession').mockReturnValue(undefined),
    spyOn(processRegistry, 'ensureSdkProcessExit').mockResolvedValue(undefined),
    spyOn(logger, 'debug').mockImplementation(() => {}),
    spyOn(logger, 'info').mockImplementation(() => {}),
  ];
});

afterEach(() => {
  for (const spy of spies) spy.mockRestore();
});

describe('SessionManager idle paused-session reaper', () => {
  const idle = SESSION_REAP_IDLE_MS;
  const fresh = 60 * 1000;

  it('reaps a cold paused session: buffer discarded to transcript replay, session removed', async () => {
    const manager = makeManager();
    await enqueue(manager, 10, 'tool-a');
    await enqueue(manager, 10, 'tool-b');
    setAge(manager.getSession(10)!, idle);

    expect(manager.reapIdlePausedSessions()).toBe(1);
    expect(manager.getSession(10)).toBeUndefined();
    expect(manager.getMessageBuffer().getPendingCount(10)).toBe(0);
    expect(warnSpy.mock.calls.some(([, message]) => message === 'Discarding pending session messages')).toBe(true);
    // Idempotent: a reaped session is gone, the next tick has nothing.
    expect(manager.reapIdlePausedSessions()).toBe(0);
  });

  it('spares a fresh paused session: it still holds resume hope', async () => {
    const manager = makeManager();
    await enqueue(manager, 11, 'tool-a');
    setAge(manager.getSession(11)!, fresh);

    expect(manager.reapIdlePausedSessions()).toBe(0);
    expect(manager.getSession(11)).toBeDefined();
    expect(manager.getMessageBuffer().getPendingCount(11)).toBe(1);
  });

  it('does not reap a paused session whose buffer has no oldest timestamp', async () => {
    const manager = makeManager();
    manager.initializeSession(12);
    manager.getSession(12)!.generatorPromise = null;
    expect(manager.reapIdlePausedSessions()).toBe(0);
    expect(manager.getSession(12)).toBeDefined();
  });

  it.each([
    ['stallResumeTimer', (s: ActiveSession) => { s.stallResumeTimer = setTimeout(() => {}, 50); }],
    ['scheduledResumeTimer', (s: ActiveSession) => { s.scheduledResumeTimer = setTimeout(() => {}, 50); }],
    ['overflowPausedUntilMs', (s: ActiveSession) => { s.overflowPausedUntilMs = Date.now() + 60 * 1000; }],
  ])('spares a paused session with a pending self-resume path (%s)', async (_name, arm) => {
    const manager = makeManager();
    await enqueue(manager, 13, 'tool-a');
    const session = manager.getSession(13)!;
    setAge(session, idle);
    arm(session);

    expect(manager.reapIdlePausedSessions()).toBe(0);
    expect(manager.getSession(13)).toBeDefined();
    expect(manager.getMessageBuffer().getPendingCount(13)).toBe(1);
  });

  it('does not reap under a run in flight and never touches a session mid-delete', async () => {
    const manager = makeManager();
    await enqueue(manager, 14, 'tool-a');
    await enqueue(manager, 15, 'tool-a');
    setAge(manager.getSession(14)!, idle);
    setAge(manager.getSession(15)!, idle);
    manager.getSession(14)!.generatorPromise = Promise.resolve();

    expect(manager.reapIdlePausedSessions()).toBe(1);
    expect(manager.getSession(14)).toBeDefined(); // still reaping-safe
    expect(manager.getSession(15)).toBeUndefined();
    await manager.getSession(14)!.generatorPromise;
  });
});
