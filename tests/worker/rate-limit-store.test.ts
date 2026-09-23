import { describe, it, expect, beforeEach } from 'bun:test';
import {
  RateLimitStore,
  shouldAbortForQuota,
  isApiKeyAuth,
  isNewRejection,
  extractRateLimitInfo,
  minutesUntilReset,
  buildUsageLimitHitProps,
  toEpochMs,
  isStaleEntry,
  type RateLimitInfo,
} from '../../src/services/worker/RateLimitStore.js';

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

// #4068: a bucket is written only when its window is the binding one
// (`rateLimitType`), so a seven_day snapshot taken at 98% is never overwritten
// by the five_hour-typed events that follow, and the guard keeps aborting on it
// for days after the window has actually reset. Two fixes: refresh every
// bucket from `unifiedWindows`, and never abort on a bucket whose `resetsAt`
// is in the past.
describe('shouldAbortForQuota — stale snapshots (#4068)', () => {
  const cliAuth = 'Claude Code OAuth token (read from system keychain at spawn)';
  let store: RateLimitStore;
  beforeEach(() => {
    store = freshStore();
  });

  it('skips a seven_day bucket whose resetsAt (epoch ms) has passed', () => {
    store.set({ rateLimitType: 'seven_day', utilization: 0.98, resetsAt: FIXED_NOW - 60_000 });
    expect(shouldAbortForQuota(cliAuth, store, FIXED_NOW).abort).toBe(false);
  });

  it('skips a seven_day bucket whose resetsAt (epoch seconds) has passed', () => {
    store.set({
      rateLimitType: 'seven_day',
      utilization: 0.98,
      resetsAt: Math.floor(FIXED_NOW / 1000) - 60,
    });
    expect(shouldAbortForQuota(cliAuth, store, FIXED_NOW).abort).toBe(false);
  });

  it('skips a stale rejected bucket too', () => {
    store.set({ rateLimitType: 'five_hour', status: 'rejected', resetsAt: FIXED_NOW - 1 });
    expect(shouldAbortForQuota(cliAuth, store, FIXED_NOW).abort).toBe(false);
  });

  it('still aborts while the window is live', () => {
    store.set({ rateLimitType: 'seven_day', utilization: 0.98, resetsAt: FIXED_NOW + 60_000 });
    const decision = shouldAbortForQuota(cliAuth, store, FIXED_NOW);
    expect(decision.abort).toBe(true);
    expect(decision.window).toBe('seven_day');
  });

  it('still aborts on a snapshot with no resetsAt (cannot tell it is stale)', () => {
    store.set({ rateLimitType: 'seven_day', utilization: 0.98 });
    expect(shouldAbortForQuota(cliAuth, store, FIXED_NOW).abort).toBe(true);
  });

  it('a later five_hour event refreshes the seven_day bucket via unifiedWindows', () => {
    // Window was binding at 98% ...
    store.set({
      rateLimitType: 'seven_day',
      status: 'allowed_warning',
      utilization: 0.98,
      resetsAt: FIXED_NOW + 60_000,
    });
    expect(shouldAbortForQuota(cliAuth, store, FIXED_NOW).abort).toBe(true);
    // ... then the next request reports five_hour as binding, with seven_day at 8%.
    store.set({
      status: 'allowed',
      rateLimitType: 'five_hour',
      resetsAt: FIXED_NOW + 3_600_000,
      unifiedWindows: {
        five_hour: { utilization: 0.11, resetsAt: FIXED_NOW + 3_600_000 },
        seven_day: { utilization: 0.08, resetsAt: FIXED_NOW + 6 * 86_400_000 },
      },
    });
    expect(store.get('seven_day')?.utilization).toBe(0.08);
    expect(store.get('seven_day')?.status).toBeUndefined();
    expect(shouldAbortForQuota(cliAuth, store, FIXED_NOW).abort).toBe(false);
  });

  it('applies the grace buffer when resetsAt is epoch seconds', () => {
    store.set({
      rateLimitType: 'five_hour',
      utilization: 0.9,
      resetsAt: Math.floor(FIXED_NOW / 1000) + 10 * 60,
    });
    const decision = shouldAbortForQuota(cliAuth, store, FIXED_NOW);
    expect(decision.abort).toBe(true);
    expect(decision.reason).toContain('resets in 10m');
  });
});

