import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { logger } from '../../src/utils/logger.js';
import { SessionManager } from '../../src/services/worker/SessionManager.js';
import type { DatabaseManager } from '../../src/services/worker/DatabaseManager.js';

function makeDbManager(
  userPrompt: string | null,
  latestPromptText: string | null = null,
): DatabaseManager {
  return {
    getSessionById: () => ({
      content_session_id: 'content-123',
      project: 'proj',
      platform_source: 'claude',
      user_prompt: userPrompt,
      memory_session_id: null,
    }),
    getSessionStore: () => ({
      getPromptNumberFromUserPrompts: () => 1,
      getLatestPromptTextFromUserPrompts: () => latestPromptText,
    }),
  } as unknown as DatabaseManager;
}

let spies: ReturnType<typeof spyOn>[] = [];

describe('SessionManager with NULL user_prompt (worker-restart stale-session window)', () => {
  beforeEach(() => {
    spies = [
      spyOn(logger, 'info').mockImplementation(() => {}),
      spyOn(logger, 'debug').mockImplementation(() => {}),
      spyOn(logger, 'warn').mockImplementation(() => {}),
      spyOn(logger, 'error').mockImplementation(() => {}),
    ];
  });

  afterEach(() => {
    spies.forEach(s => s.mockRestore());
  });

  it('initializeSession does not throw when the db row has NULL user_prompt and no current prompt is provided', () => {
    const sm = new SessionManager(makeDbManager(null));

    const session = sm.initializeSession(1);

    expect(session.contentSessionId).toBe('content-123');
    expect(session.userPrompt ?? null).toBeNull();
  });

  it('cold init uses latest user_prompts text when currentUserPrompt is absent', () => {
    const sm = new SessionManager(makeDbManager('prompt1', 'prompt11'));

    const session = sm.initializeSession(1);

    expect(session.userPrompt).toBe('prompt11');
    expect(session.lastPromptNumber).toBe(1);
  });

  it('cold init falls back to sdk_sessions.user_prompt when user_prompts has no latest text', () => {
    const sm = new SessionManager(makeDbManager('prompt1', null));

    const session = sm.initializeSession(1);

    expect(session.userPrompt).toBe('prompt1');
  });

  it('cold init prefers an explicit currentUserPrompt over latest user_prompts text', () => {
    const sm = new SessionManager(makeDbManager('prompt1', 'prompt11'));

    const session = sm.initializeSession(1, 'fresh prompt', 2);

    expect(session.userPrompt).toBe('fresh prompt');
    expect(session.lastPromptNumber).toBe(2);
  });

  it('cached-session paths tolerate a NULL cached prompt and accept a fresh one', () => {
    const sm = new SessionManager(makeDbManager(null));
    sm.initializeSession(1);

    // Cached session, still no prompt: logs the cached (null) prompt.
    expect(() => sm.initializeSession(1)).not.toThrow();

    // Cached session, fresh prompt arrives: logs old (null) prompt, then updates.
    const session = sm.initializeSession(1, 'fresh prompt', 2);
    expect(session.userPrompt).toBe('fresh prompt');
    expect(session.lastPromptNumber).toBe(2);
  });
});
