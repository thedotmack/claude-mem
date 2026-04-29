/**
 * Regression test for #2153: ChromaSearchStrategy passes orderBy='relevance'
 * to SessionStore.getObservationsByIds expecting Chroma's vector ranking
 * (caller-provided ID order) to be preserved. The old code coerced
 * 'relevance' to undefined, which then defaulted to 'date_desc' inside
 * SessionStore, destroying the semantic ranking.
 *
 * Mock Justification: NONE - real SQLite ':memory:' covers SQL + ordering.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';

describe('SessionStore.*ByIds — orderBy: "relevance" preserves caller ID order (#2153)', () => {
  let store: SessionStore;

  beforeEach(() => {
    store = new SessionStore(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  it('getObservationsByIds returns rows in caller-provided ID order when orderBy is "relevance"', () => {
    const sdkId = store.createSDKSession('content-relevance', 'p', 'prompt');
    store.updateMemorySessionId(sdkId, 'session-relevance');

    // Insert 5 observations with strictly increasing created_at_epoch so that
    // a date_desc default would reverse the natural insertion order. The test
    // proves that caller-provided ID order, not date order, is honored.
    const baseTs = 1_700_000_000_000;
    const inserted: number[] = [];
    for (let i = 0; i < 5; i++) {
      const result = store.storeObservations(
        'session-relevance',
        'p',
        [{
          type: 'test',
          title: `obs-${i}`,
          subtitle: null,
          facts: [`fact ${i}`],
          narrative: null,
          concepts: [],
          files_read: [],
          files_modified: [],
        }],
        null,
        i,
        0,
        baseTs + i * 1000,
      );
      inserted.push(result.observationIds[0]);
    }

    // Reverse the IDs — semantic ranking from Chroma would not match
    // chronological order.
    const callerOrder = [...inserted].reverse();
    const results = store.getObservationsByIds(callerOrder, { orderBy: 'relevance' });

    expect(results.map(r => r.id)).toEqual(callerOrder);
  });

  it('getObservationsByIds still respects date_desc when orderBy defaults', () => {
    const sdkId = store.createSDKSession('content-date', 'p', 'prompt');
    store.updateMemorySessionId(sdkId, 'session-date');
    const baseTs = 1_700_000_000_000;
    const inserted: number[] = [];
    for (let i = 0; i < 3; i++) {
      const result = store.storeObservations(
        'session-date',
        'p',
        [{
          type: 'test',
          title: `obs-${i}`,
          subtitle: null,
          facts: [`fact ${i}`],
          narrative: null,
          concepts: [],
          files_read: [],
          files_modified: [],
        }],
        null,
        i,
        0,
        baseTs + i * 1000,
      );
      inserted.push(result.observationIds[0]);
    }

    const callerOrder = [...inserted].reverse(); // [oldId... newer... oldest]
    // Default order is date_desc -> newest first regardless of input order.
    const results = store.getObservationsByIds(callerOrder);
    expect(results.map(r => r.id)).toEqual([...inserted].reverse());
  });
});
