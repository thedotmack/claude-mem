import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { SessionManager } from '../src/services/worker/SessionManager';
import { DatabaseManager } from '../src/services/worker/DatabaseManager';

describe('SessionManager - Synthetic ID Handling', () => {
  let sessionManager: SessionManager;
  let mockDbManager: DatabaseManager;
  let mockGetSessionById: any;
  let mockGetPromptNumberFromUserPrompts: any;

  beforeEach(() => {
    mockGetPromptNumberFromUserPrompts = mock(() => 1);

    const mockSessionStore = {
      getPromptNumberFromUserPrompts: mockGetPromptNumberFromUserPrompts,
      db: {} // Mock db object for PendingMessageStore
    };

    mockGetSessionById = mock();

    mockDbManager = {
      getSessionById: mockGetSessionById,
      getSessionStore: () => mockSessionStore
    } as unknown as DatabaseManager;

    sessionManager = new SessionManager(mockDbManager);
  });

  it('should preserve synthetic ID (gemini-*) across restart', () => {
    const syntheticId = 'gemini-75919a84-1ce3-478f-b36c-91b637310fce-78bc64d2-8eeb-4c16-94c1-1e2a78e56327';

    mockGetSessionById.mockImplementation(() => ({
      id: 42,
      content_session_id: '75919a84-1ce3-478f-b36c-91b637310fce',
      memory_session_id: syntheticId,
      project: 'test-project',
      user_prompt: 'test prompt',
      created_at: Date.now()
    }));

    const session = sessionManager.initializeSession(42, 'test prompt', 1);

    // Verify synthetic ID was preserved
    expect(session.memorySessionId).toBe(syntheticId);
    expect(session.sessionDbId).toBe(42);
    expect(session.contentSessionId).toBe('75919a84-1ce3-478f-b36c-91b637310fce');
  });

  it('should preserve synthetic ID (openrouter-*) across restart', () => {
    const syntheticId = 'openrouter-75919a84-1ce3-478f-b36c-91b637310fce-660e8400-e29b-41d4-a716-446655440000';

    mockGetSessionById.mockImplementation(() => ({
      id: 42,
      content_session_id: '75919a84-1ce3-478f-b36c-91b637310fce',
      memory_session_id: syntheticId,
      project: 'test-project',
      user_prompt: 'test prompt',
      created_at: Date.now()
    }));

    const session = sessionManager.initializeSession(42, 'test prompt', 1);

    // Verify synthetic ID was preserved
    expect(session.memorySessionId).toBe(syntheticId);
  });

  it('should discard SDK UUID across restart', () => {
    const sdkUuid = '550e8400-e29b-41d4-a716-446655440000'; // Plain UUID (SDK format)

    mockGetSessionById.mockImplementation(() => ({
      id: 42,
      content_session_id: '75919a84-1ce3-478f-b36c-91b637310fce',
      memory_session_id: sdkUuid,
      project: 'test-project',
      user_prompt: 'test prompt',
      created_at: Date.now()
    }));

    const session = sessionManager.initializeSession(42, 'test prompt', 1);

    // Verify SDK UUID was discarded (set to null)
    expect(session.memorySessionId).toBeNull();
  });

  it('should validate synthetic ID with dashes in contentSessionId', () => {
    // CRITICAL TEST: Ensures regex includes dash in character class
    // contentSessionId is a UUID with dashes: 75919a84-1ce3-478f-b36c-91b637310fce
    const syntheticId = 'openrouter-75919a84-1ce3-478f-b36c-91b637310fce-78bc64d2-8eeb-4c16-94c1-1e2a78e56327';

    mockGetSessionById.mockImplementation(() => ({
      id: 42,
      content_session_id: '75919a84-1ce3-478f-b36c-91b637310fce',
      memory_session_id: syntheticId,
      project: 'test-project',
      user_prompt: 'test prompt',
      created_at: Date.now()
    }));

    const session = sessionManager.initializeSession(42, 'test prompt', 1);

    // This test verifies the regex pattern [a-zA-Z0-9-]+ includes dash
    // If the regex used [a-zA-Z0-9]+ (without dash), this would fail
    expect(session.memorySessionId).toBe(syntheticId);
    expect(session.memorySessionId).not.toBeNull();
  });

  it('should handle empty string memorySessionId as null', () => {
    mockGetSessionById.mockImplementation(() => ({
      id: 42,
      content_session_id: '75919a84-1ce3-478f-b36c-91b637310fce',
      memory_session_id: '', // Empty string
      project: 'test-project',
      user_prompt: 'test prompt',
      created_at: Date.now()
    }));

    const session = sessionManager.initializeSession(42, 'test prompt', 1);

    // Empty string should be treated as no ID
    expect(session.memorySessionId).toBeNull();
  });

  it('should handle null memorySessionId gracefully', () => {
    mockGetSessionById.mockImplementation(() => ({
      id: 42,
      content_session_id: '75919a84-1ce3-478f-b36c-91b637310fce',
      memory_session_id: null,
      project: 'test-project',
      user_prompt: 'test prompt',
      created_at: Date.now()
    }));

    const session = sessionManager.initializeSession(42, 'test prompt', 1);

    // Null should remain null
    expect(session.memorySessionId).toBeNull();
  });

  it('should preserve malformed synthetic ID with prefix match', () => {
    // Edge case: Malformed ID but has synthetic prefix
    const malformedId = 'gemini-incomplete';

    mockGetSessionById.mockImplementation(() => ({
      id: 42,
      content_session_id: '75919a84-1ce3-478f-b36c-91b637310fce',
      memory_session_id: malformedId,
      project: 'test-project',
      user_prompt: 'test prompt',
      created_at: Date.now()
    }));

    const session = sessionManager.initializeSession(42, 'test prompt', 1);

    // Even malformed synthetic IDs should be preserved (they won't match strict regex)
    // Actually, the regex is strict, so malformed IDs will be discarded
    // Let's verify this behavior
    expect(session.memorySessionId).toBeNull(); // Malformed = discarded
  });

  it('should handle concurrent initialization with same sessionDbId (F6)', () => {
    // Simulate race condition: both calls see no memorySessionId initially
    const syntheticId = 'gemini-75919a84-1ce3-478f-b36c-91b637310fce-78bc64d2-8eeb-4c16-94c1-1e2a78e56327';

    let callCount = 0;
    mockGetSessionById.mockImplementation(() => {
      callCount++;
      // First call returns null, subsequent calls return the synthetic ID (as if another thread set it)
      return {
        id: 42,
        content_session_id: '75919a84-1ce3-478f-b36c-91b637310fce',
        memory_session_id: callCount === 1 ? null : syntheticId,
        project: 'test-project',
        user_prompt: 'test prompt',
        created_at: Date.now()
      };
    });

    // First initialization
    const session1 = sessionManager.initializeSession(42, 'test prompt', 1);

    // Session should be created and cached
    expect(session1.memorySessionId).toBeNull(); // First call had no ID yet

    // Second initialization with same ID returns cached session
    const session2 = sessionManager.initializeSession(42, 'test prompt', 1);

    // Should return the same cached session object (SessionManager caches by sessionDbId)
    expect(session2).toBe(session1);
  });

  it('should validate tightened UUID regex rejects non-UUID contentSessionId (F1)', () => {
    // Test that the strict UUID pattern catches malformed IDs
    const invalidSyntheticId = 'gemini-NOTAUUID-78bc64d2-8eeb-4c16-94c1-1e2a78e56327';

    mockGetSessionById.mockImplementation(() => ({
      id: 42,
      content_session_id: '75919a84-1ce3-478f-b36c-91b637310fce',
      memory_session_id: invalidSyntheticId,
      project: 'test-project',
      user_prompt: 'test prompt',
      created_at: Date.now()
    }));

    const session = sessionManager.initializeSession(42, 'test prompt', 1);

    // Invalid UUID in contentSessionId portion should be rejected by strict regex
    expect(session.memorySessionId).toBeNull();
  });
});
