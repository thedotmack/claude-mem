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

/** Enqueue through the real capture path, backdated so the buffer itself ages. */
async function enqueueOld(
  manager: SessionManager,
  sessionDbId: number,
  toolUseId: string,
  atEpochMs: number,
): Promise<void> {
  await manager.queueObservation(
    sessionDbId,
    {
      tool_name: 'Read',
      tool_input: { content: 'synthetic private input' },
      tool_response: { content: 'synthetic private response' },
      prompt_number: 1,
      toolUseId,
    },
    atEpochMs,
  );
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
  const now = Date.now();
  const cold = now - 2 * 60 * 60 * 1000; // two hours old
  const fresh = now - 60 * 1000;

  it('reaps a cold paused session through the real enqueue path and holds the checkpoint', async () => {
    const manager = makeManager();
    await enqueueOld(manager, 10, 'tool-a', cold);
    await enqueueOld(manager, 10, 'tool-b', cold + 1000);
    const floor = manager.getMessageBuffer().getOldestPendingId(10)!;

    expect(manager.reapIdlePausedSessions()).toBe(1);
    expect(manager.getSession(10)).toBeUndefined();
    expect(manager.getMessageBuffer().getPendingCount(10)).toBe(0);
    expect(warnSpy.mock.calls.some(([, message]) => message === 'Discarding pending session messages')).toBe(true);
    // No work was ever claimed (the real path never set a session timestamp) —
    // the reaper still sees the buffer through its enqueue times.
    // The transcript checkpoint gate may not cross the discarded lines.
    expect(manager.getOldestPendingMessageId(10)).toBe(floor);
    // Idempotent on the next tick.
    expect(manager.reapIdlePausedSessions()).toBe(0);
  });

  it('releases a reaped session checkpoint only on operator deletion', async () => {
    const manager = makeManager();
    await enqueueOld(manager, 11, 'tool-a', cold);
    manager.reapIdlePausedSessions();
    expect(manager.getOldestPendingMessageId(11)).not.toBeNull();
    await manager.deleteSession(11);
    expect(manager.getOldestPendingMessageId(11)).toBeNull();
  });

  it('spares a fresh paused session: it still holds resume hope', async () => {
    const manager = makeManager();
    await enqueueOld(manager, 12, 'tool-a', fresh);

    expect(manager.reapIdlePausedSessions()).toBe(0);
    expect(manager.getSession(12)).toBeDefined();
    expect(manager.getMessageBuffer().getPendingCount(12)).toBe(1);
  });

  it('spares a session whose stale head ages while fresh work keeps arriving', async () => {
    const manager = makeManager();
    await enqueueOld(manager, 13, 'old-head', cold);
    await enqueueOld(manager, 13, 'fresh-tail', fresh);

    expect(manager.reapIdlePausedSessions()).toBe(0);
    expect(manager.getSession(13)).toBeDefined();
    expect(manager.getMessageBuffer().getPendingCount(13)).toBe(2);
  });

  const armers: Array<[string, (manager: SessionManager, s: ActiveSession) => void]> = [
    ['stallResumeTimer', (_m, s) => { s.stallResumeTimer = setTimeout(() => {}, 50); }],
    ['scheduledResumeTimer', (_m, s) => { s.scheduledResumeTimer = setTimeout(() => {}, 50); }],
    ['overflowPausedUntilMs', (_m, s) => { s.overflowPausedUntilMs = Date.now() + 60 * 1000; }],
    ['transportResumeTimer', (m, s) => {
      const resumes = (m as unknown as { transportResumes: Map<number, { pauses: number; timer?: unknown }> }).transportResumes;
      resumes.set(s.sessionDbId, { pauses: 1, timer: { unref() {} } });
    }],
  ];

  it.each(armers)('spares a paused session with a pending self-resume path (%s)', async (_name, arm) => {
    const manager = makeManager();
    await enqueueOld(manager, 14, 'tool-a', cold);
    arm(manager, manager.getSession(14)!);

    expect(manager.reapIdlePausedSessions()).toBe(0);
    expect(manager.getSession(14)).toBeDefined();
    expect(manager.getMessageBuffer().getPendingCount(14)).toBe(1);
  });

  it('does not reap under a run in flight, mid-delete, or a queued start; predicate decides queued', async () => {
    const manager = makeManager();
    await enqueueOld(manager, 15, 'tool-a', cold);
    await enqueueOld(manager, 16, 'tool-a', cold);
    await enqueueOld(manager, 17, 'tool-a', cold);
    await enqueueOld(manager, 18, 'tool-a', cold);
    manager.getSession(15)!.generatorPromise = Promise.resolve();
    (manager as unknown as { deletingSessions: Set<number> }).deletingSessions.add(16);
    manager.getSession(18)!.generatorPromise = Promise.resolve();

    // A start is queued for 18 (its start runs before its generatorPromise set).
    const queued = new Set([18]);
    expect(manager.reapIdlePausedSessions(idle, id => queued.has(id))).toBe(1);
    // 15 survived (run in flight), 16 survived (mid-delete), 17 reaped, 18 survived (queued).
    expect(manager.getSession(15)).toBeDefined();
    expect(manager.getSession(16)).toBeDefined();
    expect(manager.getSession(17)).toBeUndefined();
    expect(manager.getSession(18)).toBeDefined();
    await manager.getSession(15)!.generatorPromise;
    await manager.getSession(18)!.generatorPromise;
  });
});
