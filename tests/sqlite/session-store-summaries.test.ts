import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';

function summary(overrides: Partial<Parameters<SessionStore['storeSummary']>[2]> = {}) {
  return {
    request: 'User requested feature X',
    investigated: 'Explored the codebase',
    learned: 'Discovered pattern Y',
    completed: 'Implemented feature X',
    next_steps: 'Add tests and documentation',
    notes: 'Consider edge case Z' as string | null,
    ...overrides,
  };
}

describe('SessionStore summaries', () => {
  let store: SessionStore;

  beforeEach(() => {
    store = new SessionStore(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  // session_summaries references sdk_sessions(memory_session_id) via enforced FK.
  function session(memorySessionId: string): string {
    const id = store.createSDKSession(`content-${memorySessionId}`, 'project', 'prompt');
    store.updateMemorySessionId(id, memorySessionId);
    return memorySessionId;
  }

  describe('storeSummary', () => {
    it('returns a positive id and createdAtEpoch', () => {
      const result = store.storeSummary(session('mem-sum-1'), 'project', summary());
      expect(result.id).toBeGreaterThan(0);
      expect(result.createdAtEpoch).toBeGreaterThan(0);
    });

    it('round-trips all fields and prompt_number via getSummaryForSession', () => {
      const mem = session('mem-sum-2');
      store.storeSummary(mem, 'project', summary({
        request: 'Refactor the database layer',
        investigated: 'Analyzed current schema',
        learned: 'Found N+1 query issues',
        completed: 'Optimized queries',
        next_steps: 'Monitor performance',
        notes: 'May need caching',
      }), 1, 500);

      const stored = store.getSummaryForSession(mem);
      expect(stored?.request).toBe('Refactor the database layer');
      expect(stored?.investigated).toBe('Analyzed current schema');
      expect(stored?.learned).toBe('Found N+1 query issues');
      expect(stored?.completed).toBe('Optimized queries');
      expect(stored?.next_steps).toBe('Monitor performance');
      expect(stored?.notes).toBe('May need caching');
      expect(stored?.prompt_number).toBe(1);
    });

    it('honors overrideTimestampEpoch', () => {
      const past = 1650000000000;
      const mem = session('mem-sum-3');
      const result = store.storeSummary(mem, 'project', summary(), 1, 0, past);
      expect(result.createdAtEpoch).toBe(past);
      expect(store.getSummaryForSession(mem)?.created_at_epoch).toBe(past);
    });

    it('defaults timestamp to now when omitted', () => {
      const before = Date.now();
      const result = store.storeSummary(session('mem-sum-now'), 'project', summary());
      const after = Date.now();
      expect(result.createdAtEpoch).toBeGreaterThanOrEqual(before);
      expect(result.createdAtEpoch).toBeLessThanOrEqual(after);
    });

    it('preserves null notes', () => {
      const mem = session('mem-sum-null');
      store.storeSummary(mem, 'project', summary({ notes: null }));
      expect(store.getSummaryForSession(mem)?.notes).toBeNull();
    });
  });

  describe('getSummaryForSession', () => {
    it('retrieves by memory_session_id', () => {
      const mem = session('mem-unique');
      store.storeSummary(mem, 'project', summary({ request: 'Unique request' }));
      expect(store.getSummaryForSession(mem)?.request).toBe('Unique request');
    });

    it('returns null when none exists', () => {
      expect(store.getSummaryForSession('nonexistent-session')).toBeNull();
    });

    it('returns the most recent summary when multiple exist', () => {
      const mem = session('mem-multi');
      store.storeSummary(mem, 'project', summary({ request: 'First request' }), 1, 0, 1000000000000);
      store.storeSummary(mem, 'project', summary({ request: 'Second request' }), 2, 0, 2000000000000);

      const retrieved = store.getSummaryForSession(mem);
      expect(retrieved?.request).toBe('Second request');
      expect(retrieved?.prompt_number).toBe(2);
    });
  });
});
