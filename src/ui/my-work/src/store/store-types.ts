// The one My Work store is these slices bound together (index.ts). Each slice keeps its state under one key
// (`work`, `view`, `rules`) and its actions at the top level, after MemeDeck's lib/store.
import type { FocusChange, Request } from '../data.ts'
import type { OwnerRule, RuleChange } from '../data-rules.ts'
import type { ConnectionStatus } from '../live/connection-status.ts'
import type { ReviewResult } from '../live/review-response.ts'
import type { RuleDecision, SavedRuleDecision } from '../live/rule-actions.ts'
import type { UsageReport } from '../live/usage.ts'
import type { RuleSaveResult, WorkDataSource, WorkModel } from '../live/work-data-source.ts'

// ---------- Work: the active source's model ----------

export type WorkModelLoad =
  | { state: 'loading' }
  | { state: 'loaded'; model: WorkModel }
  | { state: 'failed'; error: string }

export interface WorkState {
  load: WorkModelLoad
  /** The feed's health. Kept apart from the model so a heartbeat re-renders only the indicators. */
  connection: ConnectionStatus | null
  /** Requests whose recorded content changed in the last applied model; their cards show the "Just updated" dot. */
  freshlyUpdatedIds: Set<string>
  sourceKind: WorkDataSource['sourceKind'] | null
  /** A save went through but reading the model after it failed. The save stands; this says why the screen may lag. */
  refreshError: string | null
}

export interface WorkSlice {
  work: WorkState
  /** Reads the source and follows its live feed. The returned function stops it; nothing it started can publish after that. */
  startWorkSource: (source: WorkDataSource) => () => void
  /** Reads the active source again: the Retry after a failed first read. */
  retryWorkRead: () => Promise<void>
  receiveWorkModel: (model: WorkModel) => void
  receiveConnection: (connection: ConnectionStatus) => void
  /** Checks (or undoes the check of) the version of a request that was on screen. */
  setRequestChecked: (requestId: string, checked: boolean, expectedFingerprint: string | undefined) => Promise<ReviewResult>
  /** Saves one rule change. Answers with the model the save returned, which is the receipt even if the screen has moved on. */
  saveRuleChange: (change: RuleChange) => Promise<RuleSaveResult>
  saveFocusChange: (change: FocusChange) => Promise<WorkModel>
  markAgentFinished: (agentId: string) => Promise<void>
  loadRulesInClaudeCode: () => Promise<void>
  /** Sample mode only: replace one fixture request everywhere. */
  updateSampleRequest: (id: string, change: (request: Request) => Request) => void
  /** Sample mode only: the wireframe agent finishes while you watch. Returns the stop. */
  playSampleDemo: () => () => void
}

// ---------- View: where the person is and how they like to see it ----------

/** `setup` is the install funnel (`?setup=1`): a full page outside the nav that becomes My Work when it completes. */
export type Page = 'setup' | 'app'
export type NavPage = 'work' | 'rules'
/** What the main column shows: a page, or one of the focus views the rail opens. */
export type Section = NavPage | 'suggested' | 'past-focus'
export type WorkListView = 'cards' | 'list' | 'agents' | 'team'
export type WorkFilter = 'all' | 'needs-you' | 'shipped' | 'closed'
export type WorkSort = 'attention' | 'started' | 'progress'
export interface Workspace { mode: 'home' | 'web'; team: boolean; connected: boolean }
export type FocusSelection = { kind: 'area'; focusAreaId: string } | { kind: 'suggested' } | { kind: 'past-focus' } | null

/**
 * The open request drawer, by id so it always shows the current record. `fromLiveFeed` tells "left the feed" (close)
 * from "never in it" (an older goal-only request, shown from `fallback`); null until a model confirms it (a reload).
 */
export interface OpenRequest { id: string; fromLiveFeed: boolean | null; fallback: Request | null }

export interface ViewState {
  page: Page
  section: Section
  /** The area My Work is filtered to (an area id or Other); null shows every request. */
  focusChoice: string | null
  openRequest: OpenRequest | null
  /** Sample mode's place and TeamBrain switches. Outside sample mode the place comes from the source. */
  workspace: Workspace
  showSpec: boolean
  dark: boolean
  listView: WorkListView
  filter: WorkFilter
  sort: WorkSort
}

export interface ViewSlice {
  view: ViewState
  goToPage: (page: NavPage) => void
  goToFocus: (focusAreaId: string) => void
  selectFocus: (selection: FocusSelection) => void
  openRequestDrawer: (request: Request) => void
  closeRequestDrawer: () => void
  /** Keeps the drawer on the current record; closes it when its request left the feed. Runs on every model. */
  reconcileOpenRequest: () => void
  /** Back/Forward: show what the URL now says. */
  showUrl: () => void
  finishSetup: () => void
  reportOpen: () => void
  setWorkspace: (change: Partial<Workspace>) => void
  setShowSpec: (showSpec: boolean) => void
  setDark: (dark: boolean) => void
  setListView: (listView: WorkListView) => void
  setFilter: (filter: WorkFilter) => void
  setSort: (sort: WorkSort) => void
}

// ---------- Rules: the receipts and Undo for My Rules saves ----------

export interface RuleChangeRecord {
  text: string
  ruleId: string | null
  undo: RuleChange | null
  /** The saved version of the rule; Undo is offered only while the screen still shows it. */
  expectedVersion: string | null
}

export interface RulesState {
  /** Approve/Reject receipts, each for the exact version the worker saved. */
  savedDecisions: Record<string, SavedRuleDecision>
  /** Every change pushes the previous one, so the saved note's Undo reverses exactly the last change. */
  history: RuleChangeRecord[]
  changedIds: string[]
  /** One rule save at a time: a second click while one is in flight does nothing. */
  saving: boolean
  saveError: string | null
}

/** What a finished rule save means for the receipts, worked out from the model that save returned. */
export interface RuleSaveOutcome {
  change: Omit<RuleChangeRecord, 'expectedVersion'> | null
  decision?: { ruleId: string; decision: RuleDecision | null }
}

export interface RulesSlice {
  rules: RulesState
  /** Saves one change and records it. Resolves to the saved rules, or null while another save is running; rejects with the reason it was not saved. */
  runRuleSave: (change: RuleChange, describe: (saved: RuleSaveResult) => RuleSaveOutcome) => Promise<OwnerRule[] | null>
  undoLastRuleChange: () => Promise<void>
  setRuleSaveError: (saveError: string | null) => void
}

// ---------- Focus: the last My Focus changes, for the saved note and Undo ----------

export interface FocusChangeRecord { text: string; undo: FocusChange[] | null }

export interface FocusState {
  history: FocusChangeRecord[]
  /** One change at a time: a second click while one is saving does nothing. */
  saving: boolean
  error: string | null
}

export interface FocusSlice {
  focus: FocusState
  /** Saves one change; `record` (null when the screen shows its own Undo) goes in the history. Resolves true when saved. */
  applyFocusChange: (change: FocusChange, record: FocusChangeRecord | null) => Promise<boolean>
  undoLastFocusChange: () => Promise<boolean>
}

export type BoundStore = WorkSlice & ViewSlice & RulesSlice & FocusSlice

/** What the store reads from and writes to outside itself: the browser in the app, fakes in tests. */
export interface StoreEnvironment {
  href: () => string
  writeUrl: (url: URL, replace: boolean) => void
  prefersDark: boolean
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null
  /** Usage counts describe real local work only; the sample fixtures are not usage. */
  reportsUsage: boolean
  sendUsage: (report: UsageReport | null) => void
  scrollToTop: () => void
}
