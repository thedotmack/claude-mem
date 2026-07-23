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

    const callerOrder = [...inserted].reverse();
    const results = store.getObservationsByIds(callerOrder);
    expect(results.map(r => r.id)).toEqual([...inserted].reverse());
  });

  // getUserPromptsByIds diverged from its two siblings: it applied LIMIT without
  // guarding on !preserveIdOrder, and returned without the trailing .slice(0, limit).
  // Under 'relevance' the ORDER BY clause is empty, so SQLite satisfied the LIMIT
  // straight from the id-index scan in ascending rowid order -- truncating to the
  // OLDEST n candidates and only then permuting the survivors into caller order.
  it('getUserPromptsByIds applies limit AFTER reordering, not before (top-n, not oldest-n)', () => {
    const sdkId = store.createSDKSession('content-prompts', 'p', 'prompt');
    store.updateMemorySessionId(sdkId, 'session-prompts');

    const inserted: number[] = [];
    for (let i = 0; i < 5; i++) {
      inserted.push(store.saveUserPrompt('content-prompts', i, `prompt text ${i}`, sdkId));
    }

    // Ask for them highest-id-first, so "oldest n" and "first n of caller order" differ.
    const callerOrder = [...inserted].reverse();
    const results = store.getUserPromptsByIds(callerOrder, { orderBy: 'relevance', limit: 3 });

    // Pre-fix this returned a single row: SQL LIMIT 3 kept the three lowest ids, then
    // the reorder discarded the two of those that were not in the top 3 of callerOrder.
    expect(results.map(r => r.id)).toEqual(callerOrder.slice(0, 3));
  });

  it('getUserPromptsByIds returns every row in caller order when no limit is given', () => {
    const sdkId = store.createSDKSession('content-prompts-order', 'p', 'prompt');
    store.updateMemorySessionId(sdkId, 'session-prompts-order');

    const inserted: number[] = [];
    for (let i = 0; i < 4; i++) {
      inserted.push(store.saveUserPrompt('content-prompts-order', i, `prompt text ${i}`, sdkId));
    }

    const callerOrder = [...inserted].reverse();
    const results = store.getUserPromptsByIds(callerOrder, { orderBy: 'relevance' });

    expect(results.map(r => r.id)).toEqual(callerOrder);
  });
});
