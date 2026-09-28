import { describe, it, expect, beforeEach } from 'bun:test';
import {
  RateLimitStore,
  shouldAbortForQuota,
  isApiKeyAuth,
  isNewRejection,
  extractRateLimitInfo,
  minutesUntilReset,
  buildUsageLimitHitProps,
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
    expect(decision).toEqual({
      abort: true,
      window: 'five_hour',
      reason: 'quota:five_hour rejected by provider',
    });
  });

  it('still aborts on a rejected entry with no reset time', () => {
    store.set({ rateLimitType: 'five_hour', status: 'rejected' });
    const decision = shouldAbortForQuota(cliAuth, store, FIXED_NOW);
    expect(decision).toEqual({
      abort: true,
      window: 'five_hour',
      reason: 'quota:five_hour rejected by provider',
    });
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

// Unified sibling-window hydration (#4076, #4068 defect 1).
//
// The SDK bundles per-window snapshots in `unifiedWindows` on each
// rate-limit event. set() must hydrate sibling buckets from it so a fresh
// event replaces stale utilization/rejection state for windows the event
// did not name; otherwise a stale snapshot whose reset is still in the
// future keeps aborting generation after the provider reports the window
// healthy.
describe('RateLimitStore unifiedWindows hydration (#4076)', () => {
  const sec = (ms: number) => Math.floor(ms / 1000);

  it('replaces a stale rejected sibling bucket from a fresh unified snapshot', () => {
    const store = freshStore();

    // Stale: seven_day was rejected with a reset still in the future.
    store.set({ rateLimitType: 'seven_day', status: 'rejected', resetsAt: FIXED_NOW + 60_000 });
    expect(shouldAbortForQuota('cli', store, FIXED_NOW).abort).toBe(true);

    // A fresh five_hour event reports seven_day as healthy via unifiedWindows.
    store.set({
      rateLimitType: 'five_hour',
      status: 'allowed',
      resetsAt: FIXED_NOW + 60_000,
      unifiedWindows: {
        // epoch seconds, like the SDK emits
        seven_day: { status: 'allowed', utilization: 0.07, resetsAt: sec(FIXED_NOW) + 3600 },
      },
    });

    expect(shouldAbortForQuota('cli', store, FIXED_NOW).abort).toBe(false);
    expect(shouldAbortForQuota('cli', store, FIXED_NOW).window).toBeUndefined();
  });

  it('replaces stale high utilization before its reset', () => {
    const store = freshStore();

    // Stale: five_hour at 100% utilization with a far-future reset.
    store.set({
      rateLimitType: 'five_hour',
      status: 'allowed',
      utilization: 1,
      resetsAt: FIXED_NOW + 3_600_000,
    });
    const before = shouldAbortForQuota('cli', store, FIXED_NOW);
    expect(before.abort).toBe(true);
    expect(before.window).toBe('five_hour');

    // A seven_day event carries a fresh unified five_hour snapshot at 7%.
    store.set({
      rateLimitType: 'seven_day',
      status: 'allowed',
      utilization: 0.1,
      unifiedWindows: {
        five_hour: { utilization: 0.07, resetsAt: sec(FIXED_NOW) + 3600 },
      },
    });

    expect(shouldAbortForQuota('cli', store, FIXED_NOW).abort).toBe(false);
  });

  it('keeps aborting when the fresh unified snapshot shows active quota pressure', () => {
    const store = freshStore();

    store.set({
      rateLimitType: 'five_hour',
      status: 'allowed',
      resetsAt: FIXED_NOW + 60_000,
      unifiedWindows: {
        seven_day: { status: 'rejected', utilization: 1, resetsAt: FIXED_NOW + 60_000 },
      },
    });

    const decision = shouldAbortForQuota('cli', store, FIXED_NOW);
    expect(decision.abort).toBe(true);
    expect(decision.window).toBe('seven_day');
  });

  it('lets the primary bucket win when it also appears in unifiedWindows', () => {
    const store = freshStore();

    store.set({
      rateLimitType: 'five_hour',
      status: 'rejected',
      resetsAt: FIXED_NOW + 60_000,
      unifiedWindows: {
        five_hour: { status: 'allowed', utilization: 0.07 },
      },
    });

    // Primary event's richer status fields win over the unified entry.
    const decision = shouldAbortForQuota('cli', store, FIXED_NOW);
    expect(decision.abort).toBe(true);
    expect(decision.window).toBe('five_hour');
    expect(store.get('five_hour')?.status).toBe('rejected');
  });

  it('emits rejection telemetry for a hydrated sibling rejection', () => {
    const store = freshStore();

    const isNew = store.set({
      rateLimitType: 'five_hour',
      status: 'allowed',
      unifiedWindows: {
        seven_day: { status: 'rejected', resetsAt: FIXED_NOW + 60_000 },
      },
    });

    // The sibling rejection aborts via the quota guard, so it must also
    // produce the usage_limit_hit signal.
    expect(isNew).toBe(true);
    expect(shouldAbortForQuota('cli', store, FIXED_NOW).window).toBe('seven_day');
  });

  it('does not repeat sibling-rejection telemetry for the same exhaustion', () => {
    const store = freshStore();
    const event = {
      rateLimitType: 'five_hour' as const,
      status: 'allowed' as const,
      unifiedWindows: {
        seven_day: { status: 'rejected' as const, resetsAt: FIXED_NOW + 60_000 },
      },
    };

    expect(store.set(event)).toBe(true);
    expect(store.set(event)).toBe(false);
  });

  it('preserves an explicit isUsingOverage=false across sibling hydration', () => {
    const store = freshStore();

    // Overage bucket is not being charged, but utilization is high: the
    // guard must ignore it.
    store.set({
      rateLimitType: 'overage',
      status: 'allowed',
      utilization: 0.99,
      isUsingOverage: false,
      resetsAt: FIXED_NOW + 3_600_000,
    });
    expect(shouldAbortForQuota('cli', store, FIXED_NOW).abort).toBe(false);

    // A fresh sibling event bundles an overage snapshot that doesn't carry
    // the flag. Hydration must not drop it and start aborting on the idle
    // utilization.
    store.set({
      rateLimitType: 'five_hour',
      status: 'allowed',
      unifiedWindows: {
        overage: { utilization: 0.99, resetsAt: sec(FIXED_NOW) + 3600 },
      },
    });

    expect(store.get('overage')?.isUsingOverage).toBe(false);
    expect(shouldAbortForQuota('cli', store, FIXED_NOW).abort).toBe(false);
  });

  it('dedupes rejection telemetry when the same exhaustion arrives in different reset units', () => {
    const store = freshStore();
    const resetSec = sec(FIXED_NOW) + 3600;

    // Sibling snapshot reports the rejection with resetsAt in epoch seconds.
    const first = store.set({
      rateLimitType: 'five_hour',
      status: 'allowed',
      unifiedWindows: {
        seven_day: { status: 'rejected', resetsAt: resetSec },
      },
    });
    expect(first).toBe(true);

    // The later primary event reports the same exhaustion in epoch ms: one
    // exhaustion, one usage_limit_hit.
    const second = store.set({
      rateLimitType: 'seven_day',
      status: 'rejected',
      resetsAt: resetSec * 1000,
    });
    expect(second).toBe(false);
  });

  it('ignores unifiedWindows entries for windows it does not track', () => {
    const store = freshStore();

    store.set({
      rateLimitType: 'five_hour',
      status: 'allowed',
      unifiedWindows: {
        seven_day: { status: 'allowed' },
        bogus_window: { status: 'rejected' },
      } as RateLimitInfo['unifiedWindows'],
    });

    expect(store.get('seven_day')?.status).toBe('allowed');
    expect(store.size).toBe(2); // five_hour + seven_day only
  });
});
