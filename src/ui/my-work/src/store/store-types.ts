// The one My Work store is these slices bound together (index.ts). Each slice keeps its state under one key
// (`work`, `view`, `rules`) and its actions at the top level, after MemeDeck's lib/store.
import type { FocusChange, Request } from '../data.ts'
import type { CardGroupId } from '../live/card-groups.ts'
import type { OwnerRule, RuleChange } from '../data-rules.ts'
import type { ThemeChoice } from '../lib/theme.ts'
import type { ConnectionStatus } from '../live/connection-status.ts'
import type { ReviewResult } from '../live/review-response.ts'
import type { RuleDecision, SavedRuleDecision } from '../live/rule-actions.ts'
import type { RequestChange } from '../live/update-queue.ts'
import type { UsageReport } from '../live/usage.ts'
import type { WORK_VIEW_SECTIONS } from '../../../../shared/work-view-pages.ts'
import type { RequestsArea } from '../live/requests-areas.ts'
import type { RequestsGrouping, RequestsMove } from './slices/view-slice.ts'
import type { ConversationContinuationSource, RuleSaveResult, SuggestionSaveResult, WorkDataSource, WorkModel } from '../live/work-data-source.ts'

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
  /** What changed in the models this screen showed, newest first, one entry per request (update-queue.ts). */
  recentChanges: RequestChange[]
  sourceKind: WorkDataSource['sourceKind'] | null
  /**
   * A save went through but reading the work after it failed: the raw cause. The save stands; the screen may be behind
   * until a read succeeds (components/bits.tsx ReadAfterSaveNotice says so, with Try again). A successful read clears it.
   */
  readAfterSaveFailure: string | null
}

/** What one read of the work answered: it read, or it could not, with the reason (the raw cause, G17's Details). */
export type WorkReadResult = { read: true } | { read: false; error: string }

export interface WorkSlice {
  work: WorkState
  /** Reads the source and follows its live feed. The returned function stops it; nothing it started can publish after that. */
  startWorkSource: (source: WorkDataSource) => () => void
  /**
   * Reads the active source again: the Retry after a failed first read, and Try again where a screen asks for fresh
   * records. Answers whether the read worked and, when it did not, why (the shown work stays as it was).
   */
  retryWorkRead: () => Promise<WorkReadResult>
  /** Loads one compact request's complete detail; old/full sources return the supplied request. */
  loadRequestDetail: (request: Request, options?: { signal?: AbortSignal }) => Promise<Request>
  receiveWorkModel: (model: WorkModel) => void
  receiveConnection: (connection: ConnectionStatus) => void
  /** Checks (or undoes the check of) the version of a request that was on screen. */
  setRequestChecked: (requestId: string, checked: boolean, expectedFingerprint: string | undefined, expectedReviewHash?: string | null) => Promise<ReviewResult>
  answerRequestSuggestion: (suggestion: NonNullable<Request['suggestion']>, action: 'join' | 'not-this') => Promise<SuggestionSaveResult>
  /** Saves one rule change. Answers with the model the save returned, which is the receipt even if the screen has moved on. */
  saveRuleChange: (change: RuleChange) => Promise<RuleSaveResult>
  saveFocusChange: (change: FocusChange) => Promise<WorkModel>
  markAgentFinished: (agentId: string) => Promise<void>
  loadRulesInClaudeCode: () => Promise<void>
  refreshWork: () => Promise<{ state: string }>
  /**
   * The active source, when it can continue a conversation from this page; null when it can't. Only the page this
   * computer's worker serves can run a CLI here, so sample data and a cloud-served page answer null.
   */
  conversationContinuationSource: () => ConversationContinuationSource | null
  /** Sample mode only: replace one fixture request everywhere. */
  updateSampleRequest: (id: string, change: (request: Request) => Request) => void
  /** Sample mode only: the wireframe agent finishes while you watch. Returns the stop. */
  playSampleDemo: () => () => void
}

// ---------- View: where the person is and how they like to see it ----------

