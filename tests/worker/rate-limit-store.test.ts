import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'fs';
import {
  RateLimitStore,
  shouldAbortForQuota,
  isApiKeyAuth,
  isNewRejection,
  extractRateLimitInfo,
  minutesUntilReset,
  buildUsageLimitHitProps,
  explainQuotaAbort,
  type RateLimitInfo,
  type RateLimitWindow,
} from '../../src/services/worker/RateLimitStore.js';
import { USER_SETTINGS_PATH } from '../../src/shared/paths.js';
import { logger } from '../../src/utils/logger.js';

// Quota-aware wall-clock guard (#2234).
//
// Subscription users (cli/oauth) get aborted when they cross per-window
// utilization thresholds, plus a reset-grace buffer for the rolling 5h
// window. API-key users are exempt because they authorized per-call spend.

const FIXED_NOW = 1_700_000_000_000; // arbitrary epoch ms anchor

function freshStore(): RateLimitStore {
  return new RateLimitStore();
}

describe('RateLimitStore', () => {
  it('records and retrieves entries by rateLimitType', () => {
    const store = freshStore();
    store.set({ rateLimitType: 'five_hour', utilization: 0.5, status: 'allowed' });
    const got = store.get('five_hour');
    expect(got?.utilization).toBe(0.5);
    expect(got?.status).toBe('allowed');
    expect(typeof got?.observedAt).toBe('number');
  });

  it('overwrites older entries for the same window (last-write-wins)', () => {
    const store = freshStore();
    store.set({ rateLimitType: 'five_hour', utilization: 0.5 });
    store.set({ rateLimitType: 'five_hour', utilization: 0.9 });
    expect(store.get('five_hour')?.utilization).toBe(0.9);
  });

  it('keeps separate buckets per window', () => {
    const store = freshStore();
    store.set({ rateLimitType: 'five_hour', utilization: 0.4 });
    store.set({ rateLimitType: 'seven_day_opus', utilization: 0.7 });
    expect(store.get('five_hour')?.utilization).toBe(0.4);
    expect(store.get('seven_day_opus')?.utilization).toBe(0.7);
    expect(store.size).toBe(2);
  });

  it('falls back to "default" bucket when rateLimitType is missing', () => {
    const store = freshStore();
    store.set({ utilization: 0.6 } as RateLimitInfo);
    expect(store.get(undefined)?.utilization).toBe(0.6);
  });

  it('ignores null/undefined input', () => {
    const store = freshStore();
    store.set(null as any);
    store.set(undefined as any);
    expect(store.size).toBe(0);
  });

  it('getMostRecentByWindow returns latest snapshots keyed by window', () => {
    const store = freshStore();
    store.set({ rateLimitType: 'five_hour', utilization: 0.1 });
    store.set({ rateLimitType: 'seven_day_sonnet', utilization: 0.2 });
    store.set({ rateLimitType: 'seven_day_opus', utilization: 0.3 });
    const snap = store.getMostRecentByWindow();
    expect(snap.five_hour?.utilization).toBe(0.1);
    expect(snap.seven_day_sonnet?.utilization).toBe(0.2);
    expect(snap.seven_day_opus?.utilization).toBe(0.3);
    expect(snap.seven_day).toBeUndefined();
  });

  it('getMostRecentByWindow flags a window whose reset has passed instead of showing it as live', () => {
    const store = freshStore();
    store.set({ rateLimitType: 'seven_day', utilization: 0.93, resetsAt: Math.floor(FIXED_NOW / 1000) - 60 });
    store.set({ rateLimitType: 'five_hour', utilization: 0.4, resetsAt: FIXED_NOW + 60_000 });
    store.set({ rateLimitType: 'seven_day_opus', utilization: 0.5 });

    const snap = store.getMostRecentByWindow(FIXED_NOW);
    expect(snap.seven_day?.expired).toBe(true);
    expect(snap.seven_day?.utilization).toBe(0.93); // last reading stays visible, marked as dead
    expect(snap.five_hour?.expired).toBeUndefined();
    expect(snap.seven_day_opus?.expired).toBeUndefined(); // no reset: cannot tell, not flagged
    // The stored entry stays raw: set()'s rejection de-dupe still sees it.
    expect(store.get('seven_day')).not.toHaveProperty('expired');
  });
});

describe('isApiKeyAuth', () => {
  it('matches verbose getAuthMethodDescription() output', () => {
    expect(isApiKeyAuth('API key (from ~/.claude-mem/.env)')).toBe(true);
    expect(isApiKeyAuth('Claude Code OAuth token (read from system keychain at spawn)')).toBe(false);
  });

  it('matches concise tokens', () => {
    expect(isApiKeyAuth('api_key')).toBe(true);
    expect(isApiKeyAuth('cli')).toBe(false);
    expect(isApiKeyAuth('')).toBe(false);
  });
});

describe('shouldAbortForQuota — api_key auth', () => {
  let store: RateLimitStore;
  beforeEach(() => {
    store = freshStore();
  });

  it('never aborts even at five_hour utilization 0.99', () => {
    store.set({ rateLimitType: 'five_hour', utilization: 0.99, status: 'allowed_warning' });
    const decision = shouldAbortForQuota('api_key', store, FIXED_NOW);
    expect(decision.abort).toBe(false);
  });

  it('never aborts even at seven_day_opus 0.99', () => {
    store.set({ rateLimitType: 'seven_day_opus', utilization: 0.99 });
    const decision = shouldAbortForQuota('API key (from ~/.claude-mem/.env)', store, FIXED_NOW);
    expect(decision.abort).toBe(false);
  });

  it('never aborts when reset is imminent', () => {
    store.set({
      rateLimitType: 'five_hour',
      utilization: 0.92,
      resetsAt: FIXED_NOW + 60_000, // 1 min away
    });
    const decision = shouldAbortForQuota('api_key', store, FIXED_NOW);
    expect(decision.abort).toBe(false);
  });
});

