import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { SessionMessageBuffer } from '../../src/services/worker/SessionMessageBuffer.js';
import { SessionManager } from '../../src/services/worker/SessionManager.js';
import { handleGeneratorExit } from '../../src/services/worker/session/GeneratorExitHandler.js';
import { LIVE_OBSERVER_MAX_AGE_MS, LIVE_OBSERVER_MAX_SESSION_MESSAGES, LIVE_OBSERVER_MAX_TOTAL_MESSAGES } from '../../src/shared/observer-work-policy.js';
import type { ActiveSession } from '../../src/services/worker-types.js';

afterEach(() => mock.restore());
const observation = (id: string) => ({ type: 'observation' as const, tool_name: 'Read', toolUseId: id });

describe('live observer has no replay debt', () => {
  it('drops quota/auth work across 25 sessions and has nothing to drain three days later', async () => {
    const manager = new SessionManager({ getSessionById: (id: number) => ({ content_session_id: `${id}`, project: 'test' }) } as any);
    const completion = { finalizeSession: mock(async () => {}) };
    for (let id = 1; id <= 25; id++) {
      const session = manager.initializeSession(id, 'prompt', 1);
      session.earliestPendingTimestamp = 123;
      for (let event = 0; event < 51; event++) manager.getMessageBuffer().enqueue(id, observation(`${event}`));
      await handleGeneratorExit(session, id % 2 ? 'quota:observer_text' : 'auth:observer_text', {
        sessionManager: manager, completionHandler: completion as any,
      });
      expect(session.earliestPendingTimestamp).toBeNull();
    }
    expect(manager.getTotalQueueDepth()).toBe(0);
    const now = Date.now();
    spyOn(Date, 'now').mockReturnValue(now + 3 * 24 * 60 * 60_000);
    expect(manager.getResumableSessionIds(true)).toEqual([]);
    expect(manager.getTotalQueueDepth()).toBe(0);
    // Fresh work is still admitted after the outage; old inputs are absent.
    manager.getMessageBuffer().enqueue(1, observation('fresh'));
    expect(manager.getMessageBuffer().peekTypes(1)).toHaveLength(1);
    expect(completion.finalizeSession).not.toHaveBeenCalled();
  });

  it('keeps dedup when quota or auth discards work, so a hook replay is not paid for again', async () => {
    const manager = new SessionManager({ getSessionById: (id: number) => ({ content_session_id: `${id}`, project: 'test' }) } as any);
    const completion = { finalizeSession: mock(async () => {}) };
    for (const reason of ['quota:observer_text', 'auth:observer_text']) {
      const id = reason.startsWith('quota') ? 41 : 42;
      const session = manager.initializeSession(id, 'prompt', 1);
      expect(manager.getMessageBuffer().enqueue(id, observation('replayed'))).toBeGreaterThan(0);
      await handleGeneratorExit(session, reason, { sessionManager: manager, completionHandler: completion as any });
      expect(manager.getMessageBuffer().getPendingCount(id)).toBe(0);
      // The same tool use arriving again (hook retry, transcript replay) is suppressed.
      expect(manager.getMessageBuffer().enqueue(id, observation('replayed'))).toBe(0);
      expect(manager.getMessageBuffer().enqueue(id, observation('fresh'))).toBeGreaterThan(0);
    }
  });

  it('forgets the claim timestamp when claims are released, since released work can expire unsent', async () => {
    const manager = new SessionManager({ getSessionById: (id: number) => ({ content_session_id: `${id}`, project: 'test' }) } as any);
    const session = manager.initializeSession(51, 'prompt', 1);
    manager.getMessageBuffer().enqueue(51, observation('claimed'), 1_000);
    expect(manager.claimNextObservation(51, () => true)).not.toBeNull();
    expect(session.earliestPendingTimestamp).toBe(1_000);
    await manager.resetProcessingToPending(51);
    expect(session.claimedMessageIds).toEqual([]);
    expect(session.earliestPendingTimestamp).toBeNull();
  });

  it('bounds both a single session and the aggregate pending buffer', () => {
    const buffer = new SessionMessageBuffer();
    for (let i = 0; i < LIVE_OBSERVER_MAX_SESSION_MESSAGES; i++) expect(buffer.enqueue(1, observation(`${i}`))).toBeGreaterThan(0);
    expect(buffer.enqueue(1, observation('over-session-limit'))).toBe(0);
    for (let i = buffer.getTotalDepth(); i < LIVE_OBSERVER_MAX_TOTAL_MESSAGES; i++) buffer.enqueue(i + 2, observation(`${i}`));
    expect(buffer.getTotalDepth()).toBe(LIVE_OBSERVER_MAX_TOTAL_MESSAGES);
    expect(buffer.enqueue(9999, observation('over-global-limit'))).toBe(0);
  });

  it('expires unsent work before dispatch but lets an in-flight request finish', () => {
    const now = Date.now();
    const clock = spyOn(Date, 'now').mockReturnValue(now);
    const buffer = new SessionMessageBuffer();
    const paidId = buffer.enqueue(1, observation('paid'));
    buffer.enqueue(1, observation('unsent'));
    expect(buffer.claimNextMatching(1, () => true)?._persistentId).toBe(paidId);
    clock.mockReturnValue(now + LIVE_OBSERVER_MAX_AGE_MS);
    expect(buffer.claimNextMatching(1, () => true)).toBeNull();
    expect(buffer.getPendingCount(1)).toBe(1);
    expect(buffer.confirm(paidId)).toBe(1);
    expect(buffer.getPendingCount(1)).toBe(0);
  });

  it('does not re-yield an expired failed batch when claims reset', () => {
    const now = Date.now();
    const clock = spyOn(Date, 'now').mockReturnValue(now);
    const buffer = new SessionMessageBuffer();
    buffer.enqueue(1, observation('failed'));
    buffer.claimNextMatching(1, () => true);
    clock.mockReturnValue(now + LIVE_OBSERVER_MAX_AGE_MS);
    buffer.resetClaimed(1);
    expect(buffer.claimNextMatching(1, () => true)).toBeNull();
    expect(buffer.getPendingCount(1)).toBe(0);
  });
});
