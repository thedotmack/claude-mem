import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';

function obs(overrides: Partial<Parameters<SessionStore['storeObservation']>[2]> = {}) {
  return {
    type: 'discovery',
    title: 'A Real Observation',
    subtitle: null,
    facts: [] as string[],
    narrative: 'Some narrative content',
    concepts: [] as string[],
    files_read: [] as string[],
    files_modified: [] as string[],
    ...overrides,
  };
}

describe('SessionStore.storeObservations empty-title handling', () => {
  let store: SessionStore;

  beforeEach(() => {
    store = new SessionStore(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  // observations.memory_session_id is an enforced FK to sdk_sessions; register it first.
  function session(memorySessionId: string): string {
    const id = store.createSDKSession(`content-${memorySessionId}`, 'project', 'prompt');
    store.updateMemorySessionId(id, memorySessionId);
    return memorySessionId;
  }

  it('skips observations with empty, whitespace-only, or null titles', () => {
    const mem = session('mem-empty-title');

    const result = store.storeObservations(
      mem,
      'project',
      [
        obs({ title: 'A Real Observation' }),
        obs({ title: '' }),
        obs({ title: '   ' }),
        obs({ title: null }),
      ],
      null,
      1,
      0,
    );

    expect(result.observationIds.length).toBe(1);

    const stored = store.getObservationsForSession(mem);
    expect(stored.length).toBe(1);
    expect(stored[0].title).toBe('A Real Observation');
  });

  it('stores every observation when all titles are present', () => {
    const mem = session('mem-all-titled');

    const result = store.storeObservations(
      mem,
      'project',
      [obs({ title: 'First' }), obs({ title: 'Second' })],
      null,
      1,
      0,
    );

    expect(result.observationIds.length).toBe(2);
    expect(store.getObservationsForSession(mem).length).toBe(2);
  });

  it('storeObservation (single) throws on an empty title instead of returning an undefined id', () => {
    const mem = session('mem-single-empty');
    expect(() => store.storeObservation(mem, 'project', obs({ title: '' }))).toThrow(/non-empty title/);
    expect(() => store.storeObservation(mem, 'project', obs({ title: null }))).toThrow(/non-empty title/);
  });

  it('storeObservation (single) stores and returns a real id for a titled observation', () => {
    const mem = session('mem-single-ok');
    const result = store.storeObservation(mem, 'project', obs({ title: 'Kept' }));
    expect(result.id).toBeGreaterThan(0);
  });
});