describe('shouldAbortForQuota — cli/oauth auth', () => {
  const cliAuth = 'Claude Code OAuth token (read from system keychain at spawn)';
  let store: RateLimitStore;
  beforeEach(() => {
    store = freshStore();
  });

  // seven_day_overage_included is Claude Code's per-model "Fable limit". The CLI
  // reports its figure on every response of an account that has the bucket,
  // whatever model the request used, and a figure above 1 is usage that
  // legitimately ran past the cap. A Haiku observer does not draw on it (#4132).
  it('does not pause on the overage-included figure another model spent', () => {
    store.set({
      rateLimitType: 'five_hour',
      status: 'allowed',
      utilization: 0.1,
      resetsAt: FIXED_NOW + 2 * 60 * 60 * 1000,
      unifiedWindows: {
        seven_day_overage_included: { utilization: 0.94, resetsAt: FIXED_NOW + 5 * 24 * 60 * 60 * 1000 },
      },
    });
    expect(store.get('seven_day_overage_included')).toBeUndefined();
    expect(store.getMostRecentByWindow().seven_day_overage_included).toBeUndefined();
    expect(shouldAbortForQuota(cliAuth, store, FIXED_NOW)).toEqual({ abort: false });
  });

  it('does not pause on an overage-included warning, even past the cap', () => {
    // The CLI derives this warning from the bucket's surpassed-threshold
    // header, which carries no model scope: a Haiku response can bring it.
    store.set({
      rateLimitType: 'seven_day_overage_included',
      status: 'allowed_warning',
      utilization: 1.2,
      surpassedThreshold: 1,
      resetsAt: FIXED_NOW + 24 * 60 * 60 * 1000,
    });
    expect(store.getMostRecentByWindow().seven_day_overage_included?.utilization).toBe(1.2);
    expect(shouldAbortForQuota(cliAuth, store, FIXED_NOW)).toEqual({ abort: false });
  });

  it('aborts on a rejected overage-included weekly window', () => {
    store.set({
      rateLimitType: 'seven_day_overage_included',
      status: 'rejected',
      resetsAt: FIXED_NOW + 24 * 60 * 60 * 1000,
    });
    const decision = shouldAbortForQuota(cliAuth, store, FIXED_NOW);
    expect(decision.abort).toBe(true);
    expect(decision.window).toBe('seven_day_overage_included');
  });

  it('does not abort on inactive overage at 100% utilization', () => {
    store.set({
      rateLimitType: 'overage',
      utilization: 1,
      isUsingOverage: false,
      status: 'allowed_warning',
    });
    const decision = shouldAbortForQuota(cliAuth, store, FIXED_NOW);
    expect(decision.abort).toBe(false);
  });

  it('aborts on active overage above the utilization threshold', () => {
    store.set({
      rateLimitType: 'overage',
      utilization: 0.96,
      isUsingOverage: true,
      status: 'allowed_warning',
    });
    const decision = shouldAbortForQuota(cliAuth, store, FIXED_NOW);
    expect(decision.abort).toBe(true);
    expect(decision.window).toBe('overage');
  });

  it('preserves overage utilization behavior when isUsingOverage is missing', () => {
    store.set({
      rateLimitType: 'overage',
      utilization: 0.96,
      status: 'allowed_warning',
    });
    const decision = shouldAbortForQuota(cliAuth, store, FIXED_NOW);
    expect(decision.abort).toBe(true);
    expect(decision.window).toBe('overage');
  });

  it('aborts when inactive overage is rejected by overageStatus', () => {
    store.set({
      rateLimitType: 'overage',
      utilization: 0,
      isUsingOverage: false,
      status: 'allowed_warning',
      overageStatus: 'rejected',
    });
    const decision = shouldAbortForQuota(cliAuth, store, FIXED_NOW);
    expect(decision.abort).toBe(true);
    expect(decision.window).toBe('overage');
  });

  it('aborts when inactive overage is rejected by status', () => {
    store.set({
      rateLimitType: 'overage',
      utilization: 0,
      isUsingOverage: false,
      status: 'rejected',
    });
    const decision = shouldAbortForQuota(cliAuth, store, FIXED_NOW);
    expect(decision.abort).toBe(true);
    expect(decision.window).toBe('overage');
  });

  it('does not abort on a five_hour rejection after its reset time', () => {
    store.set({
      rateLimitType: 'five_hour',
      status: 'rejected',
      utilization: 1,
      resetsAt: Math.floor(FIXED_NOW / 1000) - 60, // epoch seconds, already reset
    });
    const decision = shouldAbortForQuota(cliAuth, store, FIXED_NOW);
    expect(decision.abort).toBe(false);
  });

  it('still aborts on a five_hour rejection before its reset time', () => {
    store.set({
      rateLimitType: 'five_hour',
      status: 'rejected',
      resetsAt: FIXED_NOW + 60_000,
    });
    const decision = shouldAbortForQuota(cliAuth, store, FIXED_NOW);
    expect(decision).toMatchObject({
      abort: true,
      window: 'five_hour',
      reason: 'quota:five_hour rejected by provider',
    });
  });

  it('still aborts on a rejected entry with no reset time', () => {
    store.set({ rateLimitType: 'five_hour', status: 'rejected' });
    const decision = shouldAbortForQuota(cliAuth, store, FIXED_NOW);
    expect(decision).toMatchObject({
      abort: true,
      window: 'five_hour',
      reason: 'quota:five_hour rejected by provider',
    });
  });

  it('still aborts on a snapshot with no resetsAt (cannot tell it is stale)', () => {
    store.set({ rateLimitType: 'seven_day', utilization: 0.98 });
    expect(shouldAbortForQuota(cliAuth, store, FIXED_NOW).abort).toBe(true);
  });

  it('does not re-abort a later allowed window because an earlier rejection expired', () => {
    store.set({
      rateLimitType: 'five_hour',
      status: 'rejected',
      resetsAt: FIXED_NOW - 60_000,
    });
    store.set({
      rateLimitType: 'seven_day',
      status: 'allowed',
      utilization: 0.79,
    });
    const decision = shouldAbortForQuota(cliAuth, store, FIXED_NOW);
    expect(decision.abort).toBe(false);
  });

  it('aborts on five_hour at 0.96 with reason mentioning "five_hour"', () => {
    store.set({ rateLimitType: 'five_hour', utilization: 0.96 });
    const decision = shouldAbortForQuota(cliAuth, store, FIXED_NOW);
    expect(decision.abort).toBe(true);
    expect(decision.window).toBe('five_hour');
    expect(decision.reason).toContain('five_hour');
  });

  it('does not abort on five_hour at 0.94 (below 0.95 threshold, no reset pressure)', () => {
    store.set({
      rateLimitType: 'five_hour',
      utilization: 0.94,
      resetsAt: FIXED_NOW + 60 * 60 * 1000, // 1h away
    });
    const decision = shouldAbortForQuota(cliAuth, store, FIXED_NOW);
    expect(decision.abort).toBe(false);
  });

  it('aborts on seven_day_opus at 0.94 (>= 0.93 threshold)', () => {
    store.set({ rateLimitType: 'seven_day_opus', utilization: 0.94 });
    const decision = shouldAbortForQuota(cliAuth, store, FIXED_NOW);
    expect(decision.abort).toBe(true);
    expect(decision.window).toBe('seven_day_opus');
  });

  it('aborts on seven_day_sonnet at 0.93 (>= 0.92 threshold)', () => {
    store.set({ rateLimitType: 'seven_day_sonnet', utilization: 0.93 });
    const decision = shouldAbortForQuota(cliAuth, store, FIXED_NOW);
    expect(decision.abort).toBe(true);
    expect(decision.window).toBe('seven_day_sonnet');
  });

  it('aborts on five_hour at 0.90 with resetsAt 10 min away (grace buffer)', () => {
    store.set({
      rateLimitType: 'five_hour',
      utilization: 0.90,
      resetsAt: FIXED_NOW + 10 * 60 * 1000, // 10 min
    });
    const decision = shouldAbortForQuota(cliAuth, store, FIXED_NOW);
    expect(decision.abort).toBe(true);
    expect(decision.window).toBe('five_hour');
    expect(decision.reason).toContain('resets');
  });

  it('does not abort on five_hour at 0.90 with resetsAt 30 min away (outside grace)', () => {
    store.set({
      rateLimitType: 'five_hour',
      utilization: 0.90,
      resetsAt: FIXED_NOW + 30 * 60 * 1000, // 30 min
    });
    const decision = shouldAbortForQuota(cliAuth, store, FIXED_NOW);
    expect(decision.abort).toBe(false);
  });

  it('aborts on five_hour at 0.90 with resetsAt reported in epoch seconds, 10 min away (grace buffer)', () => {
    // Claude Code has been observed writing resetsAt in epoch seconds
    // (see the doc comment on minutesUntilReset). The grace-buffer check
    // must normalize units the same way minutesUntilReset does.
    store.set({
      rateLimitType: 'five_hour',
      utilization: 0.90,
      resetsAt: Math.floor((FIXED_NOW + 10 * 60 * 1000) / 1000), // 10 min away, epoch seconds
    });
    const decision = shouldAbortForQuota(cliAuth, store, FIXED_NOW);
    expect(decision.abort).toBe(true);
    expect(decision.window).toBe('five_hour');
    expect(decision.reason).toContain('resets');
  });

  it('does not abort when all windows are below threshold', () => {
    store.set({ rateLimitType: 'five_hour', utilization: 0.5 });
    store.set({ rateLimitType: 'seven_day_opus', utilization: 0.4 });
    store.set({ rateLimitType: 'seven_day_sonnet', utilization: 0.3 });
    const decision = shouldAbortForQuota(cliAuth, store, FIXED_NOW);
    expect(decision.abort).toBe(false);
  });

  it('skips reset-grace check when utilization is below the floor', () => {
    // resetsAt within grace window but util well below the 0.85 floor —
    // no point aborting on a window that just reset.
    store.set({
      rateLimitType: 'five_hour',
      utilization: 0.10,
      resetsAt: FIXED_NOW + 5 * 60 * 1000,
    });
    const decision = shouldAbortForQuota(cliAuth, store, FIXED_NOW);
    expect(decision.abort).toBe(false);
  });

  it('reports the first matching window when multiple are over threshold', () => {
    store.set({ rateLimitType: 'five_hour', utilization: 0.99 });
    store.set({ rateLimitType: 'seven_day_opus', utilization: 0.99 });
    const decision = shouldAbortForQuota(cliAuth, store, FIXED_NOW);
    expect(decision.abort).toBe(true);
    // five_hour is checked first per the iteration order.
    expect(decision.window).toBe('five_hour');
  });

  it('does not abort with empty store', () => {
    const decision = shouldAbortForQuota(cliAuth, store, FIXED_NOW);
    expect(decision.abort).toBe(false);
  });

  // The decision says what kind of stop it is (HAR-1103): the provider's own
  // refusal (`quota_exhausted`) or claude-mem's precautionary guard
  // (`quota_guard`). The ledger renders the two differently, so the guard must
  // never be booked as a spent allowance, and a refusal must never be hidden
  // behind an earlier window's precaution.
  it('still reports a provider rejection below the weekly reserve threshold as exhausted', () => {
    store.set({ rateLimitType: 'seven_day', utilization: 0.5, status: 'rejected' });
    const decision = shouldAbortForQuota(cliAuth, store, FIXED_NOW);
    expect(decision.abort).toBe(true);
    expect(decision.pause?.kind).toBe('quota_exhausted');
    expect(decision.pause?.message).toContain('rejected');
    expect(decision.pause?.message).not.toContain('pause threshold');
  });

  it('prioritizes a confirmed weekly rejection over a five-hour precautionary guard', () => {
    store.set({ rateLimitType: 'five_hour', utilization: 0.96 });
    store.set({ rateLimitType: 'seven_day', status: 'rejected' });
    const decision = shouldAbortForQuota(cliAuth, store, FIXED_NOW);
    expect(decision.window).toBe('seven_day');
    expect(decision.pause?.kind).toBe('quota_exhausted');
  });

  it('reports the five-hour reset buffer as a precautionary pause', () => {
    store.set({ rateLimitType: 'five_hour', utilization: 0.9, resetsAt: FIXED_NOW + 600_000 });
    const decision = shouldAbortForQuota(cliAuth, store, FIXED_NOW);
    expect(decision.pause?.kind).toBe('quota_guard');
    expect(decision.pause?.message).toContain('10 minutes');
    expect(decision.pause?.message).not.toContain('exhausted');
  });

  it('reports a threshold stop as a precautionary pause that names the window and the threshold', () => {
    store.set({ rateLimitType: 'five_hour', utilization: 0.96 });
    const decision = shouldAbortForQuota(cliAuth, store, FIXED_NOW);
    expect(decision.pause?.kind).toBe('quota_guard');
    expect(decision.pause?.message).toContain('five-hour Claude usage is 96.0%');
    expect(decision.pause?.message).toContain('95% pause threshold');
    expect(decision.pause?.message).not.toContain('exhausted');
  });
});

