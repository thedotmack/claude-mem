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

/** An owner goal the request-progress alignment linked to this request. */
export interface WorkViewRequestGoal { goalId: string; goal: string; title: string; kind: 'priority' | 'open-ask'; evidence: string }

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
  /** The last memory review; null when its group has none. Older workers leave it out. */
  progress?: WorkViewProgress | null
  /** Absent: not aligned yet ("Goal not linked yet"). Empty: aligned to no goal ("No goal"). */
  goals?: WorkViewRequestGoal[]
  /** Newest first. Older workers leave it out. */
  workProduct?: WorkViewWorkProduct[]
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

/** One owner-goals item. The worker already parsed `evidence` into quotes; `at` is `YYYY-MM-DD HH:MM`, a bare day, or null. */
export interface WorkViewGoalItem {
  id: string
  task: string
  kind: 'priority' | 'open-ask'
  rank: number | null
  title: string
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
  priorities: WorkViewGoalItem[]
  openAsks: WorkViewGoalItem[]
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
  /** request-progress reviews and the build story; null when the ledger is empty. Older workers leave it out. */
  story?: { story: WorkViewBuildStory | null } | null
  /** The worker's automatic refresh of goals and progress (refresh.json); null before its first check. Older workers leave it out. */
  refresh?: WorkViewRefresh | null
}

/** refresh.json, written by the worker's automatic refresh (auto-refresh-worker.mjs). */
export interface WorkViewRefresh {
  state: 'idle' | 'running' | 'ok' | 'failed' | 'waiting-for-agent'
  startedAt?: string
  finishedAt?: string
  error?: string | null
}
