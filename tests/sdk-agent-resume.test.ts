import { describe, it, expect } from 'vitest';
import type { ProviderType } from '../src/services/worker-types.js';

/**
 * Tests for SDKAgent resume parameter logic
 *
 * The resume parameter should ONLY be passed when:
 * 1. memorySessionIdCapturedLive === true (captured from a live SDK session in this process)
 * 2. lastPromptNumber > 1 (this is a continuation within the same SDK session)
 *
 * The memorySessionIdCapturedLive flag is:
 * - Initialized to false when the session is created
 * - Set to true ONLY when a fresh session_id is captured from the SDK response
 * - Reset to false on provider change
 *
 * This prevents stale resume in ALL scenarios:
 * - Worker restart: flag starts as false
 * - DB-restored memorySessionId: flag stays false (DB restore doesn't set it)
 * - Provider change: flag is reset to false
 * - Second startSession() call with DB-restored ID: flag is still false
 */
describe('SDKAgent Resume Parameter Logic', () => {
  /**
   * Helper function that mirrors the ACTUAL logic in SDKAgent.startSession()
   * Uses memorySessionIdCapturedLive as the primary guard
   */
  function shouldPassResumeParameter(session: {
    memorySessionIdCapturedLive: boolean;
    lastPromptNumber: number;
  }): boolean {
    return session.memorySessionIdCapturedLive && session.lastPromptNumber > 1;
  }

  describe('INIT prompt scenarios (lastPromptNumber === 1)', () => {
    it('should NOT resume when lastPromptNumber === 1 even if captured live', () => {
      // Edge case: somehow captured live but still on first prompt
      const session = {
        memorySessionIdCapturedLive: true,
        lastPromptNumber: 1,
      };

      expect(shouldPassResumeParameter(session)).toBe(false);
    });

    it('should NOT resume when lastPromptNumber === 1 and not captured live', () => {
      const session = {
        memorySessionIdCapturedLive: false,
        lastPromptNumber: 1,
      };

      expect(shouldPassResumeParameter(session)).toBe(false);
    });
  });

  describe('CONTINUATION prompt scenarios (lastPromptNumber > 1)', () => {
    it('should resume when captured live AND lastPromptNumber > 1', () => {
      // Normal continuation within same SDK session
      const session = {
        memorySessionIdCapturedLive: true,
        lastPromptNumber: 2,
      };

      expect(shouldPassResumeParameter(session)).toBe(true);
    });

    it('should resume for higher prompt numbers', () => {
      const session = {
        memorySessionIdCapturedLive: true,
        lastPromptNumber: 5,
      };

      expect(shouldPassResumeParameter(session)).toBe(true);
    });

    it('should NOT resume when not captured live even for lastPromptNumber > 1', () => {
      // Key scenario: DB-restored memorySessionId, second call to startSession()
      const session = {
        memorySessionIdCapturedLive: false,
        lastPromptNumber: 2,
      };

      expect(shouldPassResumeParameter(session)).toBe(false);
    });
  });

  describe('Provider change scenarios', () => {
    /**
     * Mirrors the provider-change detection logic in SDKAgent.startSession().
     * When switching providers, memorySessionIdCapturedLive is reset to false.
     */
    function detectProviderChange(
      currentProvider: ProviderType | null,
      newProvider: ProviderType
    ): boolean {
      return currentProvider !== null && currentProvider !== newProvider;
    }

    function simulateProviderChangeEffect(session: {
      memorySessionIdCapturedLive: boolean;
      lastPromptNumber: number;
    }, providerChanged: boolean): boolean {
      if (providerChanged) {
        session.memorySessionIdCapturedLive = false;  // Reset on provider change
      }
      return shouldPassResumeParameter(session);
    }

    it('should NOT resume when switching from openai-compat to claude', () => {
      const providerChanged = detectProviderChange('openai-compat', 'claude');
      const session = {
        memorySessionIdCapturedLive: true,  // Was captured by openai-compat
        lastPromptNumber: 5,
      };

      expect(providerChanged).toBe(true);
      expect(simulateProviderChangeEffect(session, providerChanged)).toBe(false);
      // Flag was reset
      expect(session.memorySessionIdCapturedLive).toBe(false);
    });

    it('should NOT resume when switching from gemini to claude', () => {
      const providerChanged = detectProviderChange('gemini', 'claude');
      const session = {
        memorySessionIdCapturedLive: true,
        lastPromptNumber: 3,
      };

      expect(providerChanged).toBe(true);
      expect(simulateProviderChangeEffect(session, providerChanged)).toBe(false);
    });

    it('should allow resume when provider stays the same', () => {
      const providerChanged = detectProviderChange('claude', 'claude');
      const session = {
        memorySessionIdCapturedLive: true,
        lastPromptNumber: 4,
      };

      expect(providerChanged).toBe(false);
      expect(simulateProviderChangeEffect(session, providerChanged)).toBe(true);
      // Flag stays true
      expect(session.memorySessionIdCapturedLive).toBe(true);
    });

    it('should not detect change when currentProvider is null (first time starting)', () => {
      const providerChanged = detectProviderChange(null, 'claude');
      expect(providerChanged).toBe(false);
    });

    it('should not resume when currentProvider is null with DB-restored memorySessionId', () => {
      // Worker restart: currentProvider is null, memorySessionId restored from DB
      const providerChanged = detectProviderChange(null, 'claude');
      const session = {
        memorySessionIdCapturedLive: false,  // Not captured live — restored from DB
        lastPromptNumber: 1,
      };

      expect(providerChanged).toBe(false);
      // Even though provider didn't change, the flag is false → no resume
      expect(simulateProviderChangeEffect(session, providerChanged)).toBe(false);
    });
  });

  describe('Bug reproduction: stale session resume crash', () => {
    it('should NOT resume when worker restarts with stale memorySessionId', () => {
      // Original bug from logs:
      // [17:30:21.773] Starting SDK query { resume_parameter=5439891b-... }
      // [17:30:24.450] Generator failed {error=Claude Code process exited with code 1}
      const session = {
        memorySessionIdCapturedLive: false,  // Worker restarted — not captured live
        lastPromptNumber: 1,
      };

      expect(shouldPassResumeParameter(session)).toBe(false);
    });

    it('should resume correctly for normal continuation (not after restart)', () => {
      const session = {
        memorySessionIdCapturedLive: true,  // Captured live in this process
        lastPromptNumber: 2,
      };

      expect(shouldPassResumeParameter(session)).toBe(true);
    });
  });

  describe('Bug reproduction: second startSession() with DB-restored ID', () => {
    /**
     * This is the EXACT bug that memorySessionIdCapturedLive fixes.
     *
     * Before the fix, `restoredFromDb` was a local variable in startSession(),
     * so it reset to false on the second call. The stale openai-compat
     * memorySessionId passed all guards and was used for resume.
     */
    it('should NOT resume on second startSession() when memorySessionId was DB-restored', () => {
      // Simulate: first call restored from DB, second call with same session
      const session = {
        memorySessionIdCapturedLive: false,  // DB-restored, never set to true
        lastPromptNumber: 3,  // Multiple prompts processed
      };

      // The old code with local `restoredFromDb` would return true here (the bug!)
      // The new code with persistent `memorySessionIdCapturedLive` returns false
      expect(shouldPassResumeParameter(session)).toBe(false);
    });

    it('should NOT resume even after many startSession() calls with DB-restored ID', () => {
      // The flag stays false across ALL calls when never captured live
      const session = {
        memorySessionIdCapturedLive: false,
        lastPromptNumber: 10,
      };

      expect(shouldPassResumeParameter(session)).toBe(false);
    });

    it('should resume after capturing fresh session_id from SDK', () => {
      // Simulate: first call started fresh, SDK returned session_id, flag set to true
      const session = {
        memorySessionIdCapturedLive: true,  // Captured from live SDK response
        lastPromptNumber: 2,
      };

      expect(shouldPassResumeParameter(session)).toBe(true);
    });
  });

  describe('Full lifecycle simulation', () => {
    it('should handle provider switch → fresh start → capture → resume cycle', () => {
      // Simulates the full lifecycle after a provider switch
      const session = {
        memorySessionIdCapturedLive: true,  // Was captured by previous provider
        lastPromptNumber: 5,
        currentProvider: 'openai-compat' as ProviderType | null,
        memorySessionId: 'old-openai-session-id' as string | null,
      };

      // Step 1: Provider change detected, flag reset
      const providerChanged = session.currentProvider !== null && session.currentProvider !== 'claude';
      if (providerChanged) {
        session.memorySessionIdCapturedLive = false;
      }
      session.currentProvider = 'claude';

      // Step 2: First startSession() — can't resume
      expect(shouldPassResumeParameter(session)).toBe(false);

      // Step 3: SDK returns new session_id, but memorySessionId is already set from DB
      // So we don't capture it. Flag stays false.
      const sdkReturnedSessionId = 'new-claude-session-id';
      if (!session.memorySessionId) {
        session.memorySessionId = sdkReturnedSessionId;
        session.memorySessionIdCapturedLive = true;
      }
      // memorySessionId was already set, so capture was skipped
      expect(session.memorySessionIdCapturedLive).toBe(false);
      expect(session.memorySessionId).toBe('old-openai-session-id');

      // Step 4: Second startSession() — still can't resume (flag still false)
      session.lastPromptNumber = 6;
      expect(shouldPassResumeParameter(session)).toBe(false);
    });

    it('should handle clean start → capture → resume cycle', () => {
      // Normal lifecycle without provider change
      const session = {
        memorySessionIdCapturedLive: false,  // Fresh session
        lastPromptNumber: 1,
        memorySessionId: null as string | null,
      };

      // Step 1: First startSession() — can't resume (fresh)
      expect(shouldPassResumeParameter(session)).toBe(false);

      // Step 2: SDK returns session_id, we capture it
      const sdkReturnedSessionId = 'fresh-session-id';
      if (!session.memorySessionId) {
        session.memorySessionId = sdkReturnedSessionId;
        session.memorySessionIdCapturedLive = true;
      }
      expect(session.memorySessionIdCapturedLive).toBe(true);

      // Step 3: Second startSession() — CAN resume now
      session.lastPromptNumber = 2;
      expect(shouldPassResumeParameter(session)).toBe(true);

      // Step 4: Third startSession() — still can resume
      session.lastPromptNumber = 3;
      expect(shouldPassResumeParameter(session)).toBe(true);
    });
  });
});
