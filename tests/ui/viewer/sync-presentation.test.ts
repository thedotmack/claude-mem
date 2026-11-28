import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  isSyncStatus, presentSync, syncDetailWords, SYNC_LIMITED_SCOPE_LABEL, SYNC_MODE_SENTENCES, SYNC_REMAINING_SENTENCE, SYNC_STATE_LABELS, SYNC_VIEWER_SENTENCES,
  type SyncStatusForDisplay,
} from '../../../src/ui/viewer/utils/sync-presentation.ts';
import { viewerZh } from '../../../src/ui/i18n/viewer-zh.ts';
import { viewerKo } from '../../../src/ui/i18n/viewer-ko.ts';
import { viewerFr } from '../../../src/ui/i18n/viewer-fr.ts';
import { myworkZh } from '../../../src/ui/i18n/mywork-zh.ts';
import { myworkKo } from '../../../src/ui/i18n/mywork-ko.ts';
import { myworkTr } from '../../../src/ui/i18n/mywork-tr.ts';
import { myworkFr } from '../../../src/ui/i18n/mywork-fr.ts';

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
  // My Work's Machine and sync shows how many records wait to upload, as the worker counted them; never a guess.
  test('carries the records waiting to upload when the worker counted them, and none otherwise', () => {
    expect(presentSync({ ...current(), upload: { pending: 3 } }, 1000, 1000).pendingUpload).toBe(3);
    expect(presentSync({ ...current(), upload: { pending: 0 } }, 1000, 1000).pendingUpload).toBe(0);
    expect(presentSync(current(), 1000, 1000).pendingUpload).toBeNull();
    expect(presentSync({ ...current(), upload: { pending: -1 } }, 1000, 1000).pendingUpload).toBeNull();
    expect(presentSync({ ...current(), configured: false, state: 'unconfigured', upload: { pending: 3 } }, 1000, 1000).pendingUpload).toBeNull();
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
  // One rule joins the detail's sentences (Phase 6 fix AP-M2: My Work had copied the classic viewer's line for line).
  test('syncDetailWords says each sentence of the detail in the reader\'s words, and both headers take it from here', () => {
    const status = current();
    status.state = 'catching-up';
    status.mode = 'realtime';
    status.projection.remaining = '42';
    status.message = 'Cloud updates are being synchronized.';
    const shown = presentSync(status, 5000, 6000);
    const marked = (english: string) => `«${english}»`;
    expect(syncDetailWords(shown, marked)).toBe('«Cloud updates are being synchronized.» «Mode: realtime with HTTP recovery.» «Changes remaining: 42.»');
    // English is the same rule with no translation: the presentation's own detail.
    expect(syncDetailWords(shown, (english) => english)).toBe(shown.detail);
    // A translation keeps the count wherever its language puts it.
    expect(syncDetailWords(shown, (english) => english === SYNC_REMAINING_SENTENCE ? '還有 {count} 項變更。' : english)).toContain('還有 42 項變更。');
    // Built elsewhere without its parts: the English detail as it is.
    expect(syncDetailWords({ detail: 'As written.' }, marked)).toBe('As written.');
    // Neither the classic viewer's header nor My Work's Machine and sync keeps a copy of the rule.
    for (const path of ['../../../src/ui/viewer/components/Header.tsx', '../../../src/ui/my-work/src/pages/machine-sync.tsx']) {
      const source = readFileSync(new URL(path, import.meta.url), 'utf8');
      expect({ path, copy: /function syncDetailWords\b/.test(source), imports: /import \{[^}]*\bsyncDetailWords\b[^}]*\} from '[^']*sync-presentation'/.test(source) })
        .toEqual({ path, copy: false, imports: true });
    }
  });
  test('every sentence the sync detail can hold has a translation in each viewer catalog', () => {
    for (const catalog of [viewerZh, viewerKo, viewerFr]) {
      expect(syncSentences().filter(sentence => !(sentence in catalog))).toEqual([]);
    }
  });
  // My Work's Machine and sync words the label and each detail sentence by t() (pages/machine-sync.tsx), and Turkish
  // reads My Work's catalog alone, so each My Work catalog holds them all, in the classic viewer's words.
  test('every label and sentence of the sync detail has a translation in each My Work catalog, the same as the viewer’s', () => {
    const words = [...Object.values(SYNC_STATE_LABELS), SYNC_LIMITED_SCOPE_LABEL, ...syncSentences()];
    for (const [name, catalog] of Object.entries({ myworkZh, myworkKo, myworkTr, myworkFr })) {
      expect({ name, missing: words.filter(sentence => !(sentence in catalog)) }).toEqual({ name, missing: [] });
    }
    for (const [mywork, viewer] of [[myworkZh, viewerZh], [myworkKo, viewerKo], [myworkFr, viewerFr]]) {
      expect(words.filter(sentence => mywork[sentence] !== viewer[sentence])).toEqual([]);
    }
  });
});

/** Every sentence the sync detail can hold: the worker's own (src/shared/viewer-sync-status.ts: the default message and
 * each state('…', '…')), then this file's state, mode and remaining sentences. */
function syncSentences(): string[] {
  const worker = readFileSync(new URL('../../../src/shared/viewer-sync-status.ts', import.meta.url), 'utf8');
  const workerSentences = [...worker.matchAll(/state\('[\w-]+', '([^']+)'\)|message: '([^']+)'/g)].map(match => match[1] ?? match[2]);
  expect(workerSentences.length).toBeGreaterThanOrEqual(12);
  return [...workerSentences, ...Object.values(SYNC_VIEWER_SENTENCES), ...Object.values(SYNC_MODE_SENTENCES), SYNC_REMAINING_SENTENCE];
}
