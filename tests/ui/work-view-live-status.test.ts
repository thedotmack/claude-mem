import { describe, expect, it } from 'bun:test';
import { getConnectionStatus, LOCAL_FEED_STALE_AFTER_MS } from '../../src/ui/work-view/live-status.js';

const wallNow = Date.parse('2026-10-17T12:00:00.000Z');
const check = '2026-10-17T11:59:59.000Z';
const live = { transportConnected: true, now: 100_000, lastEventAt: 99_000,
  sourceConnected: true, lastSuccessfulCheckAt: check, lastSuccessfulCheckReceivedAt: 99_000, wallNow };

describe('local feed status', () => {
  it('requires both a fresh SSE signal and a successful local check', () => {
    const status = getConnectionStatus(live);
    expect(status.state).toBe('live');
    expect(status.label).toBe('Live updates');
    expect(status.isLive).toBe(true);
    expect(status.eventAgeMs).toBe(1000);
    expect(status.clockSkew).toBe(false);
    expect(status.tooltip).toContain(`Last successful local check: ${check}`);
  });
  it('starts connecting with no implied presence', () => {
    expect(getConnectionStatus({ now: 0 }).label).toBe('Connecting to local feed');
    expect(getConnectionStatus({ now: 0 }).isLive).toBe(false);
  });
  it('does not use an HTTP snapshot as proof of a live event feed', () => {
    expect(getConnectionStatus({ ...live, lastEventAt: null }).state).toBe('connecting');
    expect(getConnectionStatus({ ...live, transportConnected: false }).isLive).toBe(false);
  });
  it('shows reconnecting immediately even if the last signal is fresh', () => {
    const status = getConnectionStatus({ ...live, transportConnected: false, reconnecting: true });
    expect(status.label).toBe('Reconnecting to local feed');
    expect(status.isLive).toBe(false);
    expect(status.tooltip).toContain(check);
  });
  it('expires a silent open event stream after two heartbeats plus margin', () => {
    expect(getConnectionStatus({ ...live, now: live.lastEventAt + LOCAL_FEED_STALE_AFTER_MS }).isLive).toBe(true);
    expect(getConnectionStatus({ ...live, now: live.lastEventAt + LOCAL_FEED_STALE_AFTER_MS + 1 }).label).toBe('Local feed stale');
  });
  it('marks retained work stale when reconnecting exceeds the freshness window', () => {
    const status = getConnectionStatus({ ...live, transportConnected: false, reconnecting: true,
      now: live.lastEventAt + LOCAL_FEED_STALE_AFTER_MS + 1 });
    expect(status.state).toBe('stale');
    expect(status.isLive).toBe(false);
    expect(status.detail).toContain('Reconnecting');
    expect(status.tooltip).toContain(check);
  });
  it('reports an unreadable source even while heartbeats arrive', () => {
    const status = getConnectionStatus({ ...live, sourceConnected: false });
    expect(status.label).toBe('Local source unavailable');
    expect(status.isLive).toBe(false);
    expect(status.lastSuccessfulCheckAt).toBe(check);
  });
  it('does not reuse a stale source success just because messages arrive', () => {
    expect(getConnectionStatus({ ...live, lastSuccessfulCheckReceivedAt: 1 }).state).toBe('stale');
  });
  it('does not infer source health from an unknown source flag', () => {
    expect(getConnectionStatus({ ...live, sourceConnected: null }).isLive).toBe(false);
  });
  it('requires a valid successful-check timestamp for the evidence tooltip', () => {
    for (const stamp of [null, 'yesterday', '123', '<script>']) {
      const status = getConnectionStatus({ ...live, lastSuccessfulCheckAt: stamp });
      expect(status.isLive).toBe(false);
      expect(status.tooltip).toContain('not yet confirmed');
    }
  });
  it('uses monotonic receipt age when the source clock is ahead or behind', () => {
    for (const offset of [-3_600_000, 3_600_000]) {
      const stamp = new Date(Date.parse(check) + offset).toISOString();
      const status = getConnectionStatus({ ...live, lastSuccessfulCheckAt: stamp });
      expect(status.state).toBe('live');
      expect(status.clockSkew).toBe(true);
      expect(status.tooltip).toContain(stamp);
      expect(status.tooltip).toContain('freshness uses received heartbeats');
    }
  });
  it('does not extend liveness when the wall clock jumps after receipt', () => {
    const status = getConnectionStatus({ ...live, now: 200_000, wallNow: wallNow - 3_600_000 });
    expect(status.state).toBe('stale');
  });
  it('rejects mismatched clock origins instead of keeping future events live forever', () => {
    expect(getConnectionStatus({ ...live, lastEventAt: wallNow }).state).toBe('stale');
    expect(getConnectionStatus({ ...live, now: NaN }).isLive).toBe(false);
  });
  it('can be live while recorded work is old or quiet', () => {
    const input = { ...live, lastUpdatedAt: '2020-01-01T00:00:00Z', activeSessions: 0, workStatus: 'quiet' };
    expect(getConnectionStatus(input).state).toBe('live');
    expect(getConnectionStatus(input).tooltip).toContain('does not indicate an agent is running');
  });
  it('falls back to the documented threshold for invalid configuration', () => {
    expect(getConnectionStatus({ ...live, staleAfterMs: -1 }).staleAfterMs).toBe(35_000);
  });
});
