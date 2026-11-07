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
  /** When the explicit status was recorded. A review older than this does not override it. */
  atEpoch?: number | null
}

export interface WorkViewPrompt { text: string; atEpoch?: number; url?: string }

export interface WorkViewReview { checked: boolean; checkedAtEpoch: number | null; available: boolean }

/** A request-progress memory review of one overall request (request-groups.mjs `record-progress`). */
export interface WorkViewProgress {
  state: 'shipped' | 'in-progress' | 'stalled' | 'abandoned' | 'unknown'
  percent: number
  summary: string
  narrative: string
  milestones: { at: string | null; text: string }[]
  /** ISO time the review was recorded. */
  checkedAt: string
  /** ISO time the work shipped; set only when state is shipped. */
  shippedAt?: string | null
  /** Every review's percent, oldest first; files from before readings existed carry one. */
  readings: { at: string; percent: number }[]
}

/** One thing a request produced (work-product.mjs). Git kinds carry the sha or branch; `url` is absent when there is
 * nothing to open, and `available` is false for a recorded local file that no longer exists. */
export interface WorkViewWorkProduct {
  kind: string
  title: string
  url?: string
  fileUrl?: string | null
  available?: boolean
  sha?: string
  branch?: string | null
  /** A copy the Stop hook put in the project's deliverables bucket (~/.claude-mem/deliverables/<project>/); `url` opens it. Older workers leave it out. */
  deliverable?: boolean
  sourcePath?: string | null
}

/** The build story request-progress last wrote. */
export interface WorkViewBuildStory { narrative: string; writtenAt: string | null }

/** The judge's "Looks like part of <request>" for one conversation (request-judge.mjs), waiting for the owner's
 * Join / Not this (POST /api/work-view/suggestions `{ conversationKey, action: 'join' | 'not-this' }`). */
export interface WorkViewRequestSuggestion {
  conversationKey: string
  /** The suggested request's group id and title. */
  requestId: string
  requestTitle: string
  /** The judge's check score, between the suggest and join thresholds. */
  confidence: number
  evidence: string
  judge: string
  at: string | null
}

export interface WorkViewHumanRequest {
  id: string
  contentFingerprint: string
  title: string
  groupId?: string | null
  titleSource?: 'request-group' | 'title-cache' | 'explicit-work-state-request' | 'original-human-request'
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
  /** The last memory review; null when its group has none. Older workers leave it out. */
  progress?: WorkViewProgress | null
  /** Newest first. Older workers leave it out. */
  workProduct?: WorkViewWorkProduct[]
  /** The conversation its my-focus placement is keyed by: its group's anchor, else its own. Older workers leave it out. */
  anchorConversationKey?: string | null
  /** A focus area id, 'other', or absent while it is not sorted yet. Older workers leave it out. */
  focusAreaId?: string
  /** The judge thinks this conversation is part of another request; absent when there is nothing to ask. Older workers leave it out. */
  suggestion?: WorkViewRequestSuggestion
}