// Quota is per Claude account. CLAUDE_MEM_CLAUDE_CONFIG_DIR can move the
// observer to another account between spawns, so a snapshot recorded while
// billing one profile must not abort a generator billing another.
describe('shouldAbortForQuota — per-account profile scoping', () => {
  const cliAuth = 'Claude Code OAuth token (read from system keychain at spawn) profile=personal';

  it('stores the profile a snapshot was recorded under', () => {
    const store = freshStore();
    store.set({ rateLimitType: 'seven_day', utilization: 0.97, profile: 'work' });
    expect(store.get('seven_day')?.profile).toBe('work');
  });

  it('does not abort on a snapshot recorded under another profile', () => {
    const store = freshStore();
    store.set({ rateLimitType: 'seven_day', utilization: 0.97, resetsAt: FIXED_NOW + 86_400_000, profile: 'work' });
    expect(shouldAbortForQuota(cliAuth, store, FIXED_NOW, 'personal').abort).toBe(false);
  });

  it('does not abort on another profile\'s provider rejection', () => {
    const store = freshStore();
    store.set({ rateLimitType: 'five_hour', status: 'rejected', resetsAt: FIXED_NOW + 60_000, profile: 'work' });
    expect(shouldAbortForQuota(cliAuth, store, FIXED_NOW, 'personal').abort).toBe(false);
  });

  it('still aborts on a snapshot recorded under the same profile', () => {
    const store = freshStore();
    store.set({ rateLimitType: 'seven_day', utilization: 0.97, resetsAt: FIXED_NOW + 86_400_000, profile: 'work' });
    const decision = shouldAbortForQuota(cliAuth, store, FIXED_NOW, 'work');
    expect(decision.abort).toBe(true);
    expect(decision.window).toBe('seven_day');
  });

  it('still checks the current profile\'s windows when another profile\'s are skipped', () => {
    const store = freshStore();
    store.set({ rateLimitType: 'five_hour', utilization: 0.99, profile: 'work' });
    store.set({ rateLimitType: 'seven_day', utilization: 0.95, profile: 'personal' });
    const decision = shouldAbortForQuota(cliAuth, store, FIXED_NOW, 'personal');
    expect(decision.abort).toBe(true);
    expect(decision.window).toBe('seven_day');
  });

  it('applies an untagged snapshot to every profile, and every snapshot when no profile is given', () => {
    const store = freshStore();
    store.set({ rateLimitType: 'seven_day', utilization: 0.97 });
    expect(shouldAbortForQuota(cliAuth, store, FIXED_NOW, 'personal').abort).toBe(true);

    const tagged = freshStore();
    tagged.set({ rateLimitType: 'seven_day', utilization: 0.97, profile: 'work' });
    expect(shouldAbortForQuota(cliAuth, tagged, FIXED_NOW).abort).toBe(true);
  });

  it('tags unifiedWindows siblings with the profile of the event that carried them', () => {
    const store = freshStore();
    store.set({
      rateLimitType: 'five_hour',
      status: 'allowed',
      profile: 'work',
      unifiedWindows: { seven_day: { utilization: 0.97, resetsAt: FIXED_NOW + 86_400_000 } },
    });
    expect(store.get('seven_day')?.profile).toBe('work');
    expect(shouldAbortForQuota(cliAuth, store, FIXED_NOW, 'personal').abort).toBe(false);
    expect(shouldAbortForQuota(cliAuth, store, FIXED_NOW, 'work').abort).toBe(true);
  });

  it('does not carry another profile\'s rejection or reset into a sibling refresh', () => {
    const store = freshStore();
    const now = Date.now();
    const workReset = now + 60_000;
    store.set({ rateLimitType: 'seven_day', status: 'rejected', resetsAt: workReset, profile: 'work' });

    // Account B reports the same reset-only sibling: nothing of A's carries.
    store.set({
      rateLimitType: 'five_hour',
      status: 'allowed',
      profile: 'personal',
      unifiedWindows: { seven_day: { resetsAt: workReset } },
    });
    expect(store.get('seven_day')?.status).toBeUndefined();
    expect(store.get('seven_day')?.profile).toBe('personal');

    // Nor does a utilization-only sibling inherit the other account's reset.
    store.set({
      rateLimitType: 'five_hour',
      status: 'allowed',
      profile: 'work',
      unifiedWindows: { seven_day: { utilization: 0.2 } },
    });
    expect(store.get('seven_day')?.resetsAt).toBeUndefined();
  });
});

