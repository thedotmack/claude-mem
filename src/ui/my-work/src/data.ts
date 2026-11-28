// Request types, the sample fixtures (SAMPLE_*) and pure request rules. The model every page reads is in the store (store/).
import type { WorkModel } from './live/work-data-source.ts'
import type { WorkViewFocusArea, WorkViewMediaManifest, WorkViewRequestMedia, WorkViewSubFocus } from './live/work-view-api-types.ts'
import type { WorkViewFocusAction } from '../../../shared/work-view-focus-actions.ts'
import { SAMPLE_MEDIA_REFS } from './components/observation-media/sample-media.ts'
import { estimateDayIsPast } from './live/measured-estimate.ts'

export interface Device { id: string; name: string; syncedMinutesAgo: number; online: boolean }
/** 'other' is any platform without its own mark (a neutral mark is shown). */
export type AgentTool = 'claude' | 'codex' | 'gemini' | 'other'
/** One running agent. Several can share a tool, so each also has a role and the machine it runs on (§13.2). */
/**
 * `role` is the agent's own: its session's title or folder, or the mapper's "Recorded session". `status` is set only
 * for a subagent, from recorded evidence: `finished` means a recorded stop (its SubagentStop, its Agent call returning,
 * or the owner's Mark finished) came after its last recorded step. Quiet is never finished.
 */
export interface Agent {
  id: string; tool: AgentTool; name: string; role: string; deviceId: string
  status?: 'working' | 'quiet' | 'finished'
  /** When a finished subagent stopped, as display text; workers before 16.0.0 send only this (G19). */
  finishedAt?: string
  /** `finishedAt` as an ISO time, for the reader's own clock (G9, the shared LocalTime). */
  finishedAtIso?: string
  /** A subagent with no recorded stop: the owner may record one. */
  canMarkFinished?: boolean
  /**
   * A subagent's parent: the main agent of the conversation it ran in, set only when the recorded session links them
   * (live/to-work-model.ts subagentParents). The 15.19.0 worker's own overview leaves it out, so there its subagents
   * stand on their own, labelled as subagents (G19); a model this page maps itself from the worker's records (after a
   * save, or from an older worker's events, live/local-source.ts) links them.
   */
  parentId?: string
  /**
   * What a subagent was launched to do: the short task title its parent's Agent call gave it (agent-view.mjs
   * readAgentLaunches `description`), never the whole task text. Shown as its first line. Older workers send none
   * (the 15.19.0 worker maps its overview without it, G19), and a launch recorded without one has none: the subagent
   * then shows its state only.
   */
  launchDescription?: string
  /**
   * The start of the recorded session a main agent ran in (sdk_sessions.content_session_id), set only where another
   * main agent has the same name, role and machine (several sessions in one folder): the one fact that tells their
   * cards apart (live/to-work-model.ts toWorkModel; pages/requests.tsx AgentGroup shows it). Workers before 16.0.0 send
   * none (G19).
   */
  sessionShortId?: string
}

/**
 * Whether an agent is a subagent: it carries a recorded status, which the mapper sets for subagents only (every worker
 * since 15.x does), never read from its role's words. The one rule; By agent and the agent's identity ask it.
 */
export const isSubagent = (agent: Pick<Agent, 'status'>) => agent.status !== undefined

export type Stage = 'Planning' | 'Building' | 'Reviewing' | 'Shipped'
export type LiveState = 'working' | 'needs-check' | 'your-move' | 'idle' | 'shipped'

export interface Quote { at: string; quote: string }
/**
 * What kind of record a request came from, read from its evidence link (/api/work-view/evidence/<kind>/<id>): a prompt
 * you typed, a work-state item, an observation, a session summary or a session; `record` names no evidence route (an
 * older worker's "Record: …" title, live/to-work-model.ts evidenceShown). The one definition: the mapper checks a link's
 * kind against this list and writes it (live/to-work-model.ts), and the drawer words each from a Record.
 */
export const EVIDENCE_KINDS = ['prompt', 'work-state', 'observation', 'summary', 'session', 'record'] as const
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number]
export type WorkProductKind = 'PR' | 'Commit' | 'Branch' | 'Page' | 'Deck' | 'Doc' | 'File' | 'Link'

