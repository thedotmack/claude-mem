import { createHash } from 'node:crypto';
import type { ViewerSyncStatus } from '../../shared/viewer-sync-status.js';
import { toWorkModel } from '../../ui/my-work/src/live/to-work-model.js';
import { withOwnerRuns } from '../../ui/my-work/src/live/owner-runs-model.js';
import { isCardDeliverable } from '../../ui/my-work/src/lib/deliverables.js';
import type { Request as WorkRequest } from '../../ui/my-work/src/data.js';
import { SOLO_REQUESTER, type WorkViewOverview, type WorkViewOverviewRequest, type WorkViewRequestDetail } from '../../ui/my-work/src/live/work-view-overview.js';
import type { WorkViewMediaManifest, WorkViewSnapshot as ApiSnapshot } from '../../ui/my-work/src/live/work-view-api-types.js';
import type { MediaManifest } from '../../shared/media-contract.js';
import type { WorkViewSnapshot } from './data-source.mjs';

type RawRequest = ApiSnapshot['humanRequests'][number];

/** My Work restates the media contract's manifest type (its tsconfig cannot load media-contract.ts). This line fails
 * the root typecheck when the two drift apart. */
const MEDIA_TYPES_AGREE: [MediaManifest, WorkViewMediaManifest] extends [WorkViewMediaManifest, MediaManifest] ? true : never = true;
void MEDIA_TYPES_AGREE;

/**
 * 96 bits, which is plenty for telling apart the versions of one request. It
 * rides on every card, and the overview has a 300 KiB budget for 140 requests
 * (docs/development/viewer-sync-recovery.md) that a full hash would exceed.
 */
const DETAIL_REVISION_HEX_LENGTH = 24;

/**
 * The version of what the detail drawer shows. contentFingerprint leaves out
 * generated copy and progress narratives on purpose, so a review stays valid
 * when they change, but the drawer must still reload. Hashes the recorded
 * inputs because the model's labels change with the clock, and a revision that
 * moved between the overview and the detail read would fail as a stale read.
 */
function detailRevision(request: WorkRequest, raw: RawRequest | undefined): string {
  return createHash('sha256').update(JSON.stringify([request.contentFingerprint, request.conversations,
    raw?.humanCopy, raw?.progress, raw?.activity, raw?.workstreams, raw?.workProduct, raw?.stages])).digest('hex').slice(0, DETAIL_REVISION_HEX_LENGTH);
}

/** Keep the exact fields a thread's row displays; detail-only arrays never ride a routine event. */
function compactRequest(request: WorkRequest, raw: RawRequest | undefined): WorkViewOverviewRequest {
  const products = request.workProduct.filter(isCardDeliverable);
  const { workstreams: _workstreams, granular: _granular, conversations: _conversations,
    prompts: _prompts, story: _story, evidence: _evidence, storyNarrative: _storyNarrative,
    terminal: _terminal, followUps: _followUps, review: _review, stages: _stages, canMoveFocus, askedBy, question, ...card } = request;
  const { history, ...progress } = request.progress;
  // Optional flags default to false. Keep action versions, availability and
  // explanations verbatim while avoiding repeated no-op review metadata.
  const review = request.review && (() => {
    const { conflict, pending, legacy, ...state } = request.review;
    return { ...state, ...(conflict ? { conflict } : {}), ...(pending ? { pending } : {}), ...(legacy ? { legacy } : {}) };
  })();
  return {
    ...card,
    // Readers restore these two defaults (expandWorkViewOverview).
    ...(canMoveFocus === false ? {} : { canMoveFocus }),
    ...(askedBy === SOLO_REQUESTER ? {} : { askedBy }),
    // No readings has no chart history. The field is already optional on the
    // wire; readers restore the empty array for the complete UI model.
    progress: history?.length ? request.progress : progress,
    ...(review ? { review } : {}),
    // The question rides the row; what helps answer it waits for the detail read, and the row is told only that there is some.
    ...(question ? { question: { text: question.text, ...(question.background?.length ? { hasBackground: true as const } : {}) } } : {}),
    detailLoaded: false,
    detailRevision: detailRevision(request, raw),
    detailCounts: { workProduct: products.length },
    ...(request.followUps.length ? { followUps: request.followUps } : {}),
    // A row shows a deliverable only as the thing to review; every other row's list waits for its detail read.
    workProduct: request.next.who === 'human' && request.next.need === 'review' ? products.slice(0, 1) : [],
  };
}

export function workViewOverview(snapshot: WorkViewSnapshot, now = Date.now()): WorkViewOverview {
  // The overview carries which stages are ready and the plan's state; the stage list and the proposals are read on their own.
  const model = withOwnerRuns(toWorkModel(snapshot as unknown as ApiSnapshot, now), snapshot as unknown as ApiSnapshot);
  const rawRequests = new Map((snapshot as unknown as ApiSnapshot).humanRequests.map(raw => [raw.id, raw]));
  return {
    version: 1,
    ...(snapshot.sync ? { sync: snapshot.sync as ViewerSyncStatus } : {}),
    revision: String(snapshot.revision),
    generatedAt: new Date(now).toISOString(),
    source: {
      ...snapshot.source,
      kind: typeof snapshot.source.kind === 'string' ? snapshot.source.kind : 'claude-mem-recorded-agent-activity',
      error: typeof snapshot.source.error === 'string' ? snapshot.source.error : null,
      lastCheckedAt: typeof snapshot.source.lastCheckedAt === 'string' ? snapshot.source.lastCheckedAt : null,
    },
    model: { ...model, requests: model.requests.map(request => compactRequest(request, rawRequests.get(request.id))) },
  };
}

export function workViewRequestDetail(snapshot: WorkViewSnapshot, id: string, now = Date.now()): WorkViewRequestDetail | null {
  const request = withOwnerRuns(toWorkModel(snapshot as unknown as ApiSnapshot, now), snapshot as unknown as ApiSnapshot).requests.find(request => request.id === id);
  return request ? { version: 1, revision: String(snapshot.revision), request: {
    ...request, detailLoaded: true,
    detailRevision: detailRevision(request, (snapshot as unknown as ApiSnapshot).humanRequests.find(raw => raw.id === id)),
  } } : null;
}