// Configurable thresholds (#4230). Settings are read through the env override
// here, except for the settings.json case; the data dir is pinned to a temp
// dir by tests/preload.ts.
describe('shouldAbortForQuota — configurable thresholds', () => {
  const cliAuth = 'Claude Code OAuth token (read from system keychain at spawn)';
  const THRESHOLD_KEYS = [
    'CLAUDE_MEM_QUOTA_THRESHOLD_FIVE_HOUR',
    'CLAUDE_MEM_QUOTA_THRESHOLD_SEVEN_DAY',
    'CLAUDE_MEM_QUOTA_THRESHOLD_SEVEN_DAY_OPUS',
    'CLAUDE_MEM_QUOTA_THRESHOLD_SEVEN_DAY_SONNET',
    'CLAUDE_MEM_QUOTA_THRESHOLD_OVERAGE',
  ];
  let savedEnv: Record<string, string | undefined>;
  beforeEach(() => {
    savedEnv = {};
    for (const key of THRESHOLD_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });
  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  function storeAt(window: RateLimitWindow, utilization: number, status: RateLimitInfo['status'] = 'allowed'): RateLimitStore {
    const store = freshStore();
    store.set({ rateLimitType: window, status, utilization, resetsAt: FIXED_NOW + 2 * 24 * 60 * 60 * 1000 });
    return store;
  }

  it('defaults behave exactly like the previous constants', () => {
    const previous: Array<[RateLimitWindow, number]> = [
      ['five_hour', 0.95],
      ['seven_day_opus', 0.93],
      ['seven_day_sonnet', 0.92],
      ['seven_day', 0.93],
      ['overage', 0.95],
    ];
    for (const [window, threshold] of previous) {
      expect(shouldAbortForQuota(cliAuth, storeAt(window, threshold - 0.001), FIXED_NOW)).toEqual({ abort: false });
      expect(shouldAbortForQuota(cliAuth, storeAt(window, threshold), FIXED_NOW)).toMatchObject({
        abort: true,
        window,
        reason: `quota:${window} utilization ${(threshold * 100).toFixed(1)}% >= ${(threshold * 100).toFixed(0)}%`,
      });
    }
  });

  it('a configured threshold replaces the default for its window only', () => {
    process.env.CLAUDE_MEM_QUOTA_THRESHOLD_SEVEN_DAY = '0.99';
    expect(shouldAbortForQuota(cliAuth, storeAt('seven_day', 0.95), FIXED_NOW).abort).toBe(false);
    expect(shouldAbortForQuota(cliAuth, storeAt('seven_day', 0.99), FIXED_NOW).abort).toBe(true);
    expect(shouldAbortForQuota(cliAuth, storeAt('seven_day_opus', 0.93), FIXED_NOW).abort).toBe(true);
  });

  it('an unparseable value falls back to the default', () => {
    process.env.CLAUDE_MEM_QUOTA_THRESHOLD_SEVEN_DAY = 'not-a-number';
    expect(shouldAbortForQuota(cliAuth, storeAt('seven_day', 0.92), FIXED_NOW).abort).toBe(false);
    expect(shouldAbortForQuota(cliAuth, storeAt('seven_day', 0.93), FIXED_NOW).abort).toBe(true);
  });

  it("keeps the bounds: '0' stops at any reported utilization, '1' only at full", () => {
    process.env.CLAUDE_MEM_QUOTA_THRESHOLD_SEVEN_DAY = '0';
    expect(shouldAbortForQuota(cliAuth, storeAt('seven_day', 0), FIXED_NOW)).toMatchObject({
      abort: true,
      window: 'seven_day',
      reason: 'quota:seven_day utilization 0.0% >= 0%',
    });

    process.env.CLAUDE_MEM_QUOTA_THRESHOLD_SEVEN_DAY = '1';
    expect(shouldAbortForQuota(cliAuth, storeAt('seven_day', 0.99), FIXED_NOW).abort).toBe(false);
    expect(shouldAbortForQuota(cliAuth, storeAt('seven_day', 1), FIXED_NOW).abort).toBe(true);
  });

  // A percent such as '93' or a value above 1 would switch the guard off, and
  // a negative one would stop the observer at once. `Number('')` is 0, so a
  // blank value must not be read as a threshold of 0 either.
  it.each(['93', '1.5', '-0.1', '0.9x', ''])('%p falls back to the default', (value) => {
    process.env.CLAUDE_MEM_QUOTA_THRESHOLD_SEVEN_DAY = value;
    expect(shouldAbortForQuota(cliAuth, storeAt('seven_day', 0.92), FIXED_NOW).abort).toBe(false);
    expect(shouldAbortForQuota(cliAuth, storeAt('seven_day', 0.93), FIXED_NOW).abort).toBe(true);
  });

  it('warns once per key about an out-of-range value, naming the key and the 0 to 1 range', () => {
    const warn = spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      process.env.CLAUDE_MEM_QUOTA_THRESHOLD_SEVEN_DAY_SONNET = '92';
      shouldAbortForQuota(cliAuth, storeAt('seven_day_sonnet', 0.5), FIXED_NOW);
      shouldAbortForQuota(cliAuth, storeAt('seven_day_sonnet', 0.5), FIXED_NOW);

      const sonnetWarnings = warn.mock.calls.filter(([, message]) =>
        String(message).includes('CLAUDE_MEM_QUOTA_THRESHOLD_SEVEN_DAY_SONNET'));
      expect(sonnetWarnings).toHaveLength(1);
      expect(String(sonnetWarnings[0][1])).toContain('from 0 to 1');
    } finally {
      warn.mockRestore();
    }
  });

  it('a provider rejection still stops the observer whatever the threshold', () => {
    process.env.CLAUDE_MEM_QUOTA_THRESHOLD_SEVEN_DAY = '1';
    expect(shouldAbortForQuota(cliAuth, storeAt('seven_day', 0.5, 'rejected'), FIXED_NOW)).toMatchObject({
      abort: true,
      window: 'seven_day',
      reason: 'quota:seven_day rejected by provider',
    });
  });

  describe('saved in settings.json', () => {
    // The data dir is shared by the whole run, so leave the file as it was.
    let savedSettings: string | null = null;
    beforeEach(() => {
      savedSettings = existsSync(USER_SETTINGS_PATH) ? readFileSync(USER_SETTINGS_PATH, 'utf-8') : null;
    });
    afterEach(() => {
      if (savedSettings === null) rmSync(USER_SETTINGS_PATH, { force: true });
      else writeFileSync(USER_SETTINGS_PATH, savedSettings, 'utf-8');
    });

    it('reads the thresholds with no env override, including a hand-written JSON number', () => {
      writeFileSync(USER_SETTINGS_PATH, JSON.stringify({
        CLAUDE_MEM_QUOTA_THRESHOLD_SEVEN_DAY: '0.99',
        CLAUDE_MEM_QUOTA_THRESHOLD_FIVE_HOUR: 0.5,
      }), 'utf-8');

      expect(shouldAbortForQuota(cliAuth, storeAt('seven_day', 0.95), FIXED_NOW).abort).toBe(false);
      expect(shouldAbortForQuota(cliAuth, storeAt('seven_day', 0.99), FIXED_NOW).abort).toBe(true);
      expect(shouldAbortForQuota(cliAuth, storeAt('five_hour', 0.49), FIXED_NOW).abort).toBe(false);
      expect(shouldAbortForQuota(cliAuth, storeAt('five_hour', 0.5), FIXED_NOW).abort).toBe(true);
    });
  });
});

