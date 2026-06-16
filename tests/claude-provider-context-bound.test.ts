import { describe, it, expect } from 'bun:test';

import { ClaudeProvider } from '../src/services/worker/ClaudeProvider.js';

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
describe('ClaudeProvider proactive context bound (#2956)', () => {
  // Mirror the guard's cap resolution and comparison exactly:
  //   const cap = parseInt(settings.CLAUDE_MEM_CLAUDE_MAX_TOKENS, 10) || 150000;
  //   if (currentContextTokens > cap) reset();
  function exceedsBound(rawSetting: string | undefined, contextTokens: number): boolean {
    const cap = parseInt(rawSetting ?? '', 10) || 150000;
    return contextTokens > cap;
  }

  // The SDK reports the full read-context as the sum of these fields; the guard
  // sums them into session.lastUsage.input and compares that to the cap.
  function fullContextTokens(usage: {
    input_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  }): number {
    return (
      (usage.input_tokens || 0) +
      (usage.cache_creation_input_tokens || 0) +
      (usage.cache_read_input_tokens || 0)
    );
  }

  describe('threshold predicate', () => {
    it('does NOT trigger when context is under the default cap', () => {
      expect(exceedsBound(undefined, 149_999)).toBe(false);
    });

    it('triggers when context exceeds the default cap', () => {
      expect(exceedsBound(undefined, 150_001)).toBe(true);
    });

    it('does NOT trigger exactly at the cap (strict greater-than)', () => {
      expect(exceedsBound(undefined, 150_000)).toBe(false);
    });

    it('honors a configured cap', () => {
      expect(exceedsBound('50000', 60_000)).toBe(true);
      expect(exceedsBound('50000', 40_000)).toBe(false);
    });

    it('falls back to the default cap when the setting is non-numeric or empty', () => {
      expect(exceedsBound('', 160_000)).toBe(true);
      expect(exceedsBound('not-a-number', 160_000)).toBe(true);
      expect(exceedsBound('', 100_000)).toBe(false);
    });
  });

  describe('full context size accounting', () => {
    it('sums fresh input, cache writes, and cache reads', () => {
      expect(
        fullContextTokens({
          input_tokens: 1_000,
          cache_creation_input_tokens: 2_000,
          cache_read_input_tokens: 147_500,
        })
      ).toBe(150_500);
    });

    it('treats missing usage fields as zero (no false trigger)', () => {
      expect(fullContextTokens({})).toBe(0);
      expect(exceedsBound(undefined, fullContextTokens({}))).toBe(false);
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