/** `setup` is the install funnel (`?setup=1`): a full page outside the nav that becomes My Work when it completes. */
export type Page = 'setup' | 'app'
/** What the main column shows: one of the bar's places, or a page reached from one (src/shared/work-view-pages.ts). */
export type Section = typeof WORK_VIEW_SECTIONS[number]
export type WorkListView = 'cards' | 'list' | 'agents' | 'team'
export type WorkFilter = 'all' | 'needs-you' | 'working' | 'shipped' | 'closed'
export type WorkSort = 'attention' | 'started' | 'progress'
export type FocusArtwork = 'full' | 'compact' | 'off'
export interface Workspace { mode: 'home' | 'web'; team: boolean; connected: boolean }

/**
 * Where the window scrolls once the page has drawn the place the person went to (App.tsx, lib/scroll-ask.ts), one ask
 * per move: a new page from its top (or at an element it names: a rule Find work opened), Back, Forward and a reload
 * where the person left that history entry.
 */
export type ScrollTarget = { to: 'top' } | { to: 'element'; elementId: string } | { to: 'position'; y: number }

/**
 * The open request drawer, by id so it always shows the current record. `fromLiveFeed` tells "left the feed" (close)
 * from "never in it" (an older goal-only request, shown from `fallback`); null until a model confirms it (a reload).
 */
export interface OpenRequest {
  id: string; fromLiveFeed: boolean | null; fallback: Request | null
  /**
   * The person pressed Reply (G2), so the drawer opens on the reply box: "Where this came from" opens and the first
   * conversation that can be continued takes focus once its box shows (components/request-detail.tsx). Not in the
   * address: a reload or Back opens the drawer plainly.
   */
  replyAsked?: boolean
}

export interface ViewState {
  page: Page
  section: Section
  /** The area My Work is filtered to (an area id or Other); null shows every request. */
  focusChoice: string | null
  openRequest: OpenRequest | null
  /** The words typed in Find work (`?q=`), on its page only; null when none. */
  findQuery: string | null
  /** Requests' status tab (`?status=`), on its page only; null is All. */
  requestsStatus: CardGroupId | null
  /** Requests grouped instead of listed (`?by=`), on its page only; null is the list. */
  requestsBy: RequestsGrouping | null
  /** The focus area Requests' list shows (`?area=`), on its list only; null is every area. */
  requestsArea: RequestsArea | null
  /** Requests' list shows the closed requests instead of the open ones (`?closed=1`), on its list only. */
  requestsClosed: boolean
  /** The words typed in Requests' find box (`?q=`), on its list only; null when none. */
  requestsWords: string | null
  /** The last move's scroll, once its page has drawn; each move asks with a new `sequence` (App.tsx runs it once). */
  scrollAsk: { sequence: number; target: ScrollTarget } | null
  /** Sample mode's place and TeamBrain switches. Outside sample mode the place comes from the source. */
  workspace: Workspace
  showSpec: boolean
  /** Decision G8: the person's own choice, saved with the display preferences. */
  theme: ThemeChoice
  /**
   * `?theme=` in the address this visit opened with: it wins over `theme` for this visit only and is never saved (G8),
   * until the person picks a theme in the menu. The screens show `themeChoiceInUse(view)` (slices/view-slice.ts).
   */
  themeForThisVisit: ThemeChoice | null
  listView: WorkListView
  filter: WorkFilter
  sort: WorkSort
  /** Display density only; changing it never requests image generation. */
  focusArtwork: FocusArtwork
}