/**
 * Why a request has no next step to show (decision G3), as a value and never as English text: `not-recorded`, its
 * agents recorded work but no step; `no-agent-work`, it has only the owner's asks so far. Its one writer is the mapper
 * (live/to-work-model.ts toRequest); the screens word it from a Record (components/bits.tsx). Workers before 16.0.0
 * wrote English fillers in its place, which live/to-work-model.ts nextStepShown reads as these values.
 */
export type NextStepMissing = 'not-recorded' | 'no-agent-work'
/**
 * What kind of step a request's next move is, as a value and never as English text (Phase 0's "English mapper text
 * shown as data"): `recorded`, the step its agent recorded; `unblock`, a recorded step that unblocks a blocked request;
 * `ship`, a checked result that is the owner's to ship. The one definition: the mapper writes it (live/to-work-model.ts
 * nextStepFor), components/bits.tsx words each kind from a Record, and the shared page words it as before 16.0.0
 * (live/to-shared-focus.ts). Workers before 16.0.0 sent the last two as English text ("Unblock: …", "Ship it"), which
 * live/to-work-model.ts nextStepShown reads as these kinds (G19).
 */
export type NextStepKind = 'recorded' | 'unblock' | 'ship'
/**
 * Whose move is next, and the step, or why none is recorded. `who` is set either way: the lifecycle rules check it.
 * `kind` is left out for a recorded step; a blocked request whose step is not recorded keeps `unblock` beside its
 * missing value, which the shared page words as it did before 16.0.0.
 */
export type NextStep =
  | { who: 'bot' | 'human'; kind?: 'unblock'; text: string; missing?: undefined }
  | { who: 'bot' | 'human'; kind?: 'unblock'; text?: undefined; missing: NextStepMissing }
  | { who: 'bot' | 'human'; kind: 'ship'; text?: undefined; missing?: undefined }

