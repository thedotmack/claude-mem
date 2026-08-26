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

  it('stores agent_type and agent_id when provided', () => {
    const result = store.storeObservation(session('mem-agent'), 'project', obs({ agent_type: 'Explore', agent_id: 'agent-abc' }));

    const row = store.getObservationById(result.id);
    expect(row?.agent_type).toBe('Explore');
    expect(row?.agent_id).toBe('agent-abc');
  });

  it('defaults agent_type and agent_id to NULL when omitted', () => {
    const result = store.storeObservation(session('mem-noagent'), 'project', obs());

    const row = store.getObservationById(result.id);
    expect(row?.agent_type).toBeNull();
    expect(row?.agent_id).toBeNull();
  });

  it('stores agent_type alone when agent_id is absent', () => {
    const result = store.storeObservation(session('mem-partial'), 'project', obs({ agent_type: 'Plan' }));

    const row = store.getObservationById(result.id);
    expect(row?.agent_type).toBe('Plan');
    expect(row?.agent_id).toBeNull();
  });

  it('getFirstObservationCreatedAt returns null when empty and the earliest ISO otherwise', () => {
    expect(getFirstObservationCreatedAt(store.db)).toBeNull();

    const mem = session('mem-a');
    store.storeObservation(mem, 'project', obs({ title: 'Later', narrative: 'b' }), 1, 0, 2000000000000);
    store.storeObservation(mem, 'project', obs({ title: 'Earlier', narrative: 'a' }), 1, 0, 1000000000000);

    expect(getFirstObservationCreatedAt(store.db)).toBe(new Date(1000000000000).toISOString());
  });
});
