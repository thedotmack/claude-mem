import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';

function obs(overrides: Partial<Parameters<SessionStore['storeObservations']>[2][number]> = {}) {
  return {
    type: 'discovery',
    title: 'Test Observation',
    subtitle: 'Test Subtitle',
    facts: ['fact1'],
    narrative: 'Test narrative content',
    concepts: ['concept1'],
    files_read: [],
    files_modified: [],
    ...overrides,
  };
}

function summary(overrides: Partial<NonNullable<Parameters<SessionStore['storeObservations']>[3]>> = {}) {
  return {
    request: 'req',
    investigated: 'inv',
    learned: 'learn',
    completed: 'done',
    next_steps: 'next',
    notes: 'notes' as string | null,
    ...overrides,
  };
}

describe('SessionStore.storeObservations', () => {
  let store: SessionStore;

  beforeEach(() => {
    store = new SessionStore(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  // observations/session_summaries reference sdk_sessions(memory_session_id) via enforced FK.
  function session(memorySessionId: string): string {
    const id = store.createSDKSession(`content-${memorySessionId}`, 'project', 'prompt');
    store.updateMemorySessionId(id, memorySessionId);
    return memorySessionId;
  }

  it('stores N observations atomically with null summaryId when no summary', () => {
    const inputs = [
      obs({ title: 'A', narrative: 'a' }),
      obs({ title: 'B', narrative: 'b' }),
      obs({ title: 'C', narrative: 'c' }),
    ];

    const result = store.storeObservations(session('mem-tx'), 'project', inputs, null, undefined, 0, 1700000000000);

    expect(result.observationIds.length).toBe(3);
    expect(result.summaryId).toBeNull();
    expect(result.createdAtEpoch).toBe(1700000000000);
  });

  it('shares one timestamp across the whole batch', () => {
    const inputs = [obs({ title: 'A', narrative: 'a' }), obs({ title: 'B', narrative: 'b' })];
    store.storeObservations(session('mem-ts'), 'project', inputs, null, undefined, 0, 1700000000000);

    const epochs = store.db.prepare('SELECT DISTINCT created_at_epoch FROM observations').all() as Array<{ created_at_epoch: number }>;
    expect(epochs.length).toBe(1);
    expect(epochs[0].created_at_epoch).toBe(1700000000000);
  });

  it('stores observations + summary together with a retrievable summary', () => {
    const result = store.storeObservations(
      session('mem-with-summary'),
      'project',
      [obs({ title: 'A', narrative: 'a' })],
      summary({ request: 'do the thing' })
    );

    expect(result.summaryId).not.toBeNull();
    expect(store.getSummaryForSession('mem-with-summary')?.request).toBe('do the thing');
  });

  it('handles an empty observations array', () => {
    const result = store.storeObservations(session('mem-empty'), 'project', [], null);
    expect(result.observationIds.length).toBe(0);
    expect(result.summaryId).toBeNull();
  });

  it('handles summary-only (no observations)', () => {
    const result = store.storeObservations(session('mem-summary-only'), 'project', [], summary());
    expect(result.observationIds.length).toBe(0);
    expect(result.summaryId).not.toBeNull();
  });

  it('applies promptNumber to every observation in the batch', () => {
    store.storeObservations(
      session('mem-prompt'),
      'project',
      [obs({ title: 'A', narrative: 'a' }), obs({ title: 'B', narrative: 'b' })],
      null,
      7
    );

    const rows = store.db.prepare('SELECT prompt_number FROM observations WHERE memory_session_id = ?').all('mem-prompt') as Array<{ prompt_number: number }>;
    expect(rows.length).toBe(2);
    expect(rows.every(r => r.prompt_number === 7)).toBe(true);
  });
});
