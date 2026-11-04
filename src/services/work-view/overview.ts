import { toWorkModel } from '../../ui/my-work/src/live/to-work-model.js';
import { isCardDeliverable } from '../../ui/my-work/src/lib/deliverables.js';
import type { Request as WorkRequest } from '../../ui/my-work/src/data.js';
import type { WorkViewOverview, WorkViewOverviewRequest, WorkViewRequestDetail } from '../../ui/my-work/src/live/work-view-overview.js';
import type { WorkViewSnapshot as ApiSnapshot } from '../../ui/my-work/src/live/work-view-api-types.js';
import type { WorkViewSnapshot } from './data-source.mjs';

/** Keep the exact fields the cards display; detail-only arrays never ride a routine event. */
function compactRequest(request: WorkRequest): WorkViewOverviewRequest {
  const products = request.workProduct.filter(isCardDeliverable);
  const { workstreams: _workstreams, granular: _granular, conversations: _conversations,
    prompts: _prompts, story: _story, evidence: _evidence, storyNarrative: _storyNarrative, ...card } = request;
  return {
    ...card,
    detailLoaded: false,
    detailCounts: { workProduct: products.length },
    terminal: request.title ? [] : request.terminal.slice(-4),
    workProduct: products.slice(0, 3),
  };
}

export function workViewOverview(snapshot: WorkViewSnapshot, now = Date.now()): WorkViewOverview {
  const model = toWorkModel(snapshot as unknown as ApiSnapshot, now);
  return {
    version: 1,
    revision: String(snapshot.revision),
    generatedAt: new Date(now).toISOString(),
    source: {
      ...snapshot.source,
      kind: typeof snapshot.source.kind === 'string' ? snapshot.source.kind : 'claude-mem-recorded-agent-activity',
      error: typeof snapshot.source.error === 'string' ? snapshot.source.error : null,
      lastCheckedAt: typeof snapshot.source.lastCheckedAt === 'string' ? snapshot.source.lastCheckedAt : null,
    },
    model: { ...model, requests: model.requests.map(compactRequest) },
  };
}

export function workViewRequestDetail(snapshot: WorkViewSnapshot, id: string, now = Date.now()): WorkViewRequestDetail | null {
  const request = toWorkModel(snapshot as unknown as ApiSnapshot, now).requests.find(request => request.id === id);
  return request ? { version: 1, revision: String(snapshot.revision), request: {
    ...request, detailLoaded: true, detailRevision: request.contentFingerprint,
  } } : null;
}
