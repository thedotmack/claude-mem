// Request types, the sample fixtures (SAMPLE_*) and pure request rules. The model every page reads is in the store (store/).
import type { WorkModel } from './live/work-data-source.ts'

export interface Device { id: string; name: string; syncedMinutesAgo: number; online: boolean }
/** 'other' is any platform without its own mark (a neutral mark is shown). */
export type AgentTool = 'claude' | 'codex' | 'gemini' | 'other'
/** One running agent. Several can share a tool, so each also has a role and the machine it runs on (§13.2). */
/**
 * `status` is set only for a subagent, from recorded evidence: `finished` means a recorded stop (its SubagentStop,
 * its Agent call returning, or the owner's Mark finished) came after its last recorded step. Quiet is never finished.
 */
export interface Agent {
  id: string; tool: AgentTool; name: string; role: string; deviceId: string
  status?: 'working' | 'quiet' | 'finished'
  finishedAt?: string
  /** A subagent with no recorded stop: the owner may record one. */
  canMarkFinished?: boolean
}

export type Stage = 'Planning' | 'Building' | 'Reviewing' | 'Shipped'
export type LiveState = 'working' | 'needs-check' | 'your-move' | 'idle' | 'shipped'

export interface Quote { at: string; quote: string }
export type WorkProductKind = 'PR' | 'Commit' | 'Branch' | 'Page' | 'Deck' | 'Doc' | 'File' | 'Link'

export interface Request {
  id: string
  title: string | null
  summary: string | null
  /** The focus area it sits in: an area id, OTHER_FOCUS_AREA_ID, or absent while it is not sorted yet ("Sorting…"). */
  focusAreaId?: string
  /** False when the request has no conversation to file a move under (the worker refuses it). Sample fixtures leave it out. */
  canMoveFocus?: boolean
  askedBy: string
  agentId: string
  startedAt: string
  /** Sortable start time. The List sorts on this, never on the display string. */
  startedAtIso?: string
  runningFor: string
  stage: Stage
  state: LiveState
  progress: {
    /** From a memory review. `null` when nothing reviewed it: the meter says "Not reviewed yet", never a number. */
    percent: number | null
    readings: number
    reviewedAt: string
    completedAt?: string
    /** Each memory review's percent, oldest first. The ship estimate needs two of them, moving forward (decision 3). */
    history?: number[]
    /** How much of the request the last review could assess (§15.1: a percentage shows its coverage). */
    coverage?: { reviewed: number; total: number }
  }
  /** Only shown through measuredEstimate(), which checks the readings behind it. */
  estimate: string | null
  next: { who: 'bot' | 'human'; text: string }
  terminal: string[]
  activityWord: string
  workstreams: { title: string; tasks: { name: string; done: boolean }[] }[]
  granular: { kind: 'work' | 'memory'; text: string; at: string }[]
  conversations: { tool: string; at: string; title: string }[]
  prompts: Quote[]
  /** `href` is a real published page, PR or commit; '#' means a sample link with nothing behind it; absent means a
   * recorded item with nothing to open, such as a commit whose remote is not GitHub (render with ProductLink). */
  /** `deliverable` marks a copy claude-mem keeps in the project's deliverables bucket: a file the agent made, kept after its source is gone. */
  workProduct: { kind: WorkProductKind; label: string; href?: string; deliverable?: boolean }[]
  followUps: { tag: 'Docs' | 'Promo' | 'Other'; text: string; done: boolean }[]
  story: { label: string; description: string; status: 'complete' | 'active' | 'pending' }[]
  /** The last memory review's account of how the request went (request-progress). */
  storyNarrative?: string
  evidence: { title: string; href: string }[]
  /** Agent-only cards: the human text the title writer produces, so the wireframe can play the transform. */
  resolvesTo?: { title: string; summary: string }
  /** Set when a person marks this version checked (§6). Checking never marks a request shipped. */
  checkedAt?: string
  /** Live records only: the version a check certifies. */
  contentFingerprint?: string
  /** Free-text stage from the title writer. Hover text only; the stage chip comes from the recorded status. */
  stageNote?: string
  /** Every item was dropped. Hidden unless the filter is Closed. */
  closed?: boolean
}

/** The permanent bucket for requests that fit no area. Never an area id (my-focus.mjs OTHER_FOCUS_AREA_ID). */
export const OTHER_FOCUS_AREA_ID = 'other'

/** One finishable ask the owner-goals run found, under the focus area it belongs to. Asks are not linked to requests. */
export interface FocusAsk { id: string; title: string; timesAsked: number; latestAt: string; quotes: Quote[] }