export interface Request {
  id: string
  /** False only for a compact overview; the drawer loads authoritative detail before showing its evidence. */
  detailLoaded?: boolean
  /** The content version used to request/cache detail, independent of unrelated snapshot changes. */
  detailRevision?: string
  /** Exact card counts when the overview carries only a bounded preview. */
  detailCounts?: { workProduct: number }
  /** The images its listed records link: the count and the newest four. Rides the compact overview; absent when it has none. */
  media?: WorkViewRequestMedia
  title: string | null
  /** True when the title repeats the request's own prompts in full text (prompt-echo.ts); a shared page hides it. */
  titleRepeatsPrompt?: boolean
  summary: string | null
  /** Full-prompt checks for text that shared pages omit, even when the local quote is shortened. */
  summaryRepeatsPrompt?: boolean
  nextRepeatsPrompt?: boolean
  /** The focus area it sits in: an area id, OTHER_FOCUS_AREA_ID, or absent while it is not sorted yet ("Not sorted yet"). */
  focusAreaId?: string
  /** Its sub focus in that area (an id in the area's subFocuses); absent while it has none. */
  subFocusId?: string
  /** False when the request has no conversation to file a move under (the worker refuses it). Sample fixtures leave it out. */
  canMoveFocus?: boolean
  askedBy: string
  agentId: string
  /**
   * When it started, as the mapper words a recorded time ("Oct 20, 1:16 pm"); null when its start is not recorded, a
   * value the screens word in the reader's language ("Start not recorded"), never English text. Workers before 16.0.0
   * wrote those English words in its place, which recordedStart (live/to-work-model.ts) reads as not recorded (G19).
   */
  startedAt: string | null
  /**
   * Sortable start time, and the List's start in the reader's own clock (the shared LocalTime). Absent when the start
   * is not recorded: that missing value is what the List words, through t() ("Start not recorded"), never `startedAt`'s
   * English text.
   */
  startedAtIso?: string
  /**
   * How long it has run (to its completion, or to the mapping's time), in milliseconds; null when its start is not
   * recorded. A value the screens word (live/running-time.ts durationIn), never English text.
   */
  runningForMs?: number | null
  /** Workers before 16.0.0 sent the duration as English text instead (G19); shown only when `runningForMs` is absent. */
  runningFor?: string
  /** Live records only: no completion is recorded, so the duration counts up to now and the card keeps it ticking. */
  runningLive?: boolean
  stage: Stage
  state: LiveState
  progress: {
    /** From a memory review. `null` when nothing reviewed it: the meter says "Not reviewed yet", never a number. */
    percent: number | null
    readings: number
    reviewedAt: string
    /** `reviewedAt`'s instant: the same instant as an ISO time, which the screens word in the reader's language (lib/display-time.ts); absent in sample fixtures, which carry their words only. */
    reviewedAtIso?: string
    completedAt?: string
    /** `completedAt`'s instant: the same instant as an ISO time, which the screens word in the reader's language (lib/display-time.ts); absent in sample fixtures, which carry their words only. */
    completedAtIso?: string
    /** Each memory review's percent, oldest first. The ship estimate needs two of them, moving forward (decision 3). */
    history?: number[]
    /** How much of the request the last review could assess (§15.1: a percentage shows its coverage). */
    coverage?: { reviewed: number; total: number }
  }
  /** Only shown through measuredEstimate(), which checks the readings behind it. */
  estimate: string | null
  next: NextStep
  terminal: string[]
  activityWord: string
  /**
   * Its workstreams and their tasks. A title or a task's name that is not recorded is null, which the drawer words in the
   * reader's language ("Supporting work", "Untitled task"), never English text; workers before 16.0.0 wrote those words
   * in its place, which recordedWorkstreamTitle and recordedTaskName (live/to-work-model.ts) read the same way (G19).
   */
  workstreams: { title: string | null; tasks: { name: string | null; done: boolean }[] }[]
  /** `media`: the record's image refs (ids and labels only); absent when it has none. `atIso`: `at`'s instant, the same instant as an ISO time, which the screens word in the reader's language (lib/display-time.ts); absent in sample fixtures, which carry their words only. */
  granular: { kind: 'work' | 'memory'; text: string; at: string; atIso?: string; media?: WorkViewMediaManifest }[]
  /** `platform` and `conversationSessionId` come from the conversation key ["conversation", platform, session id]: the
   * platform it was recorded from (sdk_sessions.platform_source) and its session id, which a continued turn resumes.
   * `title`: its session's recorded title, or null when none is recorded, which the screens word ("{tool} conversation",
   * live/conversation-continuation.ts conversationNaming); never English words in its place (fix round R2).
   * `atIso`: `at`'s instant, the same instant as an ISO time, which the screens word in the reader's language (lib/display-time.ts); absent in sample fixtures, which carry their words only. */
  conversations: { tool: string; at: string; atIso?: string; title: string | null; platform: string; conversationSessionId: string }[]
  prompts: Quote[]
  /** `href` is a real published page, PR or commit; '#' means a sample link with nothing behind it; absent means a
   * recorded item with nothing to open, such as a commit whose remote is not GitHub (render with ProductLink). */
  /** `deliverable` marks a copy claude-mem keeps in the project's deliverables bucket: a file the agent made, kept after its source is gone. */
  workProduct: { kind: WorkProductKind; label: string; href?: string; deliverable?: boolean; availability?: 'origin-only' }[]
  followUps: { tag: 'Docs' | 'Promo' | 'Other'; text: string; done: boolean }[]
  /**
   * The build story's steps, oldest first. `at`: when the step happened, as the mapper formats it, or null when the
   * review recorded no time (a value the drawer words, never English text); absent for a step that carries no time (the
   * sample's). `description`: words about the step, drawn under it, never in the time column. `atIso`: `at`'s
   * instant, the same instant as an ISO time, which the screens word in the reader's language (lib/display-time.ts); absent in sample fixtures, which carry their words only.
   */
  story: { label: string; at?: string | null; atIso?: string; description?: string; status: 'complete' | 'active' | 'pending' }[]
  /** The last memory review's account of how the request went (request-progress). */
  storyNarrative?: string
  /**
   * The records it came from: each one's kind (EvidenceKind, which the drawer words before its title in the reader's
   * language), its title and its evidence link. Workers before 16.0.0 sent no kind and put its English words in front
   * of the title ("Observation: …"), which evidenceShown (live/to-work-model.ts) reads as the kind (G19).
   */
  evidence: { title: string; href: string; kind?: EvidenceKind }[]
  /** Agent-only cards: the human text the title writer produces, so the wireframe can play the transform. */
  resolvesTo?: { title: string; summary: string }
  /** Set when a person marks this version checked (§6). Checking never marks a request shipped. */
  checkedAt?: string
  /** `checkedAt`'s instant: the same instant as an ISO time, which the screens word in the reader's language (lib/display-time.ts); absent in sample fixtures, which carry their words only. */
  checkedAtIso?: string
  /** Whether this acknowledgement is local-only or a shared, versioned decision. */
  review?: { mode: 'local' | 'shared'; hash: string | null; version?: number; available: boolean; conflict?: boolean; legacy?: boolean; pending?: boolean; message?: string }
  /**
   * The judge's "may be part of another request". `confidence`: its check's score, 0 to 1, which the drawer words as a
   * percent; workers before 16.0.0 leave it out of the request they send (G19), and the drawer then says no number.
   */
  suggestion?: { conversationKey: string; requestId: string; requestTitle: string; evidence: string; confidence?: number; expectedSuggestionHash?: string | null; sharedConflict?: boolean }
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

/** One sub focus: a named group of related requests inside one focus area. A request sits in at most one. */
export interface SubFocus {
  id: string
  name: string
  decidedBy: WorkViewSubFocus['decidedBy']
}

/** One focus area (the my-focus list): the top level of My Work. Every request sits in one area, or in Other. */
export interface FocusArea {
  id: string
  name: string
  /** One sentence saying what the area is for; null until one is written. */
  goal: string | null
  /** What belongs here, as recorded by the focus-area router. Older workers leave it out. */
  about?: string | null
  status: WorkViewFocusArea['status']
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
  /**
   * When it was marked done (ISO): the row that marked it done, which a later rename or goal edit does not move
   * (my-focus.mjs). Past focus shows it as a done area's date. Null unless done; workers before 16.0.0 leave it out.
   */
  doneAt?: string | null
  /** Its live sub focuses, in the order they were first written, one with no request now included. Workers before the
   * sub focus step and sample fixtures leave it out. */
  subFocuses?: SubFocus[]
}

/** One owner change to My Focus, as POST /api/work-view/focus takes it (WorkViewRoutes.ts focusBody). */
export interface FocusChange {
  action: WorkViewFocusAction
  focusAreaId?: string
  /** rename-sub-focus and merge-sub-focus: the sub focus changed. move-to-sub-focus: the one to move into; null for none. */
  subFocusId?: string | null
  /** merge-sub-focus: a sub focus of the same area. */
  intoSubFocusId?: string
  /** False when the request has no conversation to file a move under (the worker refuses it). Sample fixtures leave it out. */
  canMoveFocus?: boolean
  name?: string
  goal?: string
  intoFocusAreaId?: string
  /** reorder: every live area (not dismissed, not merged), first = highest priority. */
  focusAreaIds?: string[]
  requestId?: string
  /** Undo's saved version. The worker compares it inside the ordered read-and-write operation. */
  expectedVersion?: string
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
/** `lastRunAtIso`: `lastRunAt`'s instant, the same instant as an ISO time, which the screens word in the reader's language (lib/display-time.ts); absent in sample fixtures, which carry their words only. */
export interface SkillRun { label: string; lastRunAt: string; lastRunAtIso?: string; deviceName: string }

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
    focusAreaId: 'fa-viewer', askedBy: 'Alex', agentId: 'claude', startedAt: 'Oct 20, 1:16 pm', startedAtIso: '2026-10-20T13:16:00-07:00', runningForMs: 42 * 60_000, stage: 'Building', state: 'working',
    progress: { percent: 70, readings: 3, reviewedAt: '1:50 pm', history: [30, 55, 70], coverage: { reviewed: 2, total: 2 } }, estimate: 'at this pace, about Oct 21',
    next: { who: 'bot', text: 'Finish the My Rules screens' }, activityWord: 'Editing',
    workstreams: [
      { title: 'Spec', tasks: [{ name: 'Derive from 466 prompts', done: true }, { name: 'Decide open questions', done: true }] },
      { title: 'Wireframe', tasks: [{ name: 'Requirement ledger', done: true }, { name: 'My Work screens', done: true }, { name: 'My Rules screens', done: false }] },
    ],
    // Six sample images (sample-media.ts): one record holds all six, a second shares the first and says more stayed on its event.
    media: { count: SAMPLE_MEDIA_REFS.length, preview: SAMPLE_MEDIA_REFS.slice(0, 4) },
    granular: [
      { kind: 'work', text: 'Wireframe: My Work screens done', at: '1:56 pm', media: { version: 1, attachments: SAMPLE_MEDIA_REFS } },
      { kind: 'work', text: 'Wireframe: requirement ledger done', at: '1:51 pm' },
      { kind: 'memory', text: 'Card animation redesigned: terminal output that becomes human text', at: '1:45 pm', media: { version: 1, attachments: SAMPLE_MEDIA_REFS.slice(0, 1), overflow: true } },
      { kind: 'work', text: 'Spec: open questions decided', at: '1:41 pm' },
      { kind: 'memory', text: 'My Rules named, replacing “Manual”', at: '1:33 pm' },
      { kind: 'work', text: 'Spec: home and on the go section written', at: '1:28 pm' },
      { kind: 'memory', text: 'Spec derived from 466 owner prompts', at: '1:20 pm' },
    ],
    // The session ids are not UUIDs, so sample data never offers to continue a conversation.
    conversations: [
      { tool: 'Claude Code', at: 'Oct 20, 1:16 pm', title: 'Work state spec from prompts', platform: 'claude', conversationSessionId: 'sample-conversation-1' },
      { tool: 'Claude Code', at: 'Oct 20, 1:24 pm', title: 'Home and on the go (after /clear)', platform: 'claude', conversationSessionId: 'sample-conversation-2' },
    ],
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
    id: 'r2', title: null, summary: null, askedBy: 'Alex', agentId: 'codex', startedAt: 'Oct 20, 1:58 pm', startedAtIso: '2026-10-20T13:58:00-07:00', runningForMs: 3 * 60_000, stage: 'Planning', state: 'working',
    progress: { percent: 0, readings: 0, reviewedAt: '—', history: [] }, estimate: null, next: { who: 'bot', text: 'Read the current usage rollup' }, activityWord: 'Searching',
    resolvesTo: { title: 'Show real usage on the price forecast page', summary: 'Lead with what you spend today, then what it costs as usage grows.' },
    terminal: ['$ work_state_write list=usage-forecast', '  task: "read current usage rollup" status=doing', '$ rg "forecast" src/app/admin', '  12 matches in 4 files'],
  },
  {
    ...emptyRequest,
    id: 'r3', title: 'Move embeddings into their own table', summary: 'Stops write stalls by keeping vector indexes off the main content table.',
    focusAreaId: 'fa-sync', askedBy: 'Alex', agentId: 'claude-sync', startedAt: 'Oct 17, 7:55 am', startedAtIso: '2026-10-17T07:55:00-07:00', runningForMs: 3 * 86_400_000, stage: 'Reviewing', state: 'needs-check',
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
    focusAreaId: 'fa-viewer', askedBy: 'Sam', agentId: 'codex', startedAt: 'Oct 16, 9:39 am', startedAtIso: '2026-10-16T09:39:00-07:00', runningForMs: 2 * 86_400_000, stage: 'Shipped', state: 'shipped',
    progress: { percent: 100, readings: 5, reviewedAt: 'Oct 19', completedAt: 'Oct 18', history: [20, 45, 70, 90, 100], coverage: { reviewed: 3, total: 3 } }, estimate: null,
    next: { who: 'human', text: 'Write the release notes' },
    workProduct: [{ kind: 'PR', label: '#330 live human-request monitor', href: `${PULL_REQUEST}330` }, { kind: 'Deck', label: 'Launch walkthrough', href: '#', deliverable: true }],
    followUps: [{ tag: 'Docs', text: 'Write the release notes', done: false }, { tag: 'Promo', text: 'Launch post with walkthrough', done: false }, { tag: 'Other', text: 'Telemetry dashboard', done: true }],
  },
  {
    ...emptyRequest,
    id: 'r5', title: 'Fix the admin model price page', summary: 'Show current usage first, with scaling estimates below.',
    focusAreaId: OTHER_FOCUS_AREA_ID, askedBy: 'Priya', agentId: 'gemini', startedAt: 'Oct 20, 12:40 pm', startedAtIso: '2026-10-20T12:40:00-07:00', runningForMs: 60 * 60_000, stage: 'Building', state: 'your-move',
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
    if (!next.missing && next.kind !== 'ship' && !next.text?.trim()) return 'every request says what happens next, or why nothing is recorded'
    if (progress.history && progress.history.length !== progress.readings) return 'reading count matches the readings'
    if (progress.history?.length && progress.history.at(-1) !== progress.percent) return 'percent is the latest reading'
    return null
  })()
  if (problem) throw new Error(`Request ${request.id} is inconsistent: ${problem}`)
  return request
}
SAMPLE_REQUESTS.forEach(assertConsistentRequest)

