/**
 * Tests for SessionStore in-memory database operations
 *
 * Mock Justification: NONE (0% mock code)
 * - Uses real SQLite with ':memory:' - tests actual SQL and schema
 * - All CRUD operations are tested against real database behavior
 * - Timestamp handling and FK relationships are validated
 *
 * Value: Validates core persistence layer without filesystem dependencies
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { SessionStore } from '../src/services/sqlite/SessionStore.js';

describe('SessionStore', () => {
  let store: SessionStore;

  beforeEach(async () => {
    store = await SessionStore.create(':memory:');
  });

  afterEach(async () => {
    await store.close();
  });

  it('should correctly count user prompts', async () => {
    const claudeId = 'claude-session-1';
    await store.createSDKSession(claudeId, 'test-project', 'initial prompt');

    // Should be 0 initially
    expect(await store.getPromptNumberFromUserPrompts(claudeId)).toBe(0);

    // Save prompt 1
    await store.saveUserPrompt(claudeId, 1, 'First prompt');
    expect(await store.getPromptNumberFromUserPrompts(claudeId)).toBe(1);

    // Save prompt 2
    await store.saveUserPrompt(claudeId, 2, 'Second prompt');
    expect(await store.getPromptNumberFromUserPrompts(claudeId)).toBe(2);

    // Save prompt for another session
    await store.createSDKSession('claude-session-2', 'test-project', 'initial prompt');
    await store.saveUserPrompt('claude-session-2', 1, 'Other prompt');
    expect(await store.getPromptNumberFromUserPrompts(claudeId)).toBe(2);
  });

  it('should store observation with timestamp override', async () => {
    const claudeId = 'claude-sess-obs';
    const memoryId = 'memory-sess-obs';
    const sdkId = await store.createSDKSession(claudeId, 'test-project', 'initial prompt');

    // Set the memory_session_id before storing observations
    // createSDKSession now initializes memory_session_id = NULL
    await store.updateMemorySessionId(sdkId, memoryId);

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

    const pastTimestamp = 1600000000000; // Some time in the past

    const result = await store.storeObservation(
      memoryId, // Use memorySessionId for FK reference
      'test-project',
      obs,
      1,
      0,
      pastTimestamp
    );

    expect(result.createdAtEpoch).toBe(pastTimestamp);

    const stored = await store.getObservationById(result.id);
    expect(stored).not.toBeNull();
    expect(stored?.created_at_epoch).toBe(pastTimestamp);

    // Verify ISO string matches
    expect(new Date(stored!.created_at).getTime()).toBe(pastTimestamp);
  });

  it('should store summary with timestamp override', async () => {
    const claudeId = 'claude-sess-sum';
    const memoryId = 'memory-sess-sum';
    const sdkId = await store.createSDKSession(claudeId, 'test-project', 'initial prompt');

    // Set the memory_session_id before storing summaries
    await store.updateMemorySessionId(sdkId, memoryId);

    const summary = {
      request: 'Do something',
      investigated: 'Stuff',
      learned: 'Things',
      completed: 'Done',
      next_steps: 'More',
      notes: null
    };

    const pastTimestamp = 1650000000000;

    const result = await store.storeSummary(
      memoryId, // Use memorySessionId for FK reference
      'test-project',
      summary,
      1,
      0,
      pastTimestamp
    );

    expect(result.createdAtEpoch).toBe(pastTimestamp);

    const stored = await store.getSummaryForSession(memoryId);
    expect(stored).not.toBeNull();
    expect(stored?.created_at_epoch).toBe(pastTimestamp);
  });
});