/** One focus area (the my-focus list): the top level of My Work. Every request sits in one area, or in Other. */
export interface FocusArea {
  id: string
  name: string
  /** One sentence saying what the area is for; null until one is written. */
  goal: string | null
  status: 'suggested' | 'kept' | 'dismissed' | 'done'
  /** The owner's order. When set it wins over priorityRank. */
  ownerRank: number | null
  priorityRank: number | null
  source: 'owner-goals' | 'clustering' | 'promotion' | 'seed' | 'owner'
  /** Set when merged: its requests show under this area. */
  mergedInto: string | null
  /** Why the system suggested it, when it has no quotes of the owner's own. */
  evidence: string | null
  /** From the owner-goals item for this area; null and [] when the area has none. */
  timesAsked: number | null
  latestAt: string | null
  quotes: Quote[]
  /** Owner-goals asks in this area. None is linked to a request, so each reads "Not started". */
  asks: FocusAsk[]
}

/** One owner change to My Focus, as POST /api/work-view/focus takes it (WorkViewRoutes.ts focusBody). */
export interface FocusChange {
  action: 'keep' | 'rename' | 'edit-goal' | 'merge' | 'dismiss' | 'done' | 'reorder' | 'move-request' | 'restore-suggestion'
  focusAreaId?: string
  /** False when the request has no conversation to file a move under (the worker refuses it). Sample fixtures leave it out. */
  canMoveFocus?: boolean
  name?: string
  goal?: string
  intoFocusAreaId?: string
  /** reorder: every live area (not dismissed, not merged), first = highest priority. */
  focusAreaIds?: string[]
  requestId?: string
}

/** The current owner-goals run. */
export interface CurrentPeriod { label: string; windowDays: number; promptCount: number }

/** One saved past month (owner-goals/<start>), shown in Past focus. Its asks are archived with the month. */
export interface PastPeriod {
  id: string
  label: string
  promptCount: number
  headline: string
  /** That month's focus areas; `label` is the area (or, before 2026-10-27, the product) the run named. */
  areas: { title: string; label: string; timesAsked: number; quote: Quote | null }[]
}

/** When and where a skill last ran. Real timestamps only; no cost (owner, Oct 20, 2026). */
export interface SkillRun { label: string; lastRunAt: string; deviceName: string }

export interface Run { label: string; lastRunAt: string; deviceId: string; state: 'idle' | 'running' | 'queued'; progress?: number }

export const SAMPLE_DEVICES: Device[] = [
  { id: 'mbp', name: 'MacBook Pro', syncedMinutesAgo: 0, online: true },
  { id: 'studio', name: 'Mac Studio', syncedMinutesAgo: 4, online: true },
  { id: 'cloud', name: 'Cloud agent', syncedMinutesAgo: 52, online: false },
]

export const SAMPLE_AGENTS: Agent[] = [
  { id: 'claude', tool: 'claude', name: 'Claude Code', role: 'Work viewer', deviceId: 'mbp' },
  { id: 'claude-sync', tool: 'claude', name: 'Claude Code', role: 'Sync storage', deviceId: 'studio' },
  { id: 'codex', tool: 'codex', name: 'Codex', role: 'Pricing pages', deviceId: 'studio' },
  { id: 'gemini', tool: 'gemini', name: 'Gemini', role: 'Admin pages', deviceId: 'cloud' },
]

export const SAMPLE_PEOPLE = ['Alex', 'Sam', 'Priya']

const PULL_REQUEST = 'https://example.com/pull/'
const emptyRequest = { activityWord: '', workstreams: [], granular: [], conversations: [], prompts: [], workProduct: [], followUps: [], story: [], evidence: [], terminal: [] }

/**
 * Today's requests: the single source of request state. Pages read them by id (requestById) or through
 * useRequests(); updateRequest() replaces an entry in place, so every page sees the same state.
 */
