import { describe, it, expect, beforeEach } from 'bun:test';
import { SessionManager } from '../../src/services/worker/SessionManager.js';
import type { DatabaseManager } from '../../src/services/worker/DatabaseManager.js';
import type { PendingMessage, PendingMessageWithId } from '../../src/services/worker-types.js';

function obs(toolName: string, toolUseId?: string): PendingMessage {
  return {
    type: 'observation',
    tool_name: toolName,
    tool_input: {},
    tool_response: {},
    toolUseId,
  };
}

async function drainAll(sessionManager: SessionManager, sessionDbId: number): Promise<PendingMessageWithId[]> {
  const buffer = sessionManager.getMessageBuffer();
  const controller = new AbortController();
  const collected: PendingMessageWithId[] = [];
  for await (const msg of buffer.drain({
    sessionDbId,
    signal: controller.signal,
    idleTimeoutMs: 15,
    onIdleTimeout: () => controller.abort(),
  })) {
    collected.push(msg);
  }
  return collected;
}

describe('SessionManager.resetClaimed and generator recovery', () => {
  let sessionManager: SessionManager;
  let mockDbManager: DatabaseManager;
  const sessionDbId = 999;

  beforeEach(() => {
    mockDbManager = {
      getSessionById: () => ({
        content_session_id: 'content-123',
        project: 'test-project',
        platform_source: 'claude',
        user_prompt: 'test prompt',
        memory_session_id: 'memory-123',
      }),
      getSessionStore: () => ({
        getPromptNumberFromUserPrompts: () => 1,
      }),
    } as unknown as DatabaseManager;

    sessionManager = new SessionManager(mockDbManager);
  });

  it('exposes resetClaimed as a valid function alias of resetProcessingToPending', () => {
    expect(typeof sessionManager.resetClaimed).toBe('function');
    expect(typeof sessionManager.resetProcessingToPending).toBe('function');
  });

  it('resets claimed messages so they can be re-drained via resetClaimed', async () => {
    const buffer = sessionManager.getMessageBuffer();
    buffer.enqueue(sessionDbId, obs('Read', 'tool-1'));
    buffer.enqueue(sessionDbId, obs('Write', 'tool-2'));

    // First drain claims both messages
    const first = await drainAll(sessionManager, sessionDbId);
    expect(first.length).toBe(2);

    // Draining again immediately yields nothing because messages are claimed
    const emptyDrain = await drainAll(sessionManager, sessionDbId);
    expect(emptyDrain.length).toBe(0);

    // Call resetClaimed to release claimed messages back to pending
    const resetCount = await sessionManager.resetClaimed(sessionDbId);
    expect(resetCount).toBe(2);

    // Now draining yields both messages again
    const reDrained = await drainAll(sessionManager, sessionDbId);
    expect(reDrained.length).toBe(2);
    expect(reDrained.map(m => m.tool_name)).toEqual(['Read', 'Write']);
  });

  it('behaves identically between resetProcessingToPending and resetClaimed', async () => {
    const buffer = sessionManager.getMessageBuffer();
    buffer.enqueue(sessionDbId, obs('Bash', 'tool-3'));

    const first = await drainAll(sessionManager, sessionDbId);
    expect(first.length).toBe(1);

    const resetCount = await sessionManager.resetProcessingToPending(sessionDbId);
    expect(resetCount).toBe(1);

    const reDrained = await drainAll(sessionManager, sessionDbId);
    expect(reDrained.length).toBe(1);
    expect(reDrained[0].tool_name).toBe('Bash');
  });

  it('clears session claimedMessageIds when resetClaimed is called on an active session', async () => {
    const session = sessionManager.initializeSession(sessionDbId, 'test prompt', 1, 'test-project');
    session.claimedMessageIds = [101, 102];

    await sessionManager.resetClaimed(sessionDbId);

    expect(session.claimedMessageIds).toEqual([]);
  });

  it('evicts idle sessions exceeding maxIdleAgeMs when no pending work exists', () => {
    const session1 = sessionManager.initializeSession(101);
    const session2 = sessionManager.initializeSession(102);

    expect(sessionManager.getActiveSessionCount()).toBe(2);

    const now = Date.now();
    session1.lastGeneratorActivity = now - 40 * 60 * 1000;
    session2.lastGeneratorActivity = now - 5 * 60 * 1000;

    const evicted = sessionManager.evictIdleSessions(30 * 60 * 1000, now);

    expect(evicted).toBe(1);
    expect(sessionManager.getActiveSessionCount()).toBe(1);
    expect(sessionManager.getSession(101)).toBeUndefined();
    expect(sessionManager.getSession(102)).toBeDefined();
  });

  it('does not evict sessions with pending buffer work or running generator', () => {
    const session3 = sessionManager.initializeSession(103);
    const session4 = sessionManager.initializeSession(104);
    const now = Date.now();

    session3.lastGeneratorActivity = now - 60 * 60 * 1000;
    session4.lastGeneratorActivity = now - 60 * 60 * 1000;

    sessionManager.getMessageBuffer().enqueue(103, obs('ReadFile'));
    session4.generatorPromise = Promise.resolve();

    const evicted = sessionManager.evictIdleSessions(30 * 60 * 1000, now);
    expect(evicted).toBe(0);
    expect(sessionManager.getSession(103)).toBeDefined();
    expect(sessionManager.getSession(104)).toBeDefined();
  });
});