// The generator's exit path sees only `quota:<window>` on the abort reason and
// rebuilds the pause from the snapshot, so the ledger and the cooldown notice
// carry the guard's own words instead of a generic "allowance exhausted".
describe('explainQuotaAbort', () => {
  it('rebuilds the reserve guard behind a quota:<window> abort', () => {
    const store = freshStore();
    store.set({ rateLimitType: 'five_hour', utilization: 0.96 });
    const pause = explainQuotaAbort('quota:five_hour', store, FIXED_NOW);
    expect(pause?.kind).toBe('quota_guard');
    expect(pause?.message).toContain('five-hour Claude usage is 96.0%');
  });

  it('rebuilds a provider refusal as exhausted', () => {
    const store = freshStore();
    store.set({ rateLimitType: 'seven_day', status: 'rejected', utilization: 0.5 });
    const pause = explainQuotaAbort('quota:seven_day', store, FIXED_NOW);
    expect(pause?.kind).toBe('quota_exhausted');
    expect(pause?.message).toContain('weekly usage allowance is exhausted');
  });

  it('gives nothing for a reason that names no guarded window, another account\'s snapshot, or a stop it cannot explain', () => {
    const store = freshStore();
    store.set({ rateLimitType: 'seven_day', status: 'rejected', profile: 'other' });
    store.set({ rateLimitType: 'five_hour', utilization: 0.1 });
    expect(explainQuotaAbort('quota:observer_text', store, FIXED_NOW)).toBeUndefined();
    expect(explainQuotaAbort('quota:quota_exhausted', store, FIXED_NOW)).toBeUndefined();
    expect(explainQuotaAbort(null, store, FIXED_NOW)).toBeUndefined();
    expect(explainQuotaAbort('quota:seven_day', store, FIXED_NOW, 'mine')).toBeUndefined();
    expect(explainQuotaAbort('quota:five_hour', store, FIXED_NOW)).toBeUndefined();
  });
});