export const SAMPLE_REQUESTS: Request[] = [
  {
    ...emptyRequest,
    id: 'r1', title: 'Spec and wireframe the new work viewer', summary: 'Turn your prompts into a spec, then a React wireframe that traces every element back to it.',
    focusAreaId: 'fa-viewer', askedBy: 'Alex', agentId: 'claude', startedAt: 'Oct 20, 1:16 pm', startedAtIso: '2026-10-20T13:16:00-07:00', runningFor: '42 min', stage: 'Building', state: 'working',
    progress: { percent: 70, readings: 3, reviewedAt: '1:50 pm', history: [30, 55, 70], coverage: { reviewed: 2, total: 2 } }, estimate: 'at this pace, about Oct 21',
    next: { who: 'bot', text: 'Finish the My Rules screens' }, activityWord: 'Editing',
    workstreams: [
      { title: 'Spec', tasks: [{ name: 'Derive from 466 prompts', done: true }, { name: 'Decide open questions', done: true }] },
      { title: 'Wireframe', tasks: [{ name: 'Requirement ledger', done: true }, { name: 'My Work screens', done: true }, { name: 'My Rules screens', done: false }] },
    ],
    granular: [
      { kind: 'work', text: 'Wireframe: My Work screens done', at: '1:56 pm' },
      { kind: 'work', text: 'Wireframe: requirement ledger done', at: '1:51 pm' },
      { kind: 'memory', text: 'Card animation redesigned: terminal output that becomes human text', at: '1:45 pm' },
      { kind: 'work', text: 'Spec: open questions decided', at: '1:41 pm' },
      { kind: 'memory', text: 'My Rules named, replacing “Manual”', at: '1:33 pm' },
      { kind: 'work', text: 'Spec: home and on the go section written', at: '1:28 pm' },
      { kind: 'memory', text: 'Spec derived from 466 owner prompts', at: '1:20 pm' },
    ],
    conversations: [{ tool: 'Claude Code', at: 'Oct 20, 1:16 pm', title: 'Work state spec from prompts' }, { tool: 'Claude Code', at: 'Oct 20, 1:24 pm', title: 'Home and on the go (after /clear)' }],
    prompts: [{ at: '10-20 13:24', quote: 'it should work the same at my desk and on my phone' }, { at: '10-20 13:27', quote: 'rules could read as simple when-then blocks' }],
    workProduct: [{ kind: 'Page', label: 'My Work LIVE spec', href: '#' }],
    story: [
      { label: 'Spec written from your prompts', description: '466 prompts, 15 sections', status: 'complete' },
      { label: 'Open questions decided', description: 'Six decided, one set by you', status: 'complete' },
      { label: 'Wireframe in React', description: 'shadcn and AI Elements', status: 'active' },
    ],
    evidence: [{ title: 'Observation: spec published', href: '#' }, { title: 'Work state: my-work-wireframe', href: '#' }],
  },
  {
    ...emptyRequest,
    id: 'r2', title: null, summary: null, askedBy: 'Alex', agentId: 'codex', startedAt: 'Oct 20, 1:58 pm', startedAtIso: '2026-10-20T13:58:00-07:00', runningFor: '3 min', stage: 'Planning', state: 'working',
    progress: { percent: 0, readings: 0, reviewedAt: '—', history: [] }, estimate: null, next: { who: 'bot', text: 'Read the current usage rollup' }, activityWord: 'Searching',
    resolvesTo: { title: 'Show real usage on the price forecast page', summary: 'Lead with what you spend today, then what it costs as usage grows.' },
    terminal: ['$ work_state_write list=usage-forecast', '  task: "read current usage rollup" status=doing', '$ rg "forecast" src/app/admin', '  12 matches in 4 files'],
  },
  {
    ...emptyRequest,
    id: 'r3', title: 'Move embeddings into their own table', summary: 'Stops write stalls by keeping vector indexes off the main content table.',
    focusAreaId: 'fa-sync', askedBy: 'Alex', agentId: 'claude-sync', startedAt: 'Oct 17, 7:55 am', startedAtIso: '2026-10-17T07:55:00-07:00', runningFor: '3 days', stage: 'Reviewing', state: 'needs-check',
    progress: { percent: 100, readings: 4, reviewedAt: 'Oct 20, 9:10 am', history: [40, 70, 90, 100], coverage: { reviewed: 2, total: 2 } }, estimate: null,
    next: { who: 'human', text: 'Check the remap queue drained' },
    workstreams: [
      { title: 'Vectors table', tasks: [{ name: 'Migration for the new table', done: true }, { name: 'Write path moved', done: true }] },
      { title: 'Remap', tasks: [{ name: 'Remap target selection', done: true }, { name: 'Embedding job rate recorded', done: true }] },
    ],
    workProduct: [{ kind: 'PR', label: '#343 store vectors in their own table', href: `${PULL_REQUEST}343` }, { kind: 'PR', label: '#344 record the embedding job rate', href: `${PULL_REQUEST}344` }],
    granular: [{ kind: 'work', text: 'Embedding job rate recorded', at: 'Oct 20' }, { kind: 'work', text: 'Remap target selection fixed', at: 'Oct 19' }],
  },
  {
    ...emptyRequest,
    id: 'r4', title: 'Live request monitor with cards and list', summary: 'The first live version of My Work, with sortable list.',
    focusAreaId: 'fa-viewer', askedBy: 'Sam', agentId: 'codex', startedAt: 'Oct 16, 9:39 am', startedAtIso: '2026-10-16T09:39:00-07:00', runningFor: '2 days', stage: 'Shipped', state: 'shipped',
    progress: { percent: 100, readings: 5, reviewedAt: 'Oct 19', completedAt: 'Oct 18', history: [20, 45, 70, 90, 100], coverage: { reviewed: 3, total: 3 } }, estimate: null,
    next: { who: 'human', text: 'Write the release notes' },
    workProduct: [{ kind: 'PR', label: '#330 live human-request monitor', href: `${PULL_REQUEST}330` }, { kind: 'Deck', label: 'Launch walkthrough', href: '#', deliverable: true }],
    followUps: [{ tag: 'Docs', text: 'Write the release notes', done: false }, { tag: 'Promo', text: 'Launch post with walkthrough', done: false }, { tag: 'Other', text: 'Telemetry dashboard', done: true }],
  },
  {
    ...emptyRequest,
    id: 'r5', title: 'Fix the admin model price page', summary: 'Show current usage first, with scaling estimates below.',
    focusAreaId: OTHER_FOCUS_AREA_ID, askedBy: 'Priya', agentId: 'gemini', startedAt: 'Oct 20, 12:40 pm', startedAtIso: '2026-10-20T12:40:00-07:00', runningFor: '1 hr', stage: 'Building', state: 'your-move',
    progress: { percent: 30, readings: 1, reviewedAt: '1:30 pm', history: [30], coverage: { reviewed: 1, total: 2 } }, estimate: null,
    next: { who: 'human', text: 'Pick which forecast to keep' },
    workstreams: [
      { title: 'Usage first', tasks: [{ name: 'Current usage table', done: true }] },
      { title: 'Forecasts', tasks: [{ name: 'Two forecast drafts', done: true }, { name: 'Keep one, remove the other', done: false }] },
    ],
  },
]

