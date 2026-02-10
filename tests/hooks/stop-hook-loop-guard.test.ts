/**
 * Tests for Stop hook infinite session loop prevention (Issue #987)
 *
 * Verifies that:
 * 1. Summarize handler omits `continue` field from Stop hook responses
 * 2. Session-complete handler omits `continue` field from Stop hook responses
 * 3. Claude Code adapter doesn't inject `continue: true` when not set by handler
 * 4. Loop detection guard prevents rapid Stop hook re-firing
 */

import { describe, it, expect, beforeEach, mock, spyOn } from 'bun:test';

// Mock worker-utils to avoid actual network calls
mock.module('../../src/shared/worker-utils.js', () => ({
  ensureWorkerRunning: () => Promise.resolve(false),
  getWorkerPort: () => 37777,
  buildWorkerUrl: (path: string) => `http://127.0.0.1:37777${path}`,
  fetchWithTimeout: () => Promise.resolve({ ok: true }),
}));

// Mock logger to suppress output
mock.module('../../src/utils/logger.js', () => ({
  logger: {
    info: () => {},
    debug: () => {},
    warn: () => {},
    error: () => {},
    dataIn: () => {},
    formatTool: () => '',
  },
}));

// Mock transcript parser
mock.module('../../src/shared/transcript-parser.js', () => ({
  extractLastMessage: () => 'test assistant message',
}));

import { summarizeHandler, _resetLoopDetection, _getRecentStopInvocations } from '../../src/cli/handlers/summarize.js';
import { sessionCompleteHandler } from '../../src/cli/handlers/session-complete.js';
import { claudeCodeAdapter } from '../../src/cli/adapters/claude-code.js';
import type { NormalizedHookInput, HookResult } from '../../src/cli/types.js';
import { HOOK_EXIT_CODES } from '../../src/shared/hook-constants.js';

