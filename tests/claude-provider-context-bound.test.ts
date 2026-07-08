import { describe, expect, it } from 'bun:test';
import {
  ClaudeProvider,
  DEFAULT_CLAUDE_MAX_OBSERVER_TOKENS,
  computeFullContextTokens,
  observerContextExceeded,
  resolveObserverMaxTokens,
} from '../src/services/worker/ClaudeProvider.js';
import { SettingsDefaultsManager } from '../src/shared/SettingsDefaultsManager.js';

function guardWouldReset(rawSetting: string | undefined, contextTokens: number): boolean {
  const cap = resolveObserverMaxTokens({ CLAUDE_MEM_CLAUDE_MAX_TOKENS: rawSetting });
  return observerContextExceeded(contextTokens, cap);
}

describe('ClaudeProvider proactive context bound (#2957)', () => {
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
      expect(resolveObserverMaxTokens({ CLAUDE_MEM_CLAUDE_MAX_TOKENS: '50000abc' })).toBe(DEFAULT_CLAUDE_MAX_OBSERVER_TOKENS);
    });

    it('falls back to the default when the configured cap is out of range', () => {
      expect(resolveObserverMaxTokens({ CLAUDE_MEM_CLAUDE_MAX_TOKENS: '999' })).toBe(DEFAULT_CLAUDE_MAX_OBSERVER_TOKENS);
      expect(resolveObserverMaxTokens({ CLAUDE_MEM_CLAUDE_MAX_TOKENS: '1000001' })).toBe(DEFAULT_CLAUDE_MAX_OBSERVER_TOKENS);
    });
  });

  describe('threshold predicate', () => {
    it('does not trigger under or exactly at the cap', () => {
      expect(guardWouldReset(undefined, 149_999)).toBe(false);
      expect(guardWouldReset(undefined, 150_000)).toBe(false);
      expect(observerContextExceeded(150_000, 150_000)).toBe(false);
    });

    it('triggers only when context exceeds the cap', () => {
      expect(guardWouldReset(undefined, 150_001)).toBe(true);
      expect(guardWouldReset('50000', 60_000)).toBe(true);
      expect(guardWouldReset('50000', 40_000)).toBe(false);
    });
  });

  describe('full context accounting', () => {
    it('sums fresh input, cache writes, and cache reads', () => {
      expect(
        computeFullContextTokens({
          input_tokens: 1_000,
          cache_creation_input_tokens: 2_000,
          cache_read_input_tokens: 147_500,
        }),
      ).toBe(150_500);
    });

    it('treats missing usage fields and absent usage as zero', () => {
      expect(computeFullContextTokens({})).toBe(0);
      expect(computeFullContextTokens(undefined)).toBe(0);
      expect(guardWouldReset(undefined, computeFullContextTokens({}))).toBe(false);
    });
  });

  it('defaults CLAUDE_MEM_CLAUDE_MAX_TOKENS to a safe cap', () => {
    const defaults = SettingsDefaultsManager.getAllDefaults();
    expect(defaults.CLAUDE_MEM_CLAUDE_MAX_TOKENS).toBe('150000');
  });

  it('clears memorySessionId and forces fresh init on reset', () => {
    const updateCalls: Array<[number, string | null]> = [];
    const dbManager = {
      getSessionStore: () => ({
        updateMemorySessionId: (id: number, value: string | null) => {
          updateCalls.push([id, value]);
        },
      }),
    };
    const provider = new ClaudeProvider(dbManager as never, {} as never);
    const session = {
      sessionDbId: 42,
      memorySessionId: 'live-session-id',
      forceInit: false,
    };

    provider.resetSessionForFreshStart(session);

    expect(session.memorySessionId).toBeNull();
    expect(session.forceInit).toBe(true);
    expect(updateCalls).toEqual([[42, null]]);
  });
});