/** Lifecycle rules: a request's state, stage, progress and next move must agree wherever it shows (§6). Fails fast. */
export function assertConsistentRequest(request: Request): Request {
  const problem = (() => {
    const { state, stage, progress, next } = request
    if ((state === 'shipped') !== (stage === 'Shipped')) return 'only shipped requests are in the Shipped stage'
    if (state === 'shipped' && (progress.percent !== 100 || !progress.completedAt)) return 'shipped requests are 100% with a completion date'
    if (state === 'needs-check' && (stage !== 'Reviewing' || next.who !== 'human')) return 'a request done but not checked is in Reviewing and waits on a person'
    if (state === 'your-move' && next.who !== 'human') return 'Your move means the next step is a person’s'
    if (state === 'working' && (next.who !== 'bot' || (progress.percent ?? 0) >= 100 || stage === 'Reviewing')) return 'a working request has an agent next step and is not finished'
    if (!next.text) return 'every request says what happens next'
    if (progress.history && progress.history.length !== progress.readings) return 'reading count matches the readings'
    if (progress.history?.length && progress.history.at(-1) !== progress.percent) return 'percent is the latest reading'
    return null
  })()
  if (problem) throw new Error(`Request ${request.id} is inconsistent: ${problem}`)
  return request
}
SAMPLE_REQUESTS.forEach(assertConsistentRequest)

/** Waits on you: your move, or done and waiting for your check. The nav counts and the Needs you filter both use this. */
export const needsYou = (request: Request) => request.state === 'your-move' || request.state === 'needs-check'

/** A save the worker refused, with the snapshot it answered: the screen shows that state, then the reason. */
export class SaveRefusedError extends Error {
  readonly model: WorkModel
  constructor(message: string, model: WorkModel) { super(message); this.name = 'SaveRefusedError'; this.model = model }
}

/** The ship estimate only from measured pace: two or more readings, the latest moving forward (decision 3). */
export function measuredEstimate(request: Request): string | null {
  const history = request.progress.history ?? []
  const advancing = history.length >= 2 && history.at(-1)! > history.at(-2)!
  return advancing && request.state !== 'shipped' ? request.estimate : null
}

/** Sort key for "Started": the recorded timestamp. A start that was never recorded sorts as oldest. */
export function startedTimestamp(request: Request): number {
  return request.startedAtIso ? Date.parse(request.startedAtIso) : 0
}

export const isSampleHref = (href: string | undefined) => href !== undefined && (!href || href === '#')

export const SAMPLE_RUNS: Record<'goals' | 'rules' | 'progress', Run> = {
  goals: { label: 'owner-goals', lastRunAt: 'Today, 11:02 am', deviceId: 'mbp', state: 'idle' },
  rules: { label: 'rules from preferences', lastRunAt: 'Today, 11:05 am', deviceId: 'mbp', state: 'idle' },
  progress: { label: 'request-progress', lastRunAt: 'Today, 1:50 pm', deviceId: 'studio', state: 'idle' },
}
