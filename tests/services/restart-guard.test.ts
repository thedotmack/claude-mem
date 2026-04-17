import { describe, it, expect } from 'bun:test';
import {
  recordRestart,
  resetRestarts,
  getRecentRestartCount,
  RESTART_WINDOW_MS,
  MAX_RESTARTS_IN_WINDOW,
  type RestartTracker,
} from '../../src/services/worker/RestartGuard.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTracker(): RestartTracker {
  return { restartTimestamps: [], consecutiveRestarts: 0 };
}

// ---------------------------------------------------------------------------
// recordRestart
// ---------------------------------------------------------------------------

describe('RestartGuard — recordRestart', () => {
  it('allows restarts up to the window limit', () => {
    const t = makeTracker();
    const now = 1_000_000;

    for (let i = 0; i < MAX_RESTARTS_IN_WINDOW; i++) {
      expect(recordRestart(t, now + i)).toBe(true);
    }
    // One more should be blocked
    expect(recordRestart(t, now + MAX_RESTARTS_IN_WINDOW)).toBe(false);
  });

  it('blocks restarts beyond the limit within the same window', () => {
    const t = makeTracker();
    const now = 1_000_000;

    // Fill up to limit
    for (let i = 0; i <= MAX_RESTARTS_IN_WINDOW; i++) {
      recordRestart(t, now + i);
    }
    // consecutiveRestarts should reflect windowed count
    expect(t.consecutiveRestarts).toBe(MAX_RESTARTS_IN_WINDOW + 1);
    expect(recordRestart(t, now + MAX_RESTARTS_IN_WINDOW + 1)).toBe(false);
  });

  it('allows restarts once old timestamps expire from the window', () => {
    const t = makeTracker();
    const now = 1_000_000;

    // Fire restarts right at the limit
    for (let i = 0; i < MAX_RESTARTS_IN_WINDOW; i++) {
      recordRestart(t, now + i);
    }

    // Next one in the same window is blocked
    expect(recordRestart(t, now + 100)).toBe(false);

    // Jump forward past the window — all old timestamps should be pruned
    // Need to exceed RESTART_WINDOW_MS from the latest timestamp (now + 100)
    const future = now + RESTART_WINDOW_MS + 200;
    expect(recordRestart(t, future)).toBe(true);
    expect(t.consecutiveRestarts).toBe(1); // only the new one remains
  });

  it('prunes timestamps older than the window on each call', () => {
    const t = makeTracker();
    const now = 1_000_000;

    recordRestart(t, now);
    recordRestart(t, now + 1_000);
    expect(t.restartTimestamps.length).toBe(2);

    // Jump past the window — both old timestamps should be pruned
    const future = now + RESTART_WINDOW_MS + 2_000;
    recordRestart(t, future);
    expect(t.restartTimestamps.length).toBe(1);
    expect(t.restartTimestamps[0]).toBe(future);
  });

  it('keeps consecutiveRestarts in sync with windowed count', () => {
    const t = makeTracker();
    const now = 1_000_000;

    recordRestart(t, now);
    expect(t.consecutiveRestarts).toBe(1);

    recordRestart(t, now + 500);
    expect(t.consecutiveRestarts).toBe(2);

    // After window expires, counter should reset to just the new entry
    // Need to exceed RESTART_WINDOW_MS from the latest timestamp (now + 500)
    recordRestart(t, now + RESTART_WINDOW_MS + 1_000);
    expect(t.consecutiveRestarts).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// resetRestarts
// ---------------------------------------------------------------------------

describe('RestartGuard — resetRestarts', () => {
  it('clears all timestamps and counter', () => {
    const t = makeTracker();
    recordRestart(t);
    recordRestart(t);
    expect(t.restartTimestamps.length).toBe(2);
    expect(t.consecutiveRestarts).toBe(2);

    resetRestarts(t);
    expect(t.restartTimestamps.length).toBe(0);
    expect(t.consecutiveRestarts).toBe(0);
  });

  it('is idempotent', () => {
    const t = makeTracker();
    resetRestarts(t);
    resetRestarts(t);
    expect(t.restartTimestamps.length).toBe(0);
    expect(t.consecutiveRestarts).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// getRecentRestartCount
// ---------------------------------------------------------------------------

describe('RestartGuard — getRecentRestartCount', () => {
  it('returns zero for a fresh tracker', () => {
    const t = makeTracker();
    expect(getRecentRestartCount(t)).toBe(0);
  });

  it('counts only timestamps within the window', () => {
    const t = makeTracker();
    const now = 1_000_000;

    // Two old, one recent
    t.restartTimestamps = [
      now - RESTART_WINDOW_MS - 100,
      now - RESTART_WINDOW_MS - 50,
      now - 500,
    ];

    expect(getRecentRestartCount(t, now)).toBe(1);
  });

  it('does not mutate the tracker', () => {
    const t = makeTracker();
    t.restartTimestamps = [Date.now() - RESTART_WINDOW_MS - 100, Date.now()];
    const before = [...t.restartTimestamps];
    getRecentRestartCount(t);
    expect(t.restartTimestamps).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// Acceptance criteria
// ---------------------------------------------------------------------------

describe('RestartGuard — acceptance criteria', () => {
  it('a session that restarts a few times per hour is NOT terminated', () => {
    const t = makeTracker();

    // Simulate: 3 restarts spread across 2 hours (one every 40 minutes)
    let now = 1_000_000;
    expect(recordRestart(t, now)).toBe(true);

    now += 40 * 60_000; // +40 min
    expect(recordRestart(t, now)).toBe(true);
    expect(t.consecutiveRestarts).toBe(1); // previous one expired

    now += 40 * 60_000; // +40 min
    expect(recordRestart(t, now)).toBe(true);
    expect(t.consecutiveRestarts).toBe(1);
  });

  it('a tight crash-loop trips the guard within seconds', () => {
    const t = makeTracker();
    const now = 1_000_000;

    // Simulate: 6 immediate restarts, 1 second apart
    let blocked = false;
    for (let i = 0; i < 10; i++) {
      if (!recordRestart(t, now + i * 1_000)) {
        blocked = true;
        break;
      }
    }
    expect(blocked).toBe(true);
    // Should have blocked at attempt MAX_RESTARTS_IN_WINDOW + 1
    expect(t.consecutiveRestarts).toBe(MAX_RESTARTS_IN_WINDOW + 1);
  });

  it('restarts that happened within a short window are counted together', () => {
    const t = makeTracker();
    const now = 1_000_000;

    // 4 restarts in 10 seconds — below MAX but clustered
    for (let i = 0; i < 4; i++) {
      recordRestart(t, now + i * 2_500);
    }
    expect(t.consecutiveRestarts).toBe(4);

    // 5th is still within window and at the limit
    expect(recordRestart(t, now + 12_000)).toBe(true);
    expect(t.consecutiveRestarts).toBe(5);

    // 6th trips it
    expect(recordRestart(t, now + 15_000)).toBe(false);
  });

  it('guard resets naturally as time passes without needing clean completion', () => {
    const t = makeTracker();
    const now = 1_000_000;

    // Hit the limit
    for (let i = 0; i <= MAX_RESTARTS_IN_WINDOW; i++) {
      recordRestart(t, now + i);
    }
    // Guard is tripped
    expect(t.consecutiveRestarts).toBe(MAX_RESTARTS_IN_WINDOW + 1);

    // Wait for the window to expire
    const future = now + RESTART_WINDOW_MS + 100;
    const allowed = recordRestart(t, future);
    expect(allowed).toBe(true);
    expect(t.consecutiveRestarts).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Constants sanity checks
// ---------------------------------------------------------------------------

describe('RestartGuard — constants', () => {
  it('window is 60 seconds', () => {
    expect(RESTART_WINDOW_MS).toBe(60_000);
  });

  it('max restarts in window is 5', () => {
    expect(MAX_RESTARTS_IN_WINDOW).toBe(5);
  });
});