// usage_limit_hit telemetry: one event per exhausted window, never one per
// observer request against the wall.
describe('RateLimitStore.set → new-rejection signal', () => {
  it('reports the first rejected snapshot for a window', () => {
    const store = freshStore();
    expect(store.set({ rateLimitType: 'five_hour', status: 'allowed', utilization: 0.4 })).toBe(false);
    expect(store.set({ rateLimitType: 'five_hour', status: 'rejected', resetsAt: FIXED_NOW + 60_000 })).toBe(true);
  });

  it('does not re-report the same rejection on later requests', () => {
    const store = freshStore();
    const rejected: RateLimitInfo = { rateLimitType: 'five_hour', status: 'rejected', resetsAt: FIXED_NOW + 60_000 };
    expect(store.set(rejected)).toBe(true);
    expect(store.set(rejected)).toBe(false);
    expect(store.set({ ...rejected, utilization: 1 })).toBe(false);
  });

  it('reports again when the same window is exhausted after a reset', () => {
    const store = freshStore();
    expect(store.set({ rateLimitType: 'five_hour', status: 'rejected', resetsAt: FIXED_NOW + 60_000 })).toBe(true);
    expect(store.set({ rateLimitType: 'five_hour', status: 'rejected', resetsAt: FIXED_NOW + 6 * 3_600_000 })).toBe(true);
  });

  it('reports again after an allowed snapshot in between', () => {
    const store = freshStore();
    const rejected: RateLimitInfo = { rateLimitType: 'seven_day', status: 'rejected', resetsAt: FIXED_NOW + 60_000 };
    expect(store.set(rejected)).toBe(true);
    expect(store.set({ rateLimitType: 'seven_day', status: 'allowed' })).toBe(false);
    expect(store.set(rejected)).toBe(true);
  });

  it('tracks windows independently', () => {
    const store = freshStore();
    expect(store.set({ rateLimitType: 'five_hour', status: 'rejected', resetsAt: 1 })).toBe(true);
    expect(store.set({ rateLimitType: 'seven_day', status: 'rejected', resetsAt: 1 })).toBe(true);
  });

  it('dedupes rejection telemetry when the same exhaustion arrives in different reset units', () => {
    const store = freshStore();
    const resetSec = Math.floor(FIXED_NOW / 1000) + 3_600;
    // Claude Code writes epoch seconds; the SDK documents epoch ms. One
    // exhaustion must stay one usage_limit_hit whichever unit arrives.
    expect(store.set({ rateLimitType: 'seven_day', status: 'rejected', resetsAt: resetSec })).toBe(true);
    expect(store.set({ rateLimitType: 'seven_day', status: 'rejected', resetsAt: resetSec * 1000 })).toBe(false);
    expect(store.set({ rateLimitType: 'seven_day', status: 'rejected', resetsAt: resetSec })).toBe(false);
  });

  it('stores reset times in epoch ms whatever unit the event used', () => {
    const store = freshStore();
    const resetSec = Math.floor(FIXED_NOW / 1000) + 3_600;
    store.set({
      rateLimitType: 'five_hour',
      status: 'allowed',
      resetsAt: resetSec,
      overageResetsAt: resetSec + 60,
      unifiedWindows: { seven_day: { utilization: 0.2, resetsAt: resetSec + 86_400 } },
    });
    expect(store.get('five_hour')?.resetsAt).toBe(resetSec * 1000);
    expect(store.get('five_hour')?.overageResetsAt).toBe((resetSec + 60) * 1000);
    expect(store.get('seven_day')?.resetsAt).toBe((resetSec + 86_400) * 1000);
  });

  it('never reports allowed or warning snapshots', () => {
    expect(isNewRejection(undefined, { status: 'allowed' })).toBe(false);
    expect(isNewRejection(undefined, { status: 'allowed_warning', utilization: 0.99 })).toBe(false);
    expect(isNewRejection(undefined, {})).toBe(false);
  });

  it('ignores malformed payloads', () => {
    const store = freshStore();
    expect(store.set(undefined)).toBe(false);
    expect(store.set(null)).toBe(false);
  });
});

