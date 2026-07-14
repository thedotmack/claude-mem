import { describe, it, expect, beforeEach } from 'bun:test';
import {
  CLAUDE_QUOTA_PROBE_LEASE_MS,
  CLAUDE_QUOTA_RETRY_MS,
  RateLimitStore,
  shouldAbortForQuota,
  isApiKeyAuth,
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

describe('Claude quota spawn gate', () => {
  it('blocks starts until cooldown and admits only one probe', () => {
    const store = freshStore();
    const retryAt = FIXED_NOW + CLAUDE_QUOTA_RETRY_MS;

    store.blockClaudeSpawns('observer_text', retryAt);

    expect(store.getClaudeSpawnBlock(FIXED_NOW)).toMatchObject({
      blocked: true,
      retryAt,
      reason: 'observer_text',
    });
    expect(store.acquireClaudeSpawnPermit(FIXED_NOW)).toMatchObject({
      allowed: false,
      retryAt,
    });

    const probe = store.acquireClaudeSpawnPermit(retryAt);
    expect(probe.allowed).toBe(true);
    expect(typeof probe.probeToken).toBe('number');

    expect(store.acquireClaudeSpawnPermit(retryAt)).toMatchObject({
      allowed: false,
      retryAt: retryAt + CLAUDE_QUOTA_PROBE_LEASE_MS,
    });
  });

  it('clears only the current probe token', () => {
    const store = freshStore();
    store.blockClaudeSpawns('observer_text', FIXED_NOW);

    const probe = store.acquireClaudeSpawnPermit(FIXED_NOW);
    expect(probe.probeToken).toBeDefined();
    expect(store.completeClaudeSpawnProbe((probe.probeToken ?? 0) + 1)).toBe(false);
    expect(store.getClaudeSpawnBlock(FIXED_NOW)).toMatchObject({ blocked: true });

    expect(store.completeClaudeSpawnProbe(probe.probeToken!)).toBe(true);
    expect(store.getClaudeSpawnBlock(FIXED_NOW)).toEqual({ blocked: false });
    expect(store.acquireClaudeSpawnPermit(FIXED_NOW)).toEqual({ allowed: true });
  });

  it('never shortens an existing cooldown', () => {
    const store = freshStore();
    const laterRetryAt = FIXED_NOW + (2 * CLAUDE_QUOTA_RETRY_MS);

    store.blockClaudeSpawns('structured', laterRetryAt);
    store.blockClaudeSpawns('observer_text', FIXED_NOW + CLAUDE_QUOTA_RETRY_MS);

    expect(store.getClaudeSpawnBlock(FIXED_NOW)).toMatchObject({
      blocked: true,
      retryAt: laterRetryAt,
    });
  });

  it('rejects already-admitted ordinary starts after a later quota signal', () => {
    const store = freshStore();
    const ordinaryPermit = store.acquireClaudeSpawnPermit(FIXED_NOW);
    expect(ordinaryPermit).toEqual({ allowed: true });

    const retryAt = FIXED_NOW + CLAUDE_QUOTA_RETRY_MS;
    store.blockClaudeSpawns('observer_text', retryAt);

    expect(store.canStartClaudeSession(undefined, FIXED_NOW)).toBe(false);

    const probe = store.acquireClaudeSpawnPermit(retryAt);
    expect(probe.probeToken).toBeDefined();
    expect(store.canStartClaudeSession(probe.probeToken, retryAt)).toBe(true);
    expect(store.canStartClaudeSession(undefined, retryAt)).toBe(false);
    expect(store.canStartClaudeSession((probe.probeToken ?? 0) + 1, retryAt)).toBe(false);
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
