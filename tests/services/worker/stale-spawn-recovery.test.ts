import { describe, it, expect, beforeEach, afterAll } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

/**
 * DATA_DIR is resolved at module import time (src/shared/paths.ts), so the
 * self-heal state file path is locked in the moment stale-spawn-recovery.ts
 * first loads. To isolate state on disk per test file we set
 * CLAUDE_MEM_DATA_DIR BEFORE the dynamic import below — any static import
 * graph that touches paths.ts would defeat this, so only node builtins are
 * statically imported here.
 */
const TMP_DIR = mkdtempSync(join(tmpdir(), 'cm-selfheal-'));
process.env.CLAUDE_MEM_DATA_DIR = TMP_DIR;

const {
  canAttemptClaudeCliSelfHeal,
  recordClaudeCliSelfHealAttempt,
  clearClaudeCliSelfHealAttempts,
  claudeCliSelfHealAttemptsInWindow,
  SELF_HEAL_MAX_ATTEMPTS,
  SELF_HEAL_WINDOW_MS,
} = await import('../../../src/services/worker/stale-spawn-recovery.js');

afterAll(() => {
  delete process.env.CLAUDE_MEM_DATA_DIR;
  rmSync(TMP_DIR, { recursive: true, force: true });
});

beforeEach(() => {
  clearClaudeCliSelfHealAttempts();
});

describe('claude CLI self-heal budget', () => {
  it('starts empty: zero attempts and canAttempt is true', () => {
    expect(claudeCliSelfHealAttemptsInWindow()).toBe(0);
    expect(canAttemptClaudeCliSelfHeal()).toBe(true);
  });

  it('records an attempt and reflects the new count', () => {
    const t0 = 1_000_000;
    expect(recordClaudeCliSelfHealAttempt(t0)).toBe(1);
    expect(claudeCliSelfHealAttemptsInWindow(t0)).toBe(1);
    expect(canAttemptClaudeCliSelfHeal(t0)).toBe(true);
  });

  it('blocks further attempts once MAX_ATTEMPTS is reached within the window', () => {
    const base = 5_000_000;
    for (let i = 0; i < SELF_HEAL_MAX_ATTEMPTS; i++) {
      recordClaudeCliSelfHealAttempt(base + i);
    }
    expect(claudeCliSelfHealAttemptsInWindow(base + SELF_HEAL_MAX_ATTEMPTS)).toBe(SELF_HEAL_MAX_ATTEMPTS);
    expect(canAttemptClaudeCliSelfHeal(base + SELF_HEAL_MAX_ATTEMPTS)).toBe(false);
  });

  it('prunes attempts older than SELF_HEAL_WINDOW_MS, reopening the budget', () => {
    const oldTs = 10_000_000;
    recordClaudeCliSelfHealAttempt(oldTs);
    // Just inside the window still counts.
    expect(claudeCliSelfHealAttemptsInWindow(oldTs + SELF_HEAL_WINDOW_MS - 1)).toBe(1);
    // One ms past the window is pruned — budget reopens.
    const after = oldTs + SELF_HEAL_WINDOW_MS + 1;
    expect(claudeCliSelfHealAttemptsInWindow(after)).toBe(0);
    expect(canAttemptClaudeCliSelfHeal(after)).toBe(true);
  });

  it('clearClaudeCliSelfHealAttempts resets the budget to zero', () => {
    const t = 20_000_000;
    for (let i = 0; i < SELF_HEAL_MAX_ATTEMPTS; i++) {
      recordClaudeCliSelfHealAttempt(t + i);
    }
    expect(canAttemptClaudeCliSelfHeal(t)).toBe(false);

    clearClaudeCliSelfHealAttempts();

    expect(claudeCliSelfHealAttemptsInWindow(t)).toBe(0);
    expect(canAttemptClaudeCliSelfHeal(t)).toBe(true);
  });

  it('prunes only stale entries, preserving in-window attempts mixed with old ones', () => {
    const old = 30_000_000;
    const recent = old + SELF_HEAL_WINDOW_MS + 5_000;
    recordClaudeCliSelfHealAttempt(old);          // stale
    recordClaudeCliSelfHealAttempt(recent);       // in-window
    recordClaudeCliSelfHealAttempt(recent + 10);  // in-window

    expect(claudeCliSelfHealAttemptsInWindow(recent + 20)).toBe(2);
    expect(canAttemptClaudeCliSelfHeal(recent + 20)).toBe(true);
  });
});