describe('Stop Hook Loop Prevention (Issue #987)', () => {
  beforeEach(() => {
    _resetLoopDetection();
  });

  describe('summarizeHandler response format', () => {
    it('should omit continue field from response', async () => {
      const input: NormalizedHookInput = {
        sessionId: 'test-session-1',
        cwd: '/test',
        transcriptPath: '/test/transcript.json',
      };

      const result = await summarizeHandler.execute(input);

      // Must have suppressOutput but NOT continue
      expect(result.suppressOutput).toBe(true);
      expect(result.continue).toBeUndefined();
    });

    it('should return SUCCESS exit code when worker is unavailable', async () => {
      const input: NormalizedHookInput = {
        sessionId: 'test-session-2',
        cwd: '/test',
      };

      const result = await summarizeHandler.execute(input);

      expect(result.exitCode).toBe(HOOK_EXIT_CODES.SUCCESS);
      expect(result.suppressOutput).toBe(true);
      expect(result.continue).toBeUndefined();
    });
  });

  describe('sessionCompleteHandler response format', () => {
    it('should omit continue field from response when sessionId missing', async () => {
      const input: NormalizedHookInput = {
        sessionId: '',
        cwd: '/test',
      };

      const result = await sessionCompleteHandler.execute(input);

      expect(result.suppressOutput).toBe(true);
      expect(result.continue).toBeUndefined();
    });

    it('should omit continue field from successful response', async () => {
      const input: NormalizedHookInput = {
        sessionId: 'test-session-3',
        cwd: '/test',
      };

      const result = await sessionCompleteHandler.execute(input);

      expect(result.suppressOutput).toBe(true);
      expect(result.continue).toBeUndefined();
    });
  });

  describe('Claude Code adapter formatting', () => {
    it('should not include continue field when handler omits it', () => {
      const result: HookResult = { suppressOutput: true };
      const output = claudeCodeAdapter.formatOutput(result) as Record<string, unknown>;

      expect(output.suppressOutput).toBe(true);
      expect('continue' in output).toBe(false);
    });

    it('should include continue field when handler explicitly sets it', () => {
      const result: HookResult = { continue: true, suppressOutput: true };
      const output = claudeCodeAdapter.formatOutput(result) as Record<string, unknown>;

      expect(output.continue).toBe(true);
      expect(output.suppressOutput).toBe(true);
    });

    it('should include continue: false when handler explicitly sets it', () => {
      const result: HookResult = { continue: false, suppressOutput: true };
      const output = claudeCodeAdapter.formatOutput(result) as Record<string, unknown>;

      expect(output.continue).toBe(false);
    });

    it('should pass through hookSpecificOutput without continue field', () => {
      const result: HookResult = {
        hookSpecificOutput: {
          hookEventName: 'SessionStart',
          additionalContext: 'test context',
        },
      };
      const output = claudeCodeAdapter.formatOutput(result) as Record<string, unknown>;

      expect(output.hookSpecificOutput).toBeDefined();
      expect('continue' in output).toBe(false);
    });
  });

  describe('loop detection guard', () => {
    it('should allow first invocation', async () => {
      const input: NormalizedHookInput = {
        sessionId: 'loop-test-1',
        cwd: '/test',
      };

      const result = await summarizeHandler.execute(input);

      // Should proceed normally (worker unavailable in mock, so returns early)
      expect(result.suppressOutput).toBe(true);
    });

    it('should allow up to MAX invocations within the window', async () => {
      const input: NormalizedHookInput = {
        sessionId: 'loop-test-2',
        cwd: '/test',
      };

      // First 3 invocations should be allowed
      for (let i = 0; i < 3; i++) {
        await summarizeHandler.execute(input);
      }

      const timestamps = _getRecentStopInvocations().get('loop-test-2');
      expect(timestamps).toBeDefined();
      expect(timestamps!.length).toBe(3);
    });

    it('should detect loop when exceeded MAX invocations', async () => {
      const input: NormalizedHookInput = {
        sessionId: 'loop-test-3',
        cwd: '/test',
      };

      // Invoke 3 times (allowed)
      for (let i = 0; i < 3; i++) {
        await summarizeHandler.execute(input);
      }

      // 4th invocation should trigger loop detection
      const result = await summarizeHandler.execute(input);

      expect(result.suppressOutput).toBe(true);
      expect(result.exitCode).toBe(HOOK_EXIT_CODES.SUCCESS);
    });

    it('should track different sessions independently', async () => {
      const input1: NormalizedHookInput = { sessionId: 'session-a', cwd: '/test' };
      const input2: NormalizedHookInput = { sessionId: 'session-b', cwd: '/test' };

      // Invoke session-a 3 times
      for (let i = 0; i < 3; i++) {
        await summarizeHandler.execute(input1);
      }

      // Session-b should still be allowed
      await summarizeHandler.execute(input2);

      const timestampsA = _getRecentStopInvocations().get('session-a');
      const timestampsB = _getRecentStopInvocations().get('session-b');

      expect(timestampsA!.length).toBe(3);
      expect(timestampsB!.length).toBe(1);
    });

    it('should reset loop detection state via _resetLoopDetection', async () => {
      const input: NormalizedHookInput = { sessionId: 'reset-test', cwd: '/test' };

      for (let i = 0; i < 3; i++) {
        await summarizeHandler.execute(input);
      }

      expect(_getRecentStopInvocations().size).toBeGreaterThan(0);

      _resetLoopDetection();

      expect(_getRecentStopInvocations().size).toBe(0);
    });

    it('should skip summarize when sessionId is present and loop detected', async () => {
      const input: NormalizedHookInput = {
        sessionId: 'loop-skip-test',
        cwd: '/test',
        transcriptPath: '/test/transcript.json',
      };

      // Invoke enough times to trigger loop detection
      for (let i = 0; i < 4; i++) {
        await summarizeHandler.execute(input);
      }

      // The 4th+ invocation returns immediately without hitting worker
      const result = await summarizeHandler.execute(input);
      expect(result.suppressOutput).toBe(true);
      expect(result.exitCode).toBe(HOOK_EXIT_CODES.SUCCESS);
    });
  });

  describe('Stop hook JSON output', () => {
    it('should produce JSON without continue field for summarize', async () => {
      const input: NormalizedHookInput = {
        sessionId: 'json-test',
        cwd: '/test',
      };

      const result = await summarizeHandler.execute(input);
      const output = claudeCodeAdapter.formatOutput(result);
      const json = JSON.stringify(output);

      // The JSON output should NOT contain "continue"
      expect(json).not.toContain('"continue"');
      expect(json).toContain('"suppressOutput"');
    });
  });
});
