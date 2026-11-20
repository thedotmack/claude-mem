import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { getFirstObservationCreatedAt } from '../../src/services/sqlite/observations/recent.js';

function obs(overrides: Partial<Parameters<SessionStore['storeObservation']>[2]> = {}) {
  return {
    type: 'discovery',
    title: 'Test Observation',
    subtitle: 'Test Subtitle',
    facts: ['fact1', 'fact2'],
    narrative: 'Test narrative content',
    concepts: ['concept1', 'concept2'],
    files_read: ['/path/to/file1.ts'],
    files_modified: ['/path/to/file2.ts'],
    ...overrides,
  };
}

describe('SessionStore.storeObservation', () => {
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

  it('returns positive id and createdAtEpoch and round-trips all fields', () => {
    const result = store.storeObservation(session('mem-1'), 'project', obs(), 3);

    expect(result.id).toBeGreaterThan(0);
    expect(result.createdAtEpoch).toBeGreaterThan(0);

    const row = store.getObservationById(result.id);
    expect(row).not.toBeNull();
    expect(row?.memory_session_id).toBe('mem-1');
    expect(row?.project).toBe('project');
    expect(row?.type).toBe('discovery');
    expect(row?.title).toBe('Test Observation');
    expect(row?.subtitle).toBe('Test Subtitle');
    expect(row?.narrative).toBe('Test narrative content');
    expect(JSON.parse(row?.facts as string)).toEqual(['fact1', 'fact2']);
    expect(JSON.parse(row?.concepts as string)).toEqual(['concept1', 'concept2']);
    expect(JSON.parse(row?.files_read as string)).toEqual(['/path/to/file1.ts']);
    expect(JSON.parse(row?.files_modified as string)).toEqual(['/path/to/file2.ts']);
    expect(row?.prompt_number).toBe(3);
  });

  it('honors overrideTimestampEpoch (epoch + ISO)', () => {
    const past = 1650000000000;
    const result = store.storeObservation(session('mem-ts'), 'project', obs(), 1, 0, past);

    expect(result.createdAtEpoch).toBe(past);

    const row = store.getObservationById(result.id);
    expect(row?.created_at_epoch).toBe(past);
    expect(row?.created_at).toBe(new Date(past).toISOString());
  });

  it('defaults timestamp to now when overrideTimestampEpoch omitted', () => {
    const before = Date.now();
    const result = store.storeObservation(session('mem-now'), 'project', obs());
    const after = Date.now();

    expect(result.createdAtEpoch).toBeGreaterThanOrEqual(before);
    expect(result.createdAtEpoch).toBeLessThanOrEqual(after);
  });

  it('stores null subtitle and narrative', () => {
    const result = store.storeObservation(session('mem-null'), 'project', obs({ subtitle: null, narrative: null }));

    const row = store.getObservationById(result.id);
    expect(row?.subtitle).toBeNull();
    expect(row?.narrative).toBeNull();
  });

  it('getObservationById returns null for a missing id', () => {
    expect(store.getObservationById(99999)).toBeNull();
  });

  it.each([
    [{ agent_type: 'Explore', agent_id: 'agent-abc' }, 'Explore', 'agent-abc'],
    [{}, null, null],
    [{ agent_type: 'Plan' }, 'Plan', null],
  ] as const)('round-trips agent fields %j', (fields, agentType, agentId) => {
    const result = store.storeObservation(session('mem-agent'), 'project', obs(fields));
    const row = store.getObservationById(result.id);
    expect(row?.agent_type).toBe(agentType);
    expect(row?.agent_id).toBe(agentId);
  });

  it('getFirstObservationCreatedAt returns null when empty and the earliest ISO otherwise', () => {
    expect(getFirstObservationCreatedAt(store.db)).toBeNull();

    const mem = session('mem-a');
    store.storeObservation(mem, 'project', obs({ title: 'Later', narrative: 'b' }), 1, 0, 2000000000000);
    store.storeObservation(mem, 'project', obs({ title: 'Earlier', narrative: 'a' }), 1, 0, 1000000000000);

    expect(getFirstObservationCreatedAt(store.db)).toBe(new Date(1000000000000).toISOString());
  });
});

describe('SessionStore.importObservation', () => {
  let store: SessionStore;

  beforeEach(() => {
    store = new SessionStore(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  function importedObs(memorySessionId: string | null | undefined) {
    return {
      memory_session_id: memorySessionId,
      project: 'project',
      text: null,
      type: 'discovery',
      title: 'Imported observation',
      subtitle: null,
      facts: JSON.stringify(['fact1']),
      narrative: 'Imported narrative',
      concepts: JSON.stringify(['concept1']),
      files_read: JSON.stringify([]),
      files_modified: JSON.stringify([]),
      prompt_number: 1,
      discovery_tokens: 0,
      created_at: new Date(1000000000000).toISOString(),
      created_at_epoch: 1000000000000,
    };
  }

  function observationCount(): number {
    return (store.db.prepare('SELECT COUNT(*) AS n FROM observations').get() as { n: number }).n;
  }

  // Regression: /api/import (DataRoutes.handleImport) feeds unvalidated payload
  // rows (z.array(z.unknown())) straight into importObservation. A row whose
  // memory_session_id is null/undefined must be rejected with a warning rather
  // than crashing with "NOT NULL constraint failed: observations.memory_session_id".
  // Truthiness is not enough: {}, true and 123 are truthy but are not session ids.
  for (const notASessionId of [null, undefined, {}, true, 123, '   ']) {
    it(`rejects an observation whose memory_session_id is ${JSON.stringify(notASessionId)}`, () => {
      const result = store.importObservation(importedObs(notASessionId as any) as any);

      expect(result.imported).toBe(false);
      expect(observationCount()).toBe(0);
    });
  }

});

describe('SessionStore.importSessionSummary', () => {
  let store: SessionStore;

  beforeEach(() => {
    store = new SessionStore(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  function importedSummary(memorySessionId: string | null | undefined) {
    return {
      memory_session_id: memorySessionId,
      project: 'project',
      request: 'Imported request',
      investigated: null,
      learned: null,
      completed: null,
      next_steps: null,
      files_read: null,
      files_edited: null,
      notes: null,
      prompt_number: 1,
      discovery_tokens: 0,
      created_at: new Date(1000000000000).toISOString(),
      created_at_epoch: 1000000000000,
    };
  }

  function summaryCount(): number {
    return (store.db.prepare('SELECT COUNT(*) AS n FROM session_summaries').get() as { n: number }).n;
  }

  // Regression: same /api/import unvalidated-payload exposure as
  // importObservation — session_summaries.memory_session_id is NOT NULL.
  it('rejects a summary with null memory_session_id without throwing or inserting', () => {
    const result = store.importSessionSummary(importedSummary(null) as any);

    expect(result.imported).toBe(false);
    expect(summaryCount()).toBe(0);
  });
});