describe('RateLimitStore.set → unifiedWindows', () => {
  it('fills the other buckets from unifiedWindows', () => {
    const store = freshStore();
    store.set({
      status: 'allowed',
      rateLimitType: 'five_hour',
      resetsAt: FIXED_NOW + 1_000,
      unifiedWindows: {
        five_hour: { utilization: 0.11, resetsAt: FIXED_NOW + 1_000 },
        seven_day: { utilization: 0.08, resetsAt: FIXED_NOW + 2_000 },
      },
    });
    expect(store.size).toBe(2);
    expect(store.get('seven_day')).toMatchObject({
      rateLimitType: 'seven_day',
      utilization: 0.08,
      resetsAt: FIXED_NOW + 2_000,
    });
  });

  it('merges the primary window slice under the explicit top-level fields', () => {
    const store = freshStore();
    store.set({
      status: 'allowed_warning',
      rateLimitType: 'five_hour',
      utilization: 0.96,
      unifiedWindows: { five_hour: { utilization: 0.5, resetsAt: FIXED_NOW + 1_000 } },
    });
    const entry = store.get('five_hour');
    expect(entry?.utilization).toBe(0.96); // top-level wins
    expect(entry?.resetsAt).toBe(FIXED_NOW + 1_000); // filled from the slice
    expect(entry?.status).toBe('allowed_warning');
  });

  it('does not persist unifiedWindows on the stored entry', () => {
    const store = freshStore();
    store.set({ rateLimitType: 'five_hour', unifiedWindows: { seven_day: { utilization: 0.1 } } });
    expect((store.get('five_hour') as any).unifiedWindows).toBeUndefined();
    expect((store.get('seven_day') as any).unifiedWindows).toBeUndefined();
  });

  it('ignores unknown windows and malformed slices', () => {
    const store = freshStore();
    store.set({
      rateLimitType: 'five_hour',
      unifiedWindows: {
        seven_day_overage_included: { utilization: 0.3 },
        seven_day: null,
        overage: 'nope' as any,
        seven_day_opus: { utilization: 'high' as any, resetsAt: 'soon' as any },
      },
    });
    expect(store.get('seven_day')).toBeUndefined();
    expect(store.get('overage')).toBeUndefined();
    expect(store.get('seven_day_opus')).toEqual({
      rateLimitType: 'seven_day_opus',
      observedAt: expect.any(Number),
    });
    expect(store.size).toBe(2);
  });

  it('still reports new rejections based on the top-level fields', () => {
    const store = freshStore();
    expect(
      store.set({
        status: 'rejected',
        rateLimitType: 'five_hour',
        resetsAt: FIXED_NOW + 1_000,
        unifiedWindows: { five_hour: { utilization: 1 } },
      }),
    ).toBe(true);
  });
});

describe('toEpochMs / isStaleEntry', () => {
  it('normalizes seconds and passes ms through', () => {
    expect(toEpochMs(FIXED_NOW)).toBe(FIXED_NOW);
    expect(toEpochMs(Math.floor(FIXED_NOW / 1000))).toBe(Math.floor(FIXED_NOW / 1000) * 1000);
    expect(toEpochMs(undefined)).toBeUndefined();
    expect(toEpochMs(Number.NaN)).toBeUndefined();
  });

  it('is stale only when resetsAt is known and not in the future', () => {
    expect(isStaleEntry({ resetsAt: FIXED_NOW - 1 }, FIXED_NOW)).toBe(true);
    expect(isStaleEntry({ resetsAt: FIXED_NOW }, FIXED_NOW)).toBe(true);
    expect(isStaleEntry({ resetsAt: FIXED_NOW + 1 }, FIXED_NOW)).toBe(false);
    expect(isStaleEntry({}, FIXED_NOW)).toBe(false);
  });
});
