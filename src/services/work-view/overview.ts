import { createHash } from 'node:crypto';
import type { ViewerSyncStatus } from '../../shared/viewer-sync-status.js';
import { toWorkModel } from '../../ui/my-work/src/live/to-work-model.js';
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
    raw?.humanCopy, raw?.progress, raw?.activity, raw?.workstreams, raw?.workProduct])).digest('hex').slice(0, DETAIL_REVISION_HEX_LENGTH);
}

/**
 * The suggestion as a card carries it: everything the card and its actions use, without the judge's score. Only the
 * drawer words the score (as a percent), and it reads it from the request detail; the 140-request overview budget
 * protects the live transport, and one number per suggestion took it over (2 bytes, Phase 5 quality review).
 */
function cardSuggestion(suggestion: WorkRequest['suggestion']): WorkRequest['suggestion'] {
  if (!suggestion) return undefined;
  const { confidence: _confidence, ...onTheCard } = suggestion;
  return onTheCard;
}

/** Keep the exact fields the cards display; detail-only arrays never ride a routine event. */
function compactRequest(request: WorkRequest, raw: RawRequest | undefined): WorkViewOverviewRequest {
  const products = request.workProduct.filter(isCardDeliverable);
  const { workstreams: _workstreams, granular: _granular, conversations: _conversations,
    prompts: _prompts, story: _story, evidence: _evidence, storyNarrative: _storyNarrative,
    terminal: _terminal, followUps: _followUps, review: _review, suggestion, canMoveFocus, askedBy, ...card } = request;
  const terminal = request.title ? [] : request.terminal.slice(-4);
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
    ...(suggestion ? { suggestion: cardSuggestion(suggestion) } : {}),
    detailLoaded: false,
    detailRevision: detailRevision(request, raw),
    detailCounts: { workProduct: products.length },
    ...(terminal.length ? { terminal } : {}),
    ...(request.followUps.length ? { followUps: request.followUps } : {}),
    workProduct: products.slice(0, 3),
  };
}

function overviewFromModel(snapshot: WorkViewSnapshot, now: number, model: ReturnType<typeof toWorkModel>, rawRequests: Map<string, RawRequest>): WorkViewOverview {
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

export function workViewOverview(snapshot: WorkViewSnapshot, now = Date.now()): WorkViewOverview {
  const raw = snapshot as unknown as ApiSnapshot;
  return overviewFromModel(snapshot, now, toWorkModel(raw, now), new Map(raw.humanRequests.map(r => [r.id, r])));
}

/** Persist the overview and each drawer from a single mapping pass at the same revision. */
export function projectWorkView(snapshot: WorkViewSnapshot, now: number) {
  const raw = snapshot as unknown as ApiSnapshot;
  const model = toWorkModel(raw, now);
  const requests = new Map(raw.humanRequests.map(r => [r.id, r]));
  return {
    overview: overviewFromModel(snapshot, now, model, requests),
    details: model.requests.map(request => ({
      id: request.id, detail: {
        version: 1 as const, revision: String(snapshot.revision), request: {
          ...request, detailLoaded: true, detailRevision: detailRevision(request, requests.get(request.id)),
        },
      },
    })),
  };
}

export function workViewRequestDetail(snapshot: WorkViewSnapshot, id: string, now = Date.now()): WorkViewRequestDetail | null {
  const request = toWorkModel(snapshot as unknown as ApiSnapshot, now).requests.find(request => request.id === id);
  return request ? { version: 1, revision: String(snapshot.revision), request: {
    ...request, detailLoaded: true,
    detailRevision: detailRevision(request, (snapshot as unknown as ApiSnapshot).humanRequests.find(raw => raw.id === id)),
  } } : null;
}
