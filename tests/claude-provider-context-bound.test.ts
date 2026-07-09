import { describe, it, expect } from 'bun:test';

import {
  ClaudeProvider,
  DEFAULT_CLAUDE_MAX_OBSERVER_TOKENS,
  resolveObserverMaxTokens,
  computeFullContextTokens,
  observerContextExceeded,
} from '../src/services/worker/ClaudeProvider.js';

/**
 * #2956 — the Claude provider (Agent SDK) had no cumulative context bound, so a
 * long observer session would grow until the SDK returned "Prompt is too long"
 * and aborted with zero memory saved. The fix adds a proactive bound: after each
 * turn, if the SDK-reported full context size exceeds CLAUDE_MEM_CLAUDE_MAX_TOKENS,
 * the provider resets to a fresh SDK session (clearing memorySessionId so the next
 * ingest starts small) and aborts the current generator.
 *
 * The SDK message loop is not unit-testable in isolation (it owns a live
 * subprocess), so these tests pin the two pieces of the guard's logic that we
 * own: (1) the cap-resolution + threshold predicate, and (2) the reset effect
 * applied by resetSessionForFreshStart, which the guard reuses verbatim.
 */
// Compose the exact decision the guard makes, from the same exported units it
// uses: resolve the cap from settings, then compare. Testing through these
// means a change to the guard's resolution/comparison (e.g. > vs >=) is caught.
function guardWouldReset(rawSetting: string | undefined, contextTokens: number): boolean {
  const cap = resolveObserverMaxTokens({ CLAUDE_MEM_CLAUDE_MAX_TOKENS: rawSetting });
  return observerContextExceeded(contextTokens, cap);
}

describe('ClaudeProvider proactive context bound (#2956)', () => {
  describe('cap resolution', () => {
    it('uses the default cap when the setting is unset', () => {
      expect(resolveObserverMaxTokens({})).toBe(DEFAULT_CLAUDE_MAX_OBSERVER_TOKENS);
      expect(DEFAULT_CLAUDE_MAX_OBSERVER_TOKENS).toBe(150_000);
    });

    it('honors a configured numeric cap', () => {
      expect(resolveObserverMaxTokens({ CLAUDE_MEM_CLAUDE_MAX_TOKENS: '50000' })).toBe(50_000);
    });

    it('falls back to the default for non-numeric or empty values', () => {
      expect(resolveObserverMaxTokens({ CLAUDE_MEM_CLAUDE_MAX_TOKENS: '' })).toBe(DEFAULT_CLAUDE_MAX_OBSERVER_TOKENS);
      expect(resolveObserverMaxTokens({ CLAUDE_MEM_CLAUDE_MAX_TOKENS: 'nope' })).toBe(DEFAULT_CLAUDE_MAX_OBSERVER_TOKENS);
    });
  });

  describe('threshold predicate', () => {
    it('does NOT trigger when context is under the default cap', () => {
      expect(guardWouldReset(undefined, 149_999)).toBe(false);
    });

    it('triggers when context exceeds the default cap', () => {
      expect(guardWouldReset(undefined, 150_001)).toBe(true);
    });

    it('does NOT trigger exactly at the cap (strict greater-than)', () => {
      expect(observerContextExceeded(150_000, 150_000)).toBe(false);
      expect(guardWouldReset(undefined, 150_000)).toBe(false);
    });

    it('honors a configured cap', () => {
      expect(guardWouldReset('50000', 60_000)).toBe(true);
      expect(guardWouldReset('50000', 40_000)).toBe(false);
    });

    it('falls back to the default cap when the setting is non-numeric or empty', () => {
      expect(guardWouldReset('', 160_000)).toBe(true);
      expect(guardWouldReset('not-a-number', 160_000)).toBe(true);
      expect(guardWouldReset('', 100_000)).toBe(false);
    });
  });

  describe('full context size accounting', () => {
    it('sums fresh input, cache writes, and cache reads', () => {
      expect(
        computeFullContextTokens({
          input_tokens: 1_000,
          cache_creation_input_tokens: 2_000,
          cache_read_input_tokens: 147_500,
        })
      ).toBe(150_500);
    });

    it('treats missing usage fields and absent usage as zero (no false trigger)', () => {
      expect(computeFullContextTokens({})).toBe(0);
      expect(computeFullContextTokens(undefined)).toBe(0);
      expect(guardWouldReset(undefined, computeFullContextTokens({}))).toBe(false);
    });
  });

  describe('resetSessionForFreshStart effect (reused by the guard)', () => {
    function makeProvider() {
      const updateCalls: Array<[number, string | null]> = [];
      const dbManager = {
        getSessionStore: () => ({
          updateMemorySessionId: (id: number, value: string | null) => {
            updateCalls.push([id, value]);
          },
        }),
      };
      const sessionManager = {};
      const provider = new ClaudeProvider(dbManager as never, sessionManager as never);
      return { provider, updateCalls };
    }

    it('clears memorySessionId and forces a fresh init so the next ingest starts small', () => {
      const { provider, updateCalls } = makeProvider();
      const session = {
        sessionDbId: 42,
        memorySessionId: 'live-session-id',
        forceInit: false,
      };

      (provider as unknown as { resetSessionForFreshStart: (s: typeof session) => void })
        .resetSessionForFreshStart(session);

      expect(session.memorySessionId).toBeNull();
      expect(session.forceInit).toBe(true);
      expect(updateCalls).toEqual([[42, null]]);
    });
  });
});