// The CLI names only the binding window in `rateLimitType`; every other
// window's live figure arrives in `unifiedWindows` (#4076).
describe('RateLimitStore.set → unifiedWindows', () => {
  const cliAuth = 'Claude Code OAuth token (read from system keychain at spawn)';
  const sevenDayResetsAt = Math.floor(FIXED_NOW / 1000) + 3 * 86_400; // epoch seconds, still ahead

  // Shape observed from Claude Code 2.1.281 on the wire.
  const fiveHourEvent: RateLimitInfo = {
    status: 'allowed',
    resetsAt: Math.floor(FIXED_NOW / 1000) + 3_600,
    rateLimitType: 'five_hour',
    overageStatus: 'rejected',
    isUsingOverage: false,
    unifiedWindows: {
      five_hour: { utilization: 0.61, resetsAt: Math.floor(FIXED_NOW / 1000) + 3_600 },
      seven_day: { utilization: 0.24, resetsAt: sevenDayResetsAt },
    },
  };

  it('replaces a stale window whose reset is still ahead', () => {
    const store = freshStore();
    store.set({
      rateLimitType: 'seven_day',
      status: 'allowed_warning',
      utilization: 0.98,
      resetsAt: sevenDayResetsAt,
    });
    expect(shouldAbortForQuota(cliAuth, store, FIXED_NOW).abort).toBe(true);

    store.set(fiveHourEvent);

    const sevenDay = store.get('seven_day');
    expect(sevenDay?.utilization).toBe(0.24);
    expect(sevenDay?.status).toBeUndefined();
    expect(shouldAbortForQuota(cliAuth, store, FIXED_NOW).abort).toBe(false);
  });

  it('clears a stale rejection when the fresh figure is under threshold', () => {
    const store = freshStore();
    store.set({ rateLimitType: 'seven_day', status: 'rejected', resetsAt: sevenDayResetsAt });
    store.set(fiveHourEvent);
    expect(shouldAbortForQuota(cliAuth, store, FIXED_NOW).abort).toBe(false);
  });

  it('preserves an active rejection when a sibling snapshot only repeats its reset time', () => {
    const store = freshStore();
    const now = Date.now();
    const resetsAt = now + 60_000;
    store.set({ rateLimitType: 'seven_day', status: 'rejected', resetsAt });

    store.set({
      rateLimitType: 'five_hour',
      status: 'allowed',
      unifiedWindows: { seven_day: { resetsAt } },
    });

    expect(store.get('seven_day')?.status).toBe('rejected');
    expect(shouldAbortForQuota(cliAuth, store, now)).toMatchObject({
      abort: true,
      window: 'seven_day',
      reason: 'quota:seven_day rejected by provider',
    });
  });

  it('preserves the cached reset when a sibling snapshot only refreshes utilization', () => {
    const store = freshStore();
    // set() stamps real time, so the cached reset must be ahead of it.
    const now = Date.now();
    const resetsAt = now + 10 * 60_000;
    store.set({
      rateLimitType: 'five_hour',
      status: 'allowed_warning',
      utilization: 0.96,
      resetsAt,
    });

    store.set({
      rateLimitType: 'seven_day',
      status: 'allowed',
      unifiedWindows: { five_hour: { utilization: 0.9 } },
    });

    const fiveHour = store.get('five_hour');
    expect(fiveHour?.utilization).toBe(0.9);
    expect(fiveHour?.resetsAt).toBe(resetsAt);
    expect(fiveHour?.status).toBeUndefined();
    expect(shouldAbortForQuota(cliAuth, store, now).abort).toBe(true);
    expect(shouldAbortForQuota(cliAuth, store, resetsAt + 1).abort).toBe(false);
  });

  it('does not carry an expired cached reset into a utilization-only refresh', () => {
    const store = freshStore();
    const now = Date.now();
    store.set({
      rateLimitType: 'seven_day',
      status: 'allowed_warning',
      utilization: 0.98,
      resetsAt: now - 60_000, // last week's window, already reset
    });

    // A sibling figure with no reset time, as seen on the wire in #3606.
    store.set({
      rateLimitType: 'five_hour',
      status: 'allowed',
      unifiedWindows: { seven_day: { utilization: 0.96 } },
    });

    expect(store.get('seven_day')?.resetsAt).toBeUndefined();
    expect(shouldAbortForQuota(cliAuth, store, now)).toMatchObject({
      abort: true,
      window: 'seven_day',
      reason: 'quota:seven_day utilization 96.0% >= 93%',
    });
  });

  it('still aborts when the fresh unified figure is over threshold', () => {
    const store = freshStore();
    store.set({
      ...fiveHourEvent,
      unifiedWindows: { seven_day: { utilization: 0.97, resetsAt: sevenDayResetsAt } },
    });
    expect(shouldAbortForQuota(cliAuth, store, FIXED_NOW)).toMatchObject({
      abort: true,
      window: 'seven_day',
      reason: 'quota:seven_day utilization 97.0% >= 93%',
    });
  });

  it('fills utilization on the binding window from its unified entry', () => {
    const store = freshStore();
    store.set(fiveHourEvent);
    const fiveHour = store.get('five_hour');
    expect(fiveHour?.utilization).toBe(0.61);
    expect(fiveHour?.status).toBe('allowed');
    expect(fiveHour?.overageStatus).toBe('rejected');
  });

  it('keeps a top-level utilization over the unified one for the binding window', () => {
    const store = freshStore();
    store.set({ ...fiveHourEvent, utilization: 0.7 });
    expect(store.get('five_hour')?.utilization).toBe(0.7);
  });

  it('ignores unknown and malformed unified entries', () => {
    const store = freshStore();
    store.set({
      rateLimitType: 'five_hour',
      status: 'allowed',
      unifiedWindows: {
        mystery_window: { utilization: 1 },
        seven_day: null,
        seven_day_opus: 'nope',
      } as unknown as RateLimitInfo['unifiedWindows'],
    });
    expect(store.size).toBe(1);
    expect(store.get('seven_day')).toBeUndefined();
  });

  it('dedupes a repeated rejection whose resetsAt only arrives via unifiedWindows', () => {
    const store = freshStore();
    const rejected: RateLimitInfo = {
      status: 'rejected',
      rateLimitType: 'five_hour',
      unifiedWindows: { five_hour: { utilization: 1, resetsAt: Math.floor(FIXED_NOW / 1000) + 3_600 } },
    };
    expect(store.set(rejected)).toBe(true);
    expect(store.set(rejected)).toBe(false);
    expect(store.set(rejected)).toBe(false);
  });

  it('leaves the overage bucket to top-level events', () => {
    const store = freshStore();
    store.set({
      status: 'allowed',
      rateLimitType: 'five_hour',
      isUsingOverage: false,
      unifiedWindows: { overage: { utilization: 1, resetsAt: sevenDayResetsAt } },
    });
    expect(store.get('overage')).toBeUndefined();
    expect(shouldAbortForQuota(cliAuth, store, FIXED_NOW).abort).toBe(false);
  });

  it('leaves per-model buckets to the events that name them', () => {
    const store = freshStore();
    store.set({
      ...fiveHourEvent,
      unifiedWindows: {
        ...fiveHourEvent.unifiedWindows,
        seven_day_opus: { utilization: 0.99, resetsAt: sevenDayResetsAt },
        seven_day_overage_included: { utilization: 1.4, resetsAt: sevenDayResetsAt },
      },
    });
    expect(store.get('seven_day')?.utilization).toBe(0.24);
    expect(store.get('seven_day_opus')).toBeUndefined();
    expect(store.get('seven_day_overage_included')).toBeUndefined();
    expect(shouldAbortForQuota(cliAuth, store, FIXED_NOW).abort).toBe(false);
  });

  it('does not report a rejection for windows refreshed from unifiedWindows', () => {
    const store = freshStore();
    expect(store.set(fiveHourEvent)).toBe(false);
  });

  it('dedupes a rejection after its display snapshot is refreshed by another window', () => {
    const store = freshStore();
    const rejected: RateLimitInfo = {
      rateLimitType: 'five_hour',
      status: 'rejected',
      resetsAt: FIXED_NOW + 60_000,
    };
    expect(store.set(rejected)).toBe(true);

    expect(store.set({
      rateLimitType: 'seven_day',
      status: 'allowed',
      unifiedWindows: { five_hour: { utilization: 0.4 } },
    })).toBe(false);
    expect(store.get('five_hour')?.status).toBeUndefined();

    expect(store.set(rejected)).toBe(false);
  });

  it('uses a newer unified window instead of an expired high reading', () => {
    const store = freshStore();
    store.set({
      rateLimitType: 'five_hour',
      status: 'allowed_warning',
      utilization: 0.95,
      resetsAt: 1_788_710_400,
    });
    store.set({
      rateLimitType: 'seven_day',
      status: 'allowed_warning',
      utilization: 0.85,
      resetsAt: 1_788_883_200,
      unifiedWindows: {
        five_hour: { utilization: 0.28, resetsAt: 1_788_730_200 },
        seven_day: { utilization: 0.85, resetsAt: 1_788_883_200 },
      },
    });

    expect(shouldAbortForQuota(cliAuth, store, 1_788_720_763_944)).toEqual({ abort: false });
    expect(store.get('five_hour')?.utilization).toBe(0.28);
  });

  it('records a fresh zero utilization from a unified window', () => {
    const store = freshStore();
    store.set({
      rateLimitType: 'five_hour',
      status: 'allowed_warning',
      utilization: 0.96,
      resetsAt: FIXED_NOW + 2 * 60 * 60_000,
    });
    store.set({
      rateLimitType: 'seven_day',
      status: 'allowed',
      utilization: 0.4,
      unifiedWindows: {
        five_hour: { utilization: 0, resetsAt: FIXED_NOW + 5 * 60 * 60_000 },
      },
    });

    expect(store.get('five_hour')?.utilization).toBe(0);
    expect(shouldAbortForQuota(cliAuth, store, FIXED_NOW)).toEqual({ abort: false });
  });

  it('uses a newer unified reading when the stale sibling reset is still in the future', () => {
    const store = freshStore();
    store.set({
      rateLimitType: 'five_hour',
      status: 'allowed_warning',
      utilization: 0.96,
      resetsAt: FIXED_NOW + 60 * 60_000,
    });
    store.set({
      rateLimitType: 'seven_day',
      status: 'allowed_warning',
      utilization: 0.8,
      unifiedWindows: {
        five_hour: { utilization: 0.25, resetsAt: FIXED_NOW + 4 * 60 * 60_000 },
      },
    });

    expect(shouldAbortForQuota(cliAuth, store, FIXED_NOW)).toEqual({ abort: false });
  });

  it('accepts a unified reading after an explicit rejection has expired', () => {
    const store = freshStore();
    const now = Date.now();
    store.set({
      rateLimitType: 'five_hour',
      status: 'rejected',
      utilization: 1,
      resetsAt: now - 1,
    });
    store.set({
      rateLimitType: 'seven_day',
      status: 'allowed',
      utilization: 0.4,
      unifiedWindows: {
        five_hour: { utilization: 0.2, resetsAt: now + 5 * 60 * 60_000 },
      },
    });

    expect(store.get('five_hour')?.utilization).toBe(0.2);
    expect(shouldAbortForQuota(cliAuth, store, now)).toEqual({ abort: false });
  });

  // A present but malformed field voids the entry: half of a corrupt snapshot
  // must not replace a good reading (the old guard refreshed five_hour to 0.2
  // from an entry whose reset time was the string 'soon').
  it('ignores malformed unified window data without corrupting existing buckets', () => {
    const store = freshStore();
    store.set({
      rateLimitType: 'five_hour',
      status: 'allowed',
      utilization: 0.4,
      resetsAt: FIXED_NOW + 60 * 60_000,
    });
    store.set({
      rateLimitType: 'seven_day',
      status: 'allowed',
      utilization: 0.4,
      unifiedWindows: {
        five_hour: { utilization: 0.2, resetsAt: 'soon' },
        seven_day_opus: { utilization: Number.NaN, resetsAt: FIXED_NOW + 60_000 },
        seven_day_sonnet: null,
        invented_window: { utilization: 1, resetsAt: FIXED_NOW + 60_000 },
      },
    } as unknown as RateLimitInfo);

    expect(store.get('five_hour')?.utilization).toBe(0.4);
    expect(store.get('seven_day_opus')).toBeUndefined();
    expect(store.get('seven_day_sonnet')).toBeUndefined();
    expect(store.size).toBe(2);
  });

  it('does not persist unifiedWindows on the stored entry', () => {
    const store = freshStore();
    store.set({ rateLimitType: 'five_hour', unifiedWindows: { seven_day: { utilization: 0.1 } } });
    expect((store.get('five_hour') as any).unifiedWindows).toBeUndefined();
    expect((store.get('seven_day') as any).unifiedWindows).toBeUndefined();
  });
});

