import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { workViewOverview, workViewRequestDetail } from '../../../src/services/work-view/overview.js';
import { Database } from 'bun:sqlite';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { sharedReviewDescriptor, readSharedReview } from '../../../src/services/work-view/shared-reviews.mjs';
import { sharedRecordKey } from '../../../src/services/work-view/shared-records.mjs';
import { toWorkModel } from '../../../src/ui/my-work/src/live/to-work-model.js';
import { expandWorkViewOverview } from '../../../src/ui/my-work/src/live/work-view-overview.js';
import type { WorkViewSnapshot } from '../../../src/services/work-view/data-source.mjs';

const fixture = () => JSON.parse(readFileSync(new URL('../../../src/ui/my-work/test-fixtures/work-view-snapshot.trimmed.json', import.meta.url), 'utf8')) as WorkViewSnapshot;

function largeSnapshot() {
  const snapshot = fixture();
  const seed = snapshot.humanRequests[0] as any;
  snapshot.humanRequests = Array.from({ length: 140 }, (_, id) => ({
    ...structuredClone(seed), id: `request-${id}`, contentFingerprint: id.toString(16).padStart(64, '0'),
    activity: Array.from({ length: 80 }, (_, index) => ({
      ...seed.activity[0], id: `activity-${index}`, title: 'A recorded result', detail: 'Long recorded details. '.repeat(20),
    })),
    scopeUpdates: Array.from({ length: 25 }, () => ({ ...seed.original, text: 'A long source prompt. '.repeat(100) })),
    workProduct: Array.from({ length: 40 }, (_, index) => ({ kind: 'pull-request', title: `Published output ${index}`, url: `https://example.test/pull/${index}` })),
  }));
  return snapshot;
}

