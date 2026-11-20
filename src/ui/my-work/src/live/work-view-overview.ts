import type { Request } from '../data.ts'
import type { MappedWorkModel } from './work-data-source.ts'
import type { WorkViewSource } from './work-view-api-types.ts'

/** In solo mode every human request comes from the owner's own prompts. The overview leaves this default off the wire. */
export const SOLO_REQUESTER = 'You'

type DetailArray = 'workstreams' | 'granular' | 'conversations' | 'prompts' | 'story' | 'evidence' | 'terminal' | 'followUps'
export type WorkViewOverviewRequest = Omit<Request, DetailArray | 'askedBy'> & Partial<Pick<Request, DetailArray | 'askedBy'>>
export type WorkViewOverviewModel = Omit<MappedWorkModel, 'requests'> & { requests: WorkViewOverviewRequest[] }

/** Compact first-view transport. Full evidence stays behind the request-detail read. */
export interface WorkViewOverview {
  version: 1
  revision: string
  generatedAt: string
  source: WorkViewSource
  sync?: import('../../../viewer/utils/sync-presentation.js').SyncStatusForDisplay
  model: WorkViewOverviewModel
}

/** The UI still consumes its complete Request model; absent wire-only detail arrays are known to be unloaded. */
export function expandWorkViewOverview(overview: WorkViewOverview): MappedWorkModel {
  return { ...overview.model, requests: overview.model.requests.map(request => ({
    ...request, askedBy: request.askedBy ?? SOLO_REQUESTER, canMoveFocus: request.canMoveFocus ?? false,
    workstreams: request.workstreams ?? [], granular: request.granular ?? [],
    conversations: request.conversations ?? [], prompts: request.prompts ?? [],
    story: request.story ?? [], evidence: request.evidence ?? [],
    terminal: request.terminal ?? [], followUps: request.followUps ?? [],
    progress: request.progress.readings === 0 && !request.progress.history
      ? { ...request.progress, history: [] } : request.progress,
    ...(request.review ? { review: { conflict: false, pending: false, legacy: false, ...request.review } } : {}),
  })) }
}

export interface WorkViewRequestDetail {
  version: 1
  revision: string
  request: Request
}