export interface WorkViewAgent {
  id: string
  label: string
  /** Older workers leave these out. `presence.status` is 'finished' only on a recorded stop. */
  isSubagent?: boolean
  canMarkFinished?: boolean
  presence?: { status: string; finishedAt?: string | null; evidence?: string }
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

/** What one owner-goals item is (owner-goals.mjs GOAL_KINDS). Rows saved as priorities or open asks are read as these. */
export type WorkViewGoalKind = 'focus-area' | 'ask'

/** One owner-goals item. The worker already parsed `evidence` into quotes; `at` is `YYYY-MM-DD HH:MM`, a bare day, or null. */
export interface WorkViewGoalItem {
  id: string
  task: string
  kind: WorkViewGoalKind
  rank: number | null
  title: string
  /** A focus area's one-sentence goal. */
  goal: string | null
  /** An ask's focus area, by the name it was mined with. */
  focusArea: string | null
  /** The my-focus id: an ask's area, or a focus area's own. */
  focusAreaId: string | null
  /** Only on items saved before the three tests (2026-10-27). */
  product: string | null
  latestAt: string | null
  timesAsked: number | null
  status: string
  evidence: { at: string | null; quote: string }[]
}

/** One owner-goals list: the current month (`history: false`) or a saved past month (`owner-goals/<start>`). */
export interface WorkViewGoalList {
  listId: string
  listName: string
  history: boolean
  project: string
  updatedAt: string
  periodStart: string | null
  /** Exclusive: the next month starts on this day. */
  periodEnd: string | null
  summary: string | null
  generatedAt: string | null
  windowDays: number | null
  sourcePromptCount: number | null
  mapPath: string | null
  areas: WorkViewGoalItem[]
  asks: WorkViewGoalItem[]
}

/** One rule: a story suggestion, laid over by its saved my-rules row, or one the owner wrote. */
export interface WorkViewRule {
  ruleId: string
  scopeId: string
  scopeTier: 'everywhere' | 'project' | 'situation'
  scopeName: string
  /** Empty when the rule is one sentence (learned preferences are). */
  when: string
  then: string
  setBy: 'owner' | 'approved' | 'learned'
  status: 'on' | 'off' | 'suggested' | 'replaced' | 'dismissed'
  kind: string
  source: string
  timesSeen: number
  /** ISO time of the latest quote or save; null when not recorded. */
  latestAt: string | null
  /** `at` is ISO or null. */
  quotes: { at: string | null; quote: string; kind: string }[]
  replacedBy: string | null
  replacedAt: string | null
  savedAt: string | null
}

/** One focus area from the my-focus list. Merged and dismissed areas are included; the viewer decides what to show. */
export interface WorkViewFocusArea {
  focusAreaId: string
  name: string
  /** One sentence saying what the area is for. */
  goal: string | null
  /** What belongs in the area, beyond its goal. Older workers leave it out. */
  about?: string | null
  status: 'suggested' | 'kept' | 'dismissed' | 'done'
  priorityRank: number | null
  /** The owner's order; when set it wins over priorityRank. */
  ownerRank: number | null
  source: 'owner-goals' | 'clustering' | 'promotion' | 'seed' | 'owner'
  /** Set when merged: its requests show under this area. */
  mergedInto: string | null
  evidence: string | null
  /** 'owner-restore': the owner handed it back to suggestions, so refreshes may update it again. */
  decidedBy: 'owner' | 'system' | 'owner-restore'
  savedAt: string | null
}

export interface WorkViewRuleScope { id: string; tier: 'everywhere' | 'project' | 'situation'; name: string }

/** What the last request-progress story found; null when it has not run. */
export interface WorkViewRulesLearning { preferencesFound: number; newSuggestions: number; reviewsRead: number; writtenAt: string | null }

/** ~/.claude-mem/MY-RULES.md, and whether ~/.claude/CLAUDE.md imports it. */
export interface WorkViewRulesFile { path: string; instructionsPath?: string; approvedCount: number; loadedInClaudeCode: boolean }

export interface WorkViewSnapshot {
  version: number
  generatedAt: string
  agents: WorkViewAgent[]
  humanRequests: WorkViewHumanRequest[]
  unlinkedWork: unknown[]
  source: WorkViewSource
  revision: string
  /** The current owner-goals run; null until the owner-goals skill has run. Older workers leave it out. */
  goals?: WorkViewGoalList | null
  /** Saved past months, newest first. */
  goalHistory?: WorkViewGoalList[]
  /** My Rules. Older workers leave these out. */
  rules?: WorkViewRule[]
  ruleScopes?: WorkViewRuleScope[]
  rulesLearning?: WorkViewRulesLearning | null
  rulesFile?: WorkViewRulesFile
  /** My Focus, in priority order. Older workers leave it out. */
  focusAreas?: WorkViewFocusArea[]
  /** request-progress reviews and the build story; null when the ledger is empty. Older workers leave it out. */
  story?: { story: WorkViewBuildStory | null } | null
  /** The worker's automatic refresh of goals and progress (refresh.json); null before its first check. Older workers leave it out. */
  refresh?: WorkViewRefresh | null
  /** Every open judge suggestion; each is also on its conversation's request as `suggestion`. Older workers leave it out. */
  suggestions?: WorkViewRequestSuggestion[]
}

/** refresh.json, written by the worker's automatic refresh (auto-refresh-worker.mjs). */
export interface WorkViewRefresh {
  state: 'idle' | 'running' | 'ok' | 'failed' | 'waiting-for-agent'
  startedAt?: string
  finishedAt?: string
  error?: string | null
}