/** A request's title, or the words for one still being written, in the reader's language (`t`). */
export function requestTitle(request: Pick<Request, 'title' | 'resolvesTo'>, t: (text: string) => string): string {
  return request.title ?? request.resolvesTo?.title ?? t('New request, title being written')
}

/** Whether requestTitle has a title to show, its own or the one it resolves to, rather than the words for one being written. */
export const hasOwnTitle = (request: Pick<Request, 'title' | 'resolvesTo'>) => !!(request.title ?? request.resolvesTo?.title)

/** Waits on you: your move, or done and waiting for your check. The nav counts and the Needs you filter both use this. */
export const needsYou = (request: Request) => request.state === 'your-move' || request.state === 'needs-check'

/**
 * Working now: open, and an agent is on it. The one counting rule for the board's Working filter (pages/focus-area.tsx
 * FILTERS) and the change ticker's "Watching N working requests" (components/live-motion.tsx), which count the same
 * requests: the page's, an area's own on its page (Phase 6 verify V7: the ticker counted every area's while the filter
 * beside it counted the page's).
 */
export const isWorkingNow = (request: Request) => !request.closed && request.state === 'working'

/**
 * Attention first: what waits on you, then what to check, then what is moving, then the rest. The one order; the
 * boards' "Needs you first" sort and By agent's busiest-first order ask it (components/bits.tsx re-exports it).
 */
