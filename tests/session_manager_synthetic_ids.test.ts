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
    // Upstream format: gemini-{contentSessionId}-{Date.now()}
    const syntheticId = 'gemini-75919a84-1ce3-478f-b36c-91b637310fce-1769797226528';

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
    // Upstream format: openrouter-{contentSessionId}-{Date.now()}
    const syntheticId = 'openrouter-b2fc470f-1ce3-478f-b36c-91b637310fce-1706789012345';

    mockGetSessionById.mockImplementation(() => ({
      id: 42,
      content_session_id: 'b2fc470f-1ce3-478f-b36c-91b637310fce',
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

  it('should correctly parse contentSessionId UUID within synthetic ID', () => {
    // CRITICAL TEST: The contentSessionId is a UUID with dashes embedded in the
    // synthetic ID string. The regex must correctly isolate the UUID portion from
    // the provider prefix and timestamp suffix.
    // Format: openrouter-{8-4-4-4-12 UUID}-{timestamp digits}
    const syntheticId = 'openrouter-0971eaa4-abcd-4567-8901-234567890abc-1769797226528';

    mockGetSessionById.mockImplementation(() => ({
      id: 42,
      content_session_id: '0971eaa4-abcd-4567-8901-234567890abc',
      memory_session_id: syntheticId,
      project: 'test-project',
      user_prompt: 'test prompt',
      created_at: Date.now()
    }));

    const session = sessionManager.initializeSession(42, 'test prompt', 1);

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

  it('should reject malformed synthetic ID with correct prefix but invalid format', () => {
    // Has synthetic prefix but missing UUID and timestamp portions
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

    // Strict regex rejects malformed IDs even with correct prefix
    expect(session.memorySessionId).toBeNull();
  });

  it('should reject unknown provider prefix', () => {
    // Valid format but unrecognized provider
    const unknownProvider = 'anthropic-75919a84-1ce3-478f-b36c-91b637310fce-1769797226528';

    mockGetSessionById.mockImplementation(() => ({
      id: 42,
      content_session_id: '75919a84-1ce3-478f-b36c-91b637310fce',
      memory_session_id: unknownProvider,
      project: 'test-project',
      user_prompt: 'test prompt',
      created_at: Date.now()
    }));

    const session = sessionManager.initializeSession(42, 'test prompt', 1);

    // Unknown provider should be treated as SDK UUID and discarded
    expect(session.memorySessionId).toBeNull();
  });

  it('should reject synthetic ID with UUID suffix (old format)', () => {
    // This format was never generated by upstream but tests regex strictness
    const oldFormatId = 'openrouter-75919a84-1ce3-478f-b36c-91b637310fce-550e8400-e29b-41d4-a716-446655440000';

    mockGetSessionById.mockImplementation(() => ({
      id: 42,
      content_session_id: '75919a84-1ce3-478f-b36c-91b637310fce',
      memory_session_id: oldFormatId,
      project: 'test-project',
      user_prompt: 'test prompt',
      created_at: Date.now()
    }));

    const session = sessionManager.initializeSession(42, 'test prompt', 1);

    // UUID suffix does not match \\d+ pattern — should be discarded
    expect(session.memorySessionId).toBeNull();
  });

  it('should handle concurrent initialization with same sessionDbId', () => {
    // Simulate: first call sees no memorySessionId, second call returns cached session
    const syntheticId = 'gemini-75919a84-1ce3-478f-b36c-91b637310fce-1769797226528';

    let callCount = 0;
    mockGetSessionById.mockImplementation(() => {
      callCount++;
      return {
        id: 42,
        content_session_id: '75919a84-1ce3-478f-b36c-91b637310fce',
        memory_session_id: callCount === 1 ? null : syntheticId,
        project: 'test-project',
        user_prompt: 'test prompt',
        created_at: Date.now()
      };
    });

    // First initialization — no ID in DB yet
    const session1 = sessionManager.initializeSession(42, 'test prompt', 1);
    expect(session1.memorySessionId).toBeNull();

    // Second initialization — returns cached session (doesn't re-read DB)
    const session2 = sessionManager.initializeSession(42, 'test prompt', 1);
    expect(session2).toBe(session1);
  });

  it('should reject non-UUID contentSessionId in synthetic ID', () => {
    const invalidSyntheticId = 'gemini-NOTAUUID-1769797226528';

    mockGetSessionById.mockImplementation(() => ({
      id: 42,
      content_session_id: '75919a84-1ce3-478f-b36c-91b637310fce',
      memory_session_id: invalidSyntheticId,
      project: 'test-project',
      user_prompt: 'test prompt',
      created_at: Date.now()
    }));

    const session = sessionManager.initializeSession(42, 'test prompt', 1);

    // Invalid UUID in contentSessionId portion should be rejected
    expect(session.memorySessionId).toBeNull();
  });

  it('should handle whitespace-only memorySessionId as null', () => {
    mockGetSessionById.mockImplementation(() => ({
      id: 42,
      content_session_id: '75919a84-1ce3-478f-b36c-91b637310fce',
      memory_session_id: '   ', // Whitespace only
      project: 'test-project',
      user_prompt: 'test prompt',
      created_at: Date.now()
    }));

    const session = sessionManager.initializeSession(42, 'test prompt', 1);

    // Whitespace-only should be treated as no ID
    expect(session.memorySessionId).toBeNull();
  });
});