describe('compact work view transport', () => {
  it('keeps card state and exact fingerprints while moving full evidence to detail', () => {
    const snapshot = fixture();
    snapshot.revision = '7:review:copy';
    snapshot.humanRequests[0].contentFingerprint = 'a'.repeat(64);
    const original = JSON.stringify(snapshot);
    const overview = workViewOverview(snapshot);
    const summary = overview.model.requests[0];
    const detail = workViewRequestDetail(snapshot, summary.id)!;
    expect(summary).toMatchObject({ id: detail.request.id, contentFingerprint: detail.request.contentFingerprint,
      state: detail.request.state, progress: detail.request.progress, detailLoaded: false });
    expect(summary.granular).toBeUndefined();
    expect(summary.prompts).toBeUndefined();
    expect(summary.workstreams).toBeUndefined();
    expect(detail.request.detailLoaded).toBe(true);
    expect(detail.request.prompts.length).toBeGreaterThan(0);
    expect(expandWorkViewOverview(overview).requests[0].terminal).toEqual(detail.request.title ? [] : detail.request.terminal.slice(-4));
    expect(JSON.stringify(snapshot)).toBe(original);
    expect(workViewRequestDetail(snapshot, 'missing')).toBeNull();
  });

  it('keeps a 140-request overview under 300 KiB despite large detail arrays', () => {
    const snapshot = largeSnapshot();
    const overview = workViewOverview(snapshot);
    expect(overview.model.requestReadErrors).toEqual([]);
    expect(overview.model.requests).toHaveLength(140);
    expect(Buffer.byteLength(JSON.stringify(snapshot))).toBeGreaterThan(5_000_000);
    expect(Buffer.byteLength(JSON.stringify(overview))).toBeLessThanOrEqual(300 * 1024);
    expect(overview.model.requests.every(request => request.workProduct.length <= 3)).toBe(true);
    expect(overview.model.requests[0].detailCounts?.workProduct).toBe(40);
  });

  it('keeps real shared review enrichment and suggestion action versions within the 140-request budget', () => {
    const snapshot = largeSnapshot();
    snapshot.sharedState = { enabled: true, complete: false, pendingLocalMaterialization: true };
    const database = new Database(':memory:');
    const store = new SessionStore(database);
    try {
      snapshot.humanRequests.forEach((request: any, index) => {
        request.title = 'Release review '.repeat(8).slice(0, 100);
        request.humanCopy = { ...request.humanCopy, state: 'current', title: request.title,
          summary: 'A recorded release summary. '.repeat(10).slice(0, 240),
          next: 'Review the recorded release evidence. '.repeat(5).slice(0, 160),
          stage: 'Review the complete release evidence now.' };
        request.progress = null;
        request.workProduct = request.workProduct.map((product: any, productIndex: number) => ({ ...product,
          title: 'Published release documentation '.repeat(5).slice(0, 125),
          url: `https://example.com/published/${'a'.repeat(58)}/${productIndex}` }));
        const id = store.appendWorkStateEntry({ project: 'overview-fixture', listName: `request-${index}`,
          fields: { task: 'Review the release', status: 'done', narrative: 'The full source evidence is retained.' }, createdAtEpoch: 1_793_491_200_000 });
        request.explicitRequestId = `release-${index}`;
        request.original = { text: 'Review the release', source: 'work-state', sourceId: id, atEpoch: 1_793_491_200_000 };
        request.agentIds = [];
        request.scopeUpdates = request.scopeUpdates.map((prompt: any) => ({ text: prompt.text, atEpoch: prompt.atEpoch }));
        request.items = [{ id: `item-${index}`, kind: 'work-state', title: 'Review the release', status: 'done', url: `/api/work-view/evidence/work-state/${id}`, sourceRefs: [{ kind: 'work-state', id }] }];
        request.lifecycle = { explicit: true, complete: true, status: 'done' };
        request.sourceContentHashes = [{ kind: 'work-state', id }];
        const descriptor = sharedReviewDescriptor(database, request, { deviceId: 'origin' });
        expect(descriptor.complete).toBe(true);
        const record = { kind: 'review', key: descriptor.requestId, hash: descriptor.fingerprint, writer: 'origin',
          value: { version: descriptor.version, requestId: descriptor.requestId, fingerprint: descriptor.fingerprint, checked: index % 2 === 0, checkedAtEpoch: 1_793_491_200_001 } };
        const state = { records: new Map([[sharedRecordKey('review', descriptor.requestId), record]]), diagnostics: {
          conflicts: [{ kind: 'review', key: descriptor.requestId }],
        } } as any;
        request.sharedReviewDescriptor = descriptor;
        request.sharedReview = readSharedReview(state, descriptor);
        request.contentFingerprint = descriptor.fingerprint;
        request.review = { ...request.sharedReview, pending: index % 3 === 0, legacy: false };
        if (index % 7 === 0) request.suggestion = { conversationKey: JSON.stringify(['conversation', 'claude', `session-${index}`]), requestId: `g_${index.toString(16).padStart(12, '0')}`,
          requestTitle: 'Related release request', confidence: 0.8, evidence: 'These requests concern the same release.', judge: 'fixture', at: null,
          expectedSuggestionHash: descriptor.fingerprint, sharedConflict: index % 14 === 0 };
      });
      const overview = workViewOverview(snapshot, 1_793_491_200_002);
      expect(overview.model.requestReadErrors).toEqual([]);
      expect(overview.model.requests).toHaveLength(140);
      expect(overview.model.sharedState).toMatchObject({ complete: false, pendingLocalMaterialization: true });
      expect(Buffer.byteLength(JSON.stringify(overview))).toBeLessThanOrEqual(300 * 1024);
      const details = new Map(toWorkModel(snapshot as any, 1_793_491_200_002).requests.map(request => [request.id, request]));
      for (const summary of overview.model.requests) {
        const detail = details.get(summary.id)!;
        expect(summary.review).toMatchObject({ mode: 'shared', hash: detail.review!.hash, version: 2, available: true });
        expect(Boolean(summary.review?.conflict)).toBe(Boolean(detail.review?.conflict));
        expect(Boolean(summary.review?.pending)).toBe(Boolean(detail.review?.pending));
        expect(summary.review?.message).toBe(detail.review?.message);
        expect(summary.review?.legacy).toBeUndefined();
        expect(summary.suggestion).toEqual(detail.suggestion);
      }
      expect(expandWorkViewOverview(overview).requests.every(request => Array.isArray(request.terminal) && Array.isArray(request.followUps))).toBe(true);
    } finally { database.close(); }
  });

  it('preserves unavailable reviews and incomplete work while restoring omitted false flags and empty arrays', () => {
    const snapshot = fixture();
    snapshot.humanRequests[0].lifecycle = { explicit: true, complete: false, status: 'in-progress' };
    snapshot.humanRequests[0].review = { checked: false, checkedAtEpoch: null, actor: null, available: false,
      mode: 'shared', hash: null, version: 2, conflict: false, legacy: false, pending: false, message: 'Full evidence is unavailable.' };
    const overview = workViewOverview(snapshot);
    const wire = overview.model.requests[0];
    expect(wire.review).toMatchObject({ available: false, hash: null, mode: 'shared' });
    expect(wire.review?.conflict).toBeUndefined();
    expect(wire.review?.pending).toBeUndefined();
    expect(wire.review?.legacy).toBeUndefined();
    expect(wire.terminal).toBeUndefined();
    expect(wire.followUps).toBeUndefined();
    const expanded = expandWorkViewOverview(overview).requests[0];
    expect(expanded.state).not.toBe('needs-check');
    expect(expanded.review).toMatchObject({ available: false, hash: null, mode: 'shared', version: 2,
      conflict: false, pending: false, legacy: false, message: 'Full evidence is unavailable.' });
    expect(expanded.terminal).toEqual([]);
    expect(expanded.followUps).toEqual([]);
  });
});