export const ATTENTION_ORDER: LiveState[] = ['your-move', 'needs-check', 'working', 'idle', 'shipped']

/** A save the worker refused, with the snapshot it answered: the screen shows that state, then the reason. */
export class SaveRefusedError extends Error {
  readonly model: WorkModel
  constructor(message: string, model: WorkModel) { super(message); this.name = 'SaveRefusedError'; this.model = model }
}

/**
 * The worker did not start a refresh. `workerReason` is the worker's own words when its answer carried any, else
 * null; the screen words the rest in the person's language (pages/machine-sync.tsx FocusReview). The message stays English for logs.
 */
export class RefreshNotStartedError extends Error {
  readonly status: number
  readonly workerReason: string | null
  constructor(status: number, workerReason: string | null) {
    super(`Refresh could not start: ${workerReason ?? `the worker answered ${status}`}`)
    this.name = 'RefreshNotStartedError'
    this.status = status
    this.workerReason = workerReason
  }
}

/**
 * The ship estimate only from measured pace: two or more readings, the latest moving forward (decision 3), and never
 * a day already behind `now` (c-bits-progress-meter: it read "about Oct 22" on Nov 16). A worker before 16.0.0 sends
 * estimates it never compared with the day, and a page left open keeps one past its day, so the screen checks too.
 */
