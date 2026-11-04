import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { workViewOverview, workViewRequestDetail } from '../../../src/services/work-view/overview.js';
import type { WorkViewSnapshot } from '../../../src/services/work-view/data-source.mjs';

const fixture = () => JSON.parse(readFileSync(new URL('../../../src/ui/my-work/test-fixtures/work-view-snapshot.trimmed.json', import.meta.url), 'utf8')) as WorkViewSnapshot;

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
    expect(summary.terminal).toEqual(detail.request.title ? [] : detail.request.terminal.slice(-4));
    expect(JSON.stringify(snapshot)).toBe(original);
    expect(workViewRequestDetail(snapshot, 'missing')).toBeNull();
  });

  it('keeps a 140-request overview under 300 KiB despite large detail arrays', () => {
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
    const overview = workViewOverview(snapshot);
    expect(overview.model.requestReadErrors).toEqual([]);
    expect(overview.model.requests).toHaveLength(140);
    expect(Buffer.byteLength(JSON.stringify(snapshot))).toBeGreaterThan(5_000_000);
    expect(Buffer.byteLength(JSON.stringify(overview))).toBeLessThanOrEqual(300 * 1024);
    expect(overview.model.requests.every(request => request.workProduct.length <= 3)).toBe(true);
    expect(overview.model.requests[0].detailCounts?.workProduct).toBe(40);
  });
});
