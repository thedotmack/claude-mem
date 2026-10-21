// Types for GET /api/work-view on the local worker (claude-mem 15.0.1), written from a real response
// (.scratch/work-view-sample.json). Only the keys the mapper reads are typed; the rest are left out on purpose.

export type EvidenceKind = 'work-state' | 'observation' | 'prompt' | 'summary' | 'session'

export interface WorkViewSourceRef { kind: string; id: number }

export interface WorkViewTextField { text: string; source: string; sourceId: number }

/** One recorded record under a request: a work-state task or a session request found in memory. */
export interface WorkViewItem {
  id: string
  kind: 'work-state' | 'session-request'
  title: string
  status: string
  nextStep: WorkViewTextField | null
  lastUpdateEpoch: number
  sourceRefs: WorkViewSourceRef[]
  url: string
}

export interface WorkViewActivity {
  id: string
  kind: 'work-state' | 'observation'
  title: string
  detail: string | null
  atEpoch: number
  url: string
}

export interface WorkViewWorkstream {
  id: string
  title: string
  items: WorkViewItem[]
}

export interface WorkViewHumanCopy {
  state: 'current' | 'outdated' | 'pending' | string
  title?: string
  summary?: string
  next?: string
  /** Free text from the title writer. Shown only as hover text, never as the stage. */
  stage?: string
  workstreams?: { id: string; title?: string; summary?: string }[]
  generatedAt?: number
}

export interface WorkViewLifecycle {
  status: string | null
  explicit: boolean
  complete?: boolean | null
  url?: string
}

export interface WorkViewPrompt { text: string; atEpoch?: number; url?: string }

export interface WorkViewReview { checked: boolean; checkedAtEpoch: number | null; available: boolean }

export interface WorkViewHumanRequest {
  id: string
  contentFingerprint: string
  title: string
  original: WorkViewPrompt
  scopeUpdates: WorkViewPrompt[]
  humanCopy: WorkViewHumanCopy | null
  lifecycle: WorkViewLifecycle | null
  items: WorkViewItem[]
  workstreams: WorkViewWorkstream[]
  activity: WorkViewActivity[]
  agentIds: string[]
  conversationKeys: string[]
  requestedBy: string | null
  startedAtEpoch: number | null
  completedAtEpoch: number | null
  updatedAtEpoch: number | null
  review: WorkViewReview | null
}

export interface WorkViewAgent {
  id: string
  label: string
  platformSource: string | null
  sessionTitle: string | null
  project: string | null
  contentSessionId: string | null
}

export interface WorkViewSource {
  kind: string
  connected: boolean
  error: string | null
  lastCheckedAt: string | null
}

export interface WorkViewSnapshot {
  version: number
  generatedAt: string
  agents: WorkViewAgent[]
  humanRequests: WorkViewHumanRequest[]
  unlinkedWork: unknown[]
  source: WorkViewSource
  revision: string
}