export interface ViewSlice {
  view: ViewState
  /**
   * Shows a page from its top, or, with `elementId`, at that element once the page has drawn it (a rule Find work
   * opened on My Rules). Requests opens on its All tab.
   */
  goToPage: (page: Section, options?: { elementId?: string }) => void
  /**
   * Shows Requests grouped `by` agent, or its list on a status tab (none is All), an area, or the closed requests; on
   * the list, what the move leaves out stays as shown (slices/view-slice.ts requestsPlace). Each is a history entry.
   */
  showRequests: (move: RequestsMove) => void
  goToFocus: (focusAreaId: string) => void
  /** Find work's words, written to the address in place (no new history entry); '' clears them. */
  setFindQuery: (query: string) => void
  /** Requests' find words, written to the address in place, as Find work's are; '' clears them. */
  setRequestsWords: (words: string) => void
  /** Opens a request's drawer; `{ reply: true }` opens it on its reply box (Reply on a card or the summary, G2). */
  openRequestDrawer: (request: Request, options?: { reply?: boolean }) => void
  closeRequestDrawer: () => void
  /** Keeps the drawer on the current record; closes it when its request left the feed. Runs on every model. */
  reconcileOpenRequest: () => void
  /** An area's address whose area the work does not show becomes the home page's address. Runs on every model. */
  reconcileFocusChoice: () => void
  /**
   * On Requests: an area no request sits in reads as every area, and an address naming what the page does not apply
   * is rewritten in place. Runs on every model and after Back or Forward.
   */
  reconcileRequestsDetails: () => void
  /** Back/Forward: show what the URL now says. */
  showUrl: () => void
  startSetup: () => void
  finishSetup: () => void
  reportOpen: () => void
  setWorkspace: (change: Partial<Workspace>) => void
  setShowSpec: (showSpec: boolean) => void
  /** Saves the choice; the address's `?theme=` stops overriding it for the rest of the visit. */
  setTheme: (theme: ThemeChoice) => void
  setListView: (listView: WorkListView) => void
  setFilter: (filter: WorkFilter) => void
  setSort: (sort: WorkSort) => void
  setFocusArtwork: (focusArtwork: FocusArtwork) => void
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

export interface FocusChangeRecord { text: string; undo: FocusChange[] | null; expectedVersions?: string[] | null }

/**
 * The last My Focus save that failed, the one record of it every screen reads: what it tried (a change, or the Undo of
 * the newest change in the history), the saved note's words that name it (components/focus-change-message.ts), the
 * screen that made it (`place`, components/focus-changes.tsx useFocusChanges), and why, as the source said it. Only
 * that screen shows it and offers Try again, which makes exactly this save once more; the next save of anything
 * replaces it, and leaving the screen forgets it.
 */
export interface FailedFocusSave {
  attempt: { kind: 'change'; change: FocusChange; record: FocusChangeRecord | null } | { kind: 'undo' }
  words: FocusChangeRecord
  place: string
  reason: string
}

export interface FocusState {
  history: FocusChangeRecord[]
  /** One change at a time: a second click while one is saving does nothing. */
  saving: boolean
  failed: FailedFocusSave | null
}

export interface FocusSlice {
  focus: FocusState
  /**
   * Saves one change; `record` (null when the screen shows its own Undo) goes in the history. `made`: the words that
   * name the change and the screen making it, kept if the save fails. Resolves true when saved.
   */
  applyFocusChange: (change: FocusChange, record: FocusChangeRecord | null, made: { words: FocusChangeRecord; place: string }) => Promise<boolean>
  /** Undoes the newest change in the history, from the screen `place` (kept if the Undo fails). */
  undoLastFocusChange: (place: string) => Promise<boolean>
  /** Forgets the failed save that `place` made, if the last one is its: a closed dialog, a screen left behind. */
  forgetFailedFocusSave: (place: string) => void
}

export type BoundStore = WorkSlice & ViewSlice & RulesSlice & FocusSlice

/** What the store reads from and writes to outside itself: the browser in the app, fakes in tests. */
export interface StoreEnvironment {
  href: () => string
  /** A new history entry for `url`, or with `replace` the same entry at `url`. */
  writeUrl: (url: URL, replace: boolean) => void
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null
  /** Usage counts describe real local work only; the sample fixtures are not usage. */
  reportsUsage: boolean
  sendUsage: (report: UsageReport | null) => void
  scrollToTop: () => void
  /**
   * Where the person last left the history entry now shown scrolled, or null when that is not known: read when the
   * store starts (a reload) and after Back or Forward. The browser's is in index.ts.
   */
  savedScrollY: () => number | null
}
