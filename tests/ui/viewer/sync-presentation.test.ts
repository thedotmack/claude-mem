import { describe, expect, test } from 'bun:test';
import { isSyncStatus, presentSync, type SyncStatusForDisplay } from '../../../src/ui/viewer/utils/sync-presentation.ts';

export const current = (): SyncStatusForDisplay => ({
  configured: true, state: 'current', mode: 'polling', observedAt: 100_000, checkedAt: 99_000,
  message: 'Shared records are current with the last confirmed cloud check.', download: { lastSuccessAt: 99_000 },
  projection: { remaining: '0' },
  completeness: { pushQuarantine: 0, pullQuarantine: 0, excludedNative: 0, scope: 'eligible' },
});

describe('sync evidence presentation', () => {
  test('a connected feed without sync evidence never means cloud current', () => {
    expect(presentSync(null, null, 1).state).toBe('unknown');
    expect(presentSync(null, null, 1).isCurrent).toBe(false);
  });
  test('uses decimal strings without rounding and names the actual mode', () => {
    const status = current();
    status.state = 'catching-up';
    status.projection.remaining = '18446744073709551615';
    const shown = presentSync(status, 5000, 6000);
    expect(shown.detail).toContain('18446744073709551615');
    expect(shown.detail).toContain('HTTP polling');
    expect(shown.isCurrent).toBe(false);
  });
  test('expires old evidence using monotonic receipt time despite different server clocks', () => {
    const status = current();
    expect(presentSync(status, 1000, 1000).state).toBe('current');
    expect(presentSync(status, 1000, 60_000).state).toBe('current');
    expect(presentSync(status, 1000, 60_001).state).toBe('stale');
    status.observedAt += 500_000_000;
    status.checkedAt! += 500_000_000;
    status.download!.lastSuccessAt! += 500_000_000;
    expect(presentSync(status, 1000, 60_001).state).toBe('stale');
  });
  test('keeps failures distinct from limited historical scope', () => {
    const status = current();
    status.state = 'partial';
    status.completeness.scope = 'local-history-excluded';
    status.completeness.excludedNative = 50;
    expect(presentSync(status, 0, 0).label).toBe('Limited sync scope');
    status.completeness.pullQuarantine = 1;
    expect(presentSync(status, 0, 0).label).toBe('Cloud sync incomplete');
    status.state = 'offline';
    expect(presentSync(status, 0, 100_000).state).toBe('offline');
  });
  test('fresh matching hub evidence can confirm quiet realtime after an older completed pull', () => {
    const status = current();
    status.mode = 'realtime';
    status.download!.lastSuccessAt = 1;
    const shown = presentSync(status, 0, 10);
    expect(shown.state).toBe('current');
    expect(shown.detail).toContain('realtime');
    status.download!.lastSuccessAt = null;
    expect(presentSync(status, 0, 10).state).toBe('unknown');
  });
  test('rejects malformed metadata and impossible clock evidence', () => {
    expect(isSyncStatus(current())).toBe(true);
    expect(isSyncStatus({ ...current(), state: 'green' })).toBe(false);
    expect(isSyncStatus({ ...current(), observedAt: Infinity })).toBe(false);
    const status = current();
    status.checkedAt = status.observedAt + 1;
    status.download!.lastSuccessAt = status.observedAt + 1;
    expect(presentSync(status, 0, 0).state).toBe('unknown');
  });
});
