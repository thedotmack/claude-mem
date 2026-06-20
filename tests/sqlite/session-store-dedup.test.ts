import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { computeObservationContentHash } from '../../src/services/sqlite/observations/store.js';

function obs(overrides: Partial<Parameters<SessionStore['storeObservation']>[2]> = {}) {
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

describe('computeObservationContentHash', () => {
  it('is deterministic and 16 chars', () => {
    const a = computeObservationContentHash('session-1', 'Title A', 'Narrative A');
    const b = computeObservationContentHash('session-1', 'Title A', 'Narrative A');
    expect(a).toBe(b);
    expect(a.length).toBe(16);
  });

  it('different content produces different hash', () => {
    const a = computeObservationContentHash('session-1', 'Title A', 'Narrative A');
    const b = computeObservationContentHash('session-1', 'Title B', 'Narrative B');
    expect(a).not.toBe(b);
  });

  it('handles null title and narrative', () => {
    expect(computeObservationContentHash('session-1', null, null).length).toBe(16);
  });

  it('avoids collision from field boundary ambiguity', () => {
    const h1 = computeObservationContentHash('session-abc', 'debug log', '');
    const h2 = computeObservationContentHash('session-ab', 'cdebug log', '');
    const h3 = computeObservationContentHash('session-', 'abcdebug log', '');
    const h4 = computeObservationContentHash('', 'session-abcdebug log', '');
    expect(new Set([h1, h2, h3, h4]).size).toBe(4);
  });
});

describe('SessionStore observation deduplication', () => {
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

  it('dedupes identical (memId,title,narrative) to the same id regardless of time gap', () => {
    const o = obs({ title: 'Same Title', narrative: 'Same Narrative' });
    const now = Date.now();
    const mem = session('mem-dedup');

    const r1 = store.storeObservation(mem, 'project', o, 1, 0, now);
    const r2 = store.storeObservation(mem, 'project', o, 1, 0, now + 31_000);

    expect(r2.id).toBe(r1.id);

    const count = store.db.prepare('SELECT COUNT(*) as n FROM observations').get() as { n: number };
    expect(count.n).toBe(1);
  });

  it('stores different content at the same timestamp as distinct ids with 16-char content_hash', () => {
    const now = Date.now();
    const mem = session('mem-diff');
    const r1 = store.storeObservation(mem, 'project', obs({ title: 'Title A', narrative: 'Narrative A' }), 1, 0, now);
    const r2 = store.storeObservation(mem, 'project', obs({ title: 'Title B', narrative: 'Narrative B' }), 1, 0, now);

    expect(r2.id).not.toBe(r1.id);

    const row = store.db.prepare('SELECT content_hash FROM observations WHERE id = ?').get(r1.id) as { content_hash: string };
    expect(row.content_hash.length).toBe(16);
  });

  it('storeObservations batch of 3 identical inputs returns 3 equal ids and writes 1 physical row', () => {
    const o = obs({ title: 'Duplicate', narrative: 'Same content' });
    const mem = session('mem-batch');

    const result = store.storeObservations(mem, 'project', [o, o, o], null);

    expect(result.observationIds.length).toBe(3);
    expect(result.observationIds[1]).toBe(result.observationIds[0]);
    expect(result.observationIds[2]).toBe(result.observationIds[0]);

    const count = store.db.prepare('SELECT COUNT(*) as n FROM observations').get() as { n: number };
    expect(count.n).toBe(1);
  });

  it('dedup is unaffected by agent fields and preserves the original agent fields', () => {
    const mem = session('mem-agent-dedup');
    const first = store.storeObservation(mem, 'project', obs({
      title: 'Identical Title',
      narrative: 'Identical narrative body.',
      agent_type: 'Explore',
      agent_id: 'agent-first',
    }));

    const second = store.storeObservation(mem, 'project', obs({
      title: 'Identical Title',
      narrative: 'Identical narrative body.',
      agent_type: 'Plan',
      agent_id: 'agent-second',
    }));

    expect(second.id).toBe(first.id);

    const count = store.db.prepare('SELECT COUNT(*) as n FROM observations WHERE memory_session_id = ?').get('mem-agent-dedup') as { n: number };
    expect(count.n).toBe(1);

    const row = store.getObservationById(first.id);
    expect(row?.agent_type).toBe('Explore');
    expect(row?.agent_id).toBe('agent-first');
  });
});
