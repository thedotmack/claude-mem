import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { SessionStore } from '../src/services/sqlite/SessionStore.js';
import { SessionManager } from '../src/services/worker/SessionManager.js';

describe('SessionManager rehydration user prompt (Issue #4047)', () => {
  let store: SessionStore;
  let testDbPath: string;

  beforeEach(() => {
    testDbPath = `/tmp/test-rehydration-prompt-${crypto.randomUUID()}.db`;
    store = new SessionStore(testDbPath);
  });

  afterEach(() => {
    store.close();
    try {
      require('fs').unlinkSync(testDbPath);
    } catch (e) {
      // Ignore cleanup errors
    }
  });

  it('uses the latest user_prompts row, not the stale sdk_sessions.user_prompt, when rehydrated without a currentUserPrompt', () => {
    const contentSessionId = 'rehydration-test-content-id';
    const sessionDbId = store.createSDKSession(contentSessionId, 'test-project', 'use tool X with model A');

    // sdk_sessions.user_prompt only ever holds the first prompt. user_prompts
    // accumulates every prompt as the conversation continues.
    store.saveUserPrompt(contentSessionId, 1, 'use tool X with model A', sessionDbId);
    // getLatestUserPrompt orders by created_at_epoch (millisecond resolution);
    // force the second row onto a later millisecond so the test isn't racing
    // the clock, real prompts are always seconds apart in practice.
    const t0 = Date.now();
    while (Date.now() === t0) { /* busy-wait past the millisecond boundary */ }
    store.saveUserPrompt(contentSessionId, 4, 'switch to model B instead', sessionDbId);

    const dbManager = {
      getSessionById: (id: number) => store.getSessionById(id),
      getSessionStore: () => store
    } as any;

    // No currentUserPrompt supplied and the session is not in the in-memory
    // map, the exact condition hit on worker restart / eviction.
    const sessionManager = new SessionManager(dbManager);
    const session = sessionManager.initializeSession(sessionDbId);

    expect(session.userPrompt).toBe('switch to model B instead');
    expect(session.userPrompt).not.toBe('use tool X with model A');
  });

  it('falls back to sdk_sessions.user_prompt when user_prompts has no rows yet', () => {
    const contentSessionId = 'rehydration-fallback-content-id';
    const sessionDbId = store.createSDKSession(contentSessionId, 'test-project', 'only prompt so far');

    const dbManager = {
      getSessionById: (id: number) => store.getSessionById(id),
      getSessionStore: () => store
    } as any;

    const sessionManager = new SessionManager(dbManager);
    const session = sessionManager.initializeSession(sessionDbId);

    expect(session.userPrompt).toBe('only prompt so far');
  });
});
