import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  isSyncStatus, presentSync, SYNC_MODE_SENTENCES, SYNC_REMAINING_SENTENCE, SYNC_VIEWER_SENTENCES, type SyncStatusForDisplay,
} from '../../../src/ui/viewer/utils/sync-presentation.ts';
import { viewerZh } from '../../../src/ui/i18n/viewer-zh.ts';
import { viewerKo } from '../../../src/ui/i18n/viewer-ko.ts';
import { viewerFr } from '../../../src/ui/i18n/viewer-fr.ts';

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
  test('keeps the detail\'s parts, so the header can say each sentence in the reader\'s language', () => {
    const status = current();
    status.state = 'catching-up';
    status.mode = 'realtime';
    status.projection.remaining = '42';
    status.message = 'Cloud updates are being synchronized.';
    expect(presentSync(status, 5000, 6000).detailParts).toEqual({ sentence: 'Cloud updates are being synchronized.', mode: 'realtime', remaining: '42' });
    // The English detail is built from the same sentences the header translates (one definition each).
    expect(presentSync(status, 5000, 6000).detail).toBe('Cloud updates are being synchronized. Mode: realtime with HTTP recovery. Changes remaining: 42.');
    expect(presentSync(null, null, 1).detailParts).toEqual({ sentence: SYNC_VIEWER_SENTENCES.notReported, mode: null, remaining: null });
  });
  test('every sentence the sync detail can hold has a translation in each viewer catalog', () => {
    // The worker writes its sentences in src/shared/viewer-sync-status.ts: the default message and each state('…', '…').
    const worker = readFileSync(new URL('../../../src/shared/viewer-sync-status.ts', import.meta.url), 'utf8');
    const workerSentences = [...worker.matchAll(/state\('[\w-]+', '([^']+)'\)|message: '([^']+)'/g)].map(match => match[1] ?? match[2]);
    expect(workerSentences.length).toBeGreaterThanOrEqual(12);
    const sentences = [...workerSentences, ...Object.values(SYNC_VIEWER_SENTENCES), ...Object.values(SYNC_MODE_SENTENCES), SYNC_REMAINING_SENTENCE];
    for (const catalog of [viewerZh, viewerKo, viewerFr]) {
      expect(sentences.filter(sentence => !(sentence in catalog))).toEqual([]);
    }
  });
});
