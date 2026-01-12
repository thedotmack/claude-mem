import { describe, it, expect } from 'bun:test';
import { shouldPassResumeParameter } from '../src/services/worker/resume-logic.js';

/**
 * Tests for SDKAgent resume parameter logic
 *
 * The resume parameter should ONLY be passed when:
 * 1. memorySessionId exists (was captured from a previous SDK response)
 * 2. lastPromptNumber > 1 (this is a continuation within the same SDK session)
 * 3. Session was NOT initialized via startup-recovery (SDK context was lost)
 *
 * On worker restart or crash recovery, memorySessionId may exist from a previous
 * SDK session but we must NOT resume because the SDK context was lost.
 */
describe('SDKAgent Resume Parameter Logic', () => {

  describe('INIT prompt scenarios (lastPromptNumber === 1)', () => {
    it('should NOT pass resume parameter when lastPromptNumber === 1 even if memorySessionId exists', () => {
      // Scenario: Worker restart with stale memorySessionId from previous session
      const shouldResume = shouldPassResumeParameter({
        memorySessionId: 'stale-session-id-from-previous-run',
        lastPromptNumber: 1, // INIT prompt
        isStartupRecovery: false,
      });

      expect(shouldResume).toBe(false); // should NOT resume because it's INIT
    });

    it('should NOT pass resume parameter when memorySessionId is null and lastPromptNumber === 1', () => {
      // Scenario: Fresh session, first prompt ever
      const shouldResume = shouldPassResumeParameter({
        memorySessionId: null,
        lastPromptNumber: 1,
        isStartupRecovery: false,
      });

      expect(shouldResume).toBe(false);
    });
  });

  describe('CONTINUATION prompt scenarios (lastPromptNumber > 1)', () => {
    it('should pass resume parameter when lastPromptNumber > 1 AND memorySessionId exists', () => {
      // Scenario: Normal continuation within same SDK session
      const shouldResume = shouldPassResumeParameter({
        memorySessionId: 'valid-session-id',
        lastPromptNumber: 2, // CONTINUATION prompt
        isStartupRecovery: false,
      });

      expect(shouldResume).toBe(true);
    });

    it('should pass resume parameter for higher prompt numbers', () => {
      // Scenario: Later in a multi-turn conversation
      const shouldResume = shouldPassResumeParameter({
        memorySessionId: 'valid-session-id',
        lastPromptNumber: 5, // 5th prompt in session
        isStartupRecovery: false,
      });

      expect(shouldResume).toBe(true);
    });

    it('should NOT pass resume parameter when memorySessionId is null even for lastPromptNumber > 1', () => {
      // Scenario: Bug case - somehow got to prompt 2 without capturing memorySessionId
      // This shouldn't happen in practice but we should handle it safely
      const shouldResume = shouldPassResumeParameter({
        memorySessionId: null,
        lastPromptNumber: 2,
        isStartupRecovery: false,
      });

      expect(shouldResume).toBe(false);
    });
  });

  describe('Edge cases', () => {
    it('should handle empty string memorySessionId as falsy', () => {
      // Empty string should be treated as "no session ID"
      const shouldResume = shouldPassResumeParameter({
        memorySessionId: '' as unknown as null,
        lastPromptNumber: 2,
        isStartupRecovery: false,
      });

      expect(shouldResume).toBe(false);
    });

    it('should handle undefined memorySessionId as falsy', () => {
      const shouldResume = shouldPassResumeParameter({
        memorySessionId: undefined as unknown as null,
        lastPromptNumber: 2,
        isStartupRecovery: false,
      });

      expect(shouldResume).toBe(false);
    });
  });

  describe('Bug reproduction: stale session resume crash', () => {
    it('should NOT resume when worker restarts with stale memorySessionId (lastPromptNumber=1)', () => {
      // This is the exact bug scenario from the logs:
      // [17:30:21.773] Starting SDK query {
      //   hasRealMemorySessionId=true,
      //   resume_parameter=5439891b-...,
      //   lastPromptNumber=1              ← NEW SDK session!
      // }
      // [17:30:24.450] Generator failed {error=Claude Code process exited with code 1}

      const shouldResume = shouldPassResumeParameter({
        memorySessionId: '5439891b-7d4b-4ee3-8662-c000f66bc199', // Stale from previous session
        lastPromptNumber: 1, // But this is a NEW session after restart
        isStartupRecovery: false,
      });

      // The fix: should NOT try to resume, should start fresh
      expect(shouldResume).toBe(false);
    });

    it('should resume correctly for normal continuation (not after restart)', () => {
      // Normal case: same SDK session, continuing conversation
      const shouldResume = shouldPassResumeParameter({
        memorySessionId: '5439891b-7d4b-4ee3-8662-c000f66bc199',
        lastPromptNumber: 2, // Second prompt in SAME session
        isStartupRecovery: false,
      });

      // Should resume - same session, valid memorySessionId
      expect(shouldResume).toBe(true);
    });
  });

  describe('Startup recovery scenarios (NEW - exit code 1 fix)', () => {
    it('should NOT resume when session is auto-recovered at worker startup (lastPromptNumber > 1)', () => {
      // This is the NEW bug scenario from the 2026-01-09 logs:
      // [18:28:31.325] Session initialized (startup-recovery)
      // [18:28:31.327] Starting SDK query {
      //   hasRealMemorySessionId=true,
      //   resume_parameter=f468f8d8-...,
      //   lastPromptNumber=5              ← Loaded from DB, but SDK context is LOST!
      // }
      // [18:28:31.643] Session generator failed {error=Claude Code process exited with code 1}
      //
      // The SDK subprocess was killed when the worker restarted, so trying to resume
      // into the old session ID fails with exit code 1.

      const shouldResume = shouldPassResumeParameter({
        memorySessionId: 'f468f8d8-f219-4436-8276-e6fd4660e4bb', // Valid ID from before restart
        lastPromptNumber: 5, // High prompt number loaded from DB
        isStartupRecovery: true, // KEY: This session was auto-recovered at startup
      });

      // The fix: should NOT try to resume because SDK context was lost
      expect(shouldResume).toBe(false);
    });

    it('should NOT resume even with very high prompt number if startup-recovery', () => {
      const shouldResume = shouldPassResumeParameter({
        memorySessionId: 'valid-session-id',
        lastPromptNumber: 15,
        isStartupRecovery: true,
      });

      expect(shouldResume).toBe(false);
    });

    it('should resume normally after startup-recovery session starts fresh', () => {
      // After a startup-recovery session processes its first SDK response,
      // a new memorySessionId is captured. Subsequent prompts within the same
      // worker process (isStartupRecovery=false) should resume normally.

      const shouldResume = shouldPassResumeParameter({
        memorySessionId: 'newly-captured-session-id',
        lastPromptNumber: 2,
        isStartupRecovery: false, // No longer startup-recovery after first response
      });

      expect(shouldResume).toBe(true);
    });
  });
});