describe('minutesUntilReset', () => {
  it('handles epoch-ms and epoch-seconds resetsAt', () => {
    expect(minutesUntilReset(FIXED_NOW + 30 * 60_000, FIXED_NOW)).toBe(30);
    expect(minutesUntilReset(Math.floor(FIXED_NOW / 1000) + 30 * 60, FIXED_NOW)).toBe(30);
  });

  it('floors at zero and drops non-numbers', () => {
    expect(minutesUntilReset(FIXED_NOW - 60_000, FIXED_NOW)).toBe(0);
    expect(minutesUntilReset(undefined, FIXED_NOW)).toBeUndefined();
    expect(minutesUntilReset(Number.NaN, FIXED_NOW)).toBeUndefined();
  });
});

describe('buildUsageLimitHitProps', () => {
  it('projects rate_limit_info to closed enums and one integer', () => {
    expect(
      buildUsageLimitHitProps(
        {
          status: 'rejected',
          rateLimitType: 'five_hour',
          resetsAt: FIXED_NOW + 112 * 60_000,
          overageStatus: 'rejected',
          isUsingOverage: false,
        },
        FIXED_NOW,
      ),
    ).toEqual({
      limit_window: 'five_hour',
      overage_status: 'rejected',
      is_using_overage: false,
      resets_in_minutes: 112,
    });
  });

  it('fills unknown for missing enum fields', () => {
    expect(buildUsageLimitHitProps({ status: 'rejected' }, FIXED_NOW)).toEqual({
      limit_window: 'unknown',
      overage_status: 'unknown',
      is_using_overage: false,
      resets_in_minutes: undefined,
    });
  });
});

// The SDK emits `{ type: 'rate_limit_event', rate_limit_info }` (SDKRateLimitEvent
// in sdk.d.ts). The original guard matched a `system` message with subtype
// `rate_limit`, which the SDK never sends, so the whole quota path was dead.
describe('extractRateLimitInfo', () => {
  const info: RateLimitInfo = { status: 'rejected', rateLimitType: 'five_hour', resetsAt: FIXED_NOW + 60_000 };

  it('accepts the SDK rate_limit_event message', () => {
    expect(
      extractRateLimitInfo({ type: 'rate_limit_event', rate_limit_info: info, uuid: 'u', session_id: 's' }),
    ).toEqual(info);
  });

  it('still accepts the legacy system/rate_limit shape', () => {
    expect(extractRateLimitInfo({ type: 'system', subtype: 'rate_limit', rate_limit_info: info })).toEqual(info);
  });

  it('ignores every other stream message', () => {
    expect(extractRateLimitInfo({ type: 'system', subtype: 'init' })).toBeUndefined();
    expect(extractRateLimitInfo({ type: 'assistant', message: {} })).toBeUndefined();
    expect(extractRateLimitInfo({ type: 'result', subtype: 'success' })).toBeUndefined();
    expect(extractRateLimitInfo(undefined)).toBeUndefined();
    expect(extractRateLimitInfo('rate_limit_event')).toBeUndefined();
  });

  it('ignores a rate_limit_event with no payload', () => {
    expect(extractRateLimitInfo({ type: 'rate_limit_event' })).toBeUndefined();
    expect(extractRateLimitInfo({ type: 'rate_limit_event', rate_limit_info: null })).toBeUndefined();
  });
});
