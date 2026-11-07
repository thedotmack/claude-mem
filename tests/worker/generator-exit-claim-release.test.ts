import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';

import type { DatabaseManager } from '../../src/services/worker/DatabaseManager.js';
import type { ActiveSession } from '../../src/services/worker-types.js';
import { SessionManager } from '../../src/services/worker/SessionManager.js';
import { handleGeneratorExit } from '../../src/services/worker/session/GeneratorExitHandler.js';
import { getSupervisor } from '../../src/supervisor/index.js';
import * as processRegistry from '../../src/supervisor/process-registry.js';
import { logger } from '../../src/utils/logger.js';

let spies: Array<ReturnType<typeof spyOn>>;
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

async function enqueueAndClaim(manager: SessionManager, sessionDbId: number): Promise<void> {
  await manager.queueObservation(sessionDbId, {
    tool_name: 'Read',
    tool_input: { content: 'synthetic private input' },
    tool_response: { content: 'synthetic private response' },
    prompt_number: 1,
    toolUseId: 'tool-a',
  });
  await manager.queueObservation(sessionDbId, {
    tool_name: 'Read',
    tool_input: { content: 'synthetic private input' },
    tool_response: { content: 'synthetic private response' },
    prompt_number: 1,
    toolUseId: 'tool-b',
  });
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
    spyOn(logger, 'error').mockImplementation(() => {}),
  ];
});

afterEach(() => {
  for (const spy of spies) spy.mockRestore();
});

describe('GeneratorExitHandler releases orphaned claims on a preserved pause', () => {
  it('a transport pause releases the dead run’s claims and keeps the live buffer', async () => {
    const manager = makeManager();
    await enqueueAndClaim(manager, 41);
    const iterator = manager.getMessageIterator(41);
    await iterator.next(); // the dead run claimed both-yielded work below
    const session = manager.getSession(41)!;
    session.abortReason = 'transport:transient';

    await handleGeneratorExit(session, 'transport:transient', {
      sessionManager: manager,
      // Fake the completion path so the pause path (not finalize) is exercised.
      finalizeSession: async () => {},
    } as never);

    expect(session.pausedReason).toBe('transport');
    // The dead run's claims are released — a later generator starts from pending.
    expect(session.claimedMessageIds).toEqual([]);
    const lists = (manager.getMessageBuffer() as unknown as {
      buffers: Map<number, Array<{ claimed: boolean }>>;
    }).buffers.get(41)!;
    expect(lists.some(m => m.claimed)).toBe(false);
    // No work was discarded: the live buffer keeps everything it had.
    expect(manager.getMessageBuffer().getPendingCount(41)).toBe(2);

    await iterator.return(undefined);
  });

  it('a preserved pause also releases claims without a transport backoff', async () => {
    const manager = makeManager();
    await enqueueAndClaim(manager, 42);
    const iterator = manager.getMessageIterator(42);
    await iterator.next();
    const session = manager.getSession(42)!;
    session.abortReason = 'output_retry:prose';

    await handleGeneratorExit(session, 'output_retry:prose', {
      sessionManager: manager,
      finalizeSession: async () => {},
    } as never);

    expect((manager.getMessageBuffer() as unknown as {
      buffers: Map<number, Array<{ claimed: boolean }>>;
    }).buffers.get(42)!.some(m => m.claimed)).toBe(false);
    expect(manager.getMessageBuffer().getPendingCount(42)).toBe(2);

    await iterator.return(undefined);
  });

  it('released work expires by its original buffered age, and cannot be re-enqueued for a replay', async () => {
    // The release must leave dedup intact: an expired, released fragment must
    // not re-enter the buffer under its old toolUseId and cause later
    // inference spend.
    const manager = makeManager();
    await manager.queueObservation(60, {
      tool_name: 'Read',
      tool_input: { content: 'synthetic private input' },
      tool_response: { content: 'synthetic private response' },
      prompt_number: 1,
      toolUseId: 'tool-expire',
    });
    const list = (manager.getMessageBuffer() as unknown as {
      buffers: Map<number, Array<{ claimed: boolean; bufferedAt: number }>>;
    }).buffers.get(60)!;
    // While claimed, the item is exempt from expiry (a live send owns it).
    list[0].claimed = true;
    list[0].bufferedAt = Date.now() - 6 * 60 * 1000; // past the 5-minute window
    expect(manager.getMessageBuffer().getPendingCount(60)).toBe(1);

    // Release through the real pause path (the contract's claim-release site).
    const session = manager.getSession(60)!;
    await handleGeneratorExit(session, 'transport:transient', {
      sessionManager: manager,
      finalizeSession: async () => {},
    } as never);
    // The release does not reset the age: the stored fragment expires now.
    expect(manager.getMessageBuffer().getPendingCount(60)).toBe(0);
    // The dedup set survives the release, so the same input cannot enqueue
    // again for a replay: the buffer rejects it outright.
    const reenqueued = manager.getMessageBuffer().enqueue(60, {
      type: 'observation' as const,
      tool_name: 'Read',
      tool_input: { content: 'synthetic private input' },
      tool_response: { content: 'synthetic private response' },
      prompt_number: 1,
      toolUseId: 'tool-expire',
    });
    expect(reenqueued).toBe(0);
    expect(manager.getMessageBuffer().getPendingCount(60)).toBe(0);
  });
});
