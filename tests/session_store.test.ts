import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { SessionStore } from '../src/services/sqlite/SessionStore.js';

describe('SessionStore', () => {
  let store: SessionStore;

  beforeEach(() => {
    store = new SessionStore(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  it('should correctly count user prompts', () => {
    const claudeId = 'claude-session-1';
    store.createSDKSession(claudeId, 'test-project', 'initial prompt');
    
    expect(store.getPromptNumberFromUserPrompts(claudeId)).toBe(0);

    store.saveUserPrompt(claudeId, 1, 'First prompt');
    expect(store.getPromptNumberFromUserPrompts(claudeId)).toBe(1);

    store.saveUserPrompt(claudeId, 2, 'Second prompt');
    expect(store.getPromptNumberFromUserPrompts(claudeId)).toBe(2);

    store.createSDKSession('claude-session-2', 'test-project', 'initial prompt');
    store.saveUserPrompt('claude-session-2', 1, 'Other prompt');
    expect(store.getPromptNumberFromUserPrompts(claudeId)).toBe(2);
  });

  it('should store observation with timestamp override', () => {
    const claudeId = 'claude-sess-obs';
    const memoryId = 'memory-sess-obs';
    const sdkId = store.createSDKSession(claudeId, 'test-project', 'initial prompt');

    store.updateMemorySessionId(sdkId, memoryId);

    const obs = {
      type: 'discovery',
      title: 'Test Obs',
      subtitle: null,
      facts: [],
      narrative: 'Testing',
      concepts: [],
      files_read: [],
      files_modified: []
    };

    const pastTimestamp = 1600000000000; 

    const result = store.storeObservation(
      memoryId, // Use memorySessionId for FK reference
      'test-project',
      obs,
      1,
      0,
      pastTimestamp
    );

    expect(result.createdAtEpoch).toBe(pastTimestamp);

    const stored = store.getObservationById(result.id);
    expect(stored).not.toBeNull();
    expect(stored?.created_at_epoch).toBe(pastTimestamp);

    expect(new Date(stored!.created_at).getTime()).toBe(pastTimestamp);
  });

  it('sets session identity (memory_session_id + worker_port) before an observation can be accepted (#2533)', () => {
    const claudeId = 'claude-identity-1';
    const memoryId = 'memory-identity-1';
    const sdkId = store.createSDKSession(claudeId, 'test-project', 'initial prompt');

    // Fresh session has NO identity yet: memory_session_id is NULL and an
    // observation insert would violate the NOT NULL FK — nothing can be stored.
    const before = store.getSessionById(sdkId);
    expect(before?.memory_session_id).toBeNull();

    // Identity registration is the gate that runs before storeObservations.
    store.ensureMemorySessionIdRegistered(sdkId, memoryId, 37742);

    const after = store.getSessionById(sdkId);
    expect(after?.memory_session_id).toBe(memoryId);
    const portRow = store.db.prepare('SELECT worker_port FROM sdk_sessions WHERE id = ?').get(sdkId) as { worker_port: number | null };
    expect(portRow.worker_port).toBe(37742);

    // Only AFTER identity is set can an observation be accepted into the table.
    const result = store.storeObservation(memoryId, 'test-project', {
      type: 'discovery',
      title: 'Identity gate',
      subtitle: null,
      facts: [],
      narrative: 'Stored only after identity was registered',
      concepts: [],
      files_read: [],
      files_modified: []
    }, 1);
    const stored = store.getObservationById(result.id);
    expect(stored?.memory_session_id).toBe(memoryId);
  });

  it('should store summary with timestamp override', () => {
    const claudeId = 'claude-sess-sum';
    const memoryId = 'memory-sess-sum';
    const sdkId = store.createSDKSession(claudeId, 'test-project', 'initial prompt');

    store.updateMemorySessionId(sdkId, memoryId);

    const summary = {
      request: 'Do something',
      investigated: 'Stuff',
      learned: 'Things',
      completed: 'Done',
      next_steps: 'More',
      notes: null
    };

    const pastTimestamp = 1650000000000;

    const result = store.storeSummary(
      memoryId, // Use memorySessionId for FK reference
      'test-project',
      summary,
      1,
      0,
      pastTimestamp
    );

    expect(result.createdAtEpoch).toBe(pastTimestamp);

    const stored = store.getSummaryForSession(memoryId);
    expect(stored).not.toBeNull();
    expect(stored?.created_at_epoch).toBe(pastTimestamp);
  });
});