export function measuredEstimate(request: Request, now: number = Date.now()): string | null {
  const history = request.progress.history ?? []
  const advancing = history.length >= 2 && history.at(-1)! > history.at(-2)!
  if (!advancing || request.state === 'shipped' || !request.estimate) return null
  return estimateDayIsPast(request.estimate, now) ? null : request.estimate
}

/** Sort key for "Started": the recorded timestamp. A start that was never recorded sorts as oldest. */
export function startedTimestamp(request: Request): number {
  return request.startedAtIso ? Date.parse(request.startedAtIso) : 0
}

/** Attention order (ATTENTION_ORDER), the newest first within a state: the boards' "Needs you first" sort. */
export const byAttention = (a: Request, b: Request) =>
  ATTENTION_ORDER.indexOf(a.state) - ATTENTION_ORDER.indexOf(b.state) || startedTimestamp(b) - startedTimestamp(a)

/** What needs you, first (home's Needs you, a focus area page's main card): your move, then to check, newest first. */
export const firstNeedingYou = (requests: readonly Request[]) => requests.filter(needsYou).sort(byAttention)

export const isSampleHref = (href: string | undefined) => href !== undefined && (!href || href === '#')

export const SAMPLE_RUNS: Record<'goals' | 'progress', Run> = {
  goals: { label: 'owner-goals', lastRunAt: 'Today, 11:02 am', deviceId: 'mbp', state: 'idle' },
  progress: { label: 'request-progress', lastRunAt: 'Today, 1:50 pm', deviceId: 'studio', state: 'idle' },
}
