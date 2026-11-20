// The one boundary between the screens and where work comes from (plan: "The adapter decision").
// Screens consume a WorkModel and never see API shapes. Implementations: sampleSource (fixtures) and
// localSource (the worker at localhost:37777); cloudSource (cmem.ai) comes later.
import type { Agent, CurrentPeriod, Device, FocusArea, FocusAsk, FocusChange, PastPeriod, Request, SkillRun } from '../data.ts'
import type { OwnerRule, RuleChange, RulesFile, RulesLearning, RuleScope } from '../data-rules.ts'
import type { ConnectionStatus } from './connection-status.ts'
import type { ReviewResult, SaveReceipt } from './review-response.ts'
import type { WorkViewRefreshState } from './work-view-api-types.ts'
import type {
  ContinuablePlatform, ConversationContinuation, ConversationContinuationNotice, ConversationContinuationTarget, ConversationOpenedInApp,
} from '../../../../shared/conversation-continuation.ts'

export type SourceKind = 'sample' | 'local' | 'cloud'

/** A request the mapper could not read consistently. It renders as its own card instead of breaking the page. */
export interface RequestReadError { requestId: string; title: string | null; reason: string; evidenceHref: string | null }

export interface WorkModel {
  sourceKind: SourceKind
  requests: Request[]
  requestReadErrors: RequestReadError[]
  agents: Agent[]
  devices: Device[]
  /** Who asked, for the Team board. Solo mode: only you. */
  people: string[]
  unlinkedWorkCount: number
  /**
   * My Focus, in priority order (the owner's order first). Every area the my-focus list holds, merged and dismissed
   * included, so a decision on screen keeps its card until you leave; screens choose what to show.
   */
  focusAreas: FocusArea[]
  /** Owner-goals asks with no live area. They show under Other. */
  otherAsks: FocusAsk[]
  /** The current owner-goals run, for Past focus. Null when owner-goals has not run (or could not be read: see goalsReadError). */
  currentPeriod: CurrentPeriod | null
  pastPeriods: PastPeriod[]
  /** Why the recorded owner-goals run could not be read. Past focus says so, and areas show without their quotes and asks. */
  goalsReadError: string | null
  /** My Rules: learned suggestions with the owner's saved decisions, and rules the owner wrote. */
  rules: OwnerRule[]
  /** Every scope a rule is in, Everywhere first. */
  ruleScopes: RuleScope[]
  /** Null when request-progress has not written a build story (no learned rules yet). */
  rulesLearning: RulesLearning | null
  /** Null when this source has no rules file (an older worker). */
  rulesFile: RulesFile | null
  /** Why the saved rules could not be read. My Rules says so instead of showing anything made up. */
  rulesReadError: string | null
  /** Null until request-progress writes a build story: My Work then hides the recap. */
  buildStory: BuildStory | null
  /** progress: the last request-progress build story. */
  lastRuns: { goals: SkillRun | null; progress: SkillRun | null }
  /** The worker's automatic refresh of goals and progress. Null in sample mode and on older workers. */
  refresh: AutoRefresh | null
  /** The backend's own health. `connected: false` means it answered but could not read saved work. */
  sourceHealth: { connected: boolean; error: string | null }
  sharedState?: import('./work-view-api-types.ts').WorkViewSharedState
  /** The live feed's health (getConnectionStatus). Only SSE messages renew "live"; an HTTP read never does. */
  connection: ConnectionStatus
}

/** What the automatic refresh is doing. `finishedAt` is display text. */
export interface AutoRefresh {
  state: WorkViewRefreshState
  finishedAt: string | null
  error: string | null
  /** `finishedAt` as an ISO time, for the reader's own clock (G9). Workers before 16.0.0 leave it out (G19). */
  finishedAtIso?: string
}

/** The last build story request-progress wrote. `writtenAt` is display text; null when not recorded. */
/** One chapter of the build story: its heading (null for the opening, before any heading) and its paragraphs. */
export interface StoryChapter { heading: string | null; paragraphs: string[] }
/**
 * The build story request-progress wrote. `paragraphs` are its blocks with heading marks removed; `chapters` keep which
 * block was a heading (from 16.0.0; older workers leave it out, G19, and live/build-story.ts storyChapters reads them).
 * `writtenAtIso` is `writtenAt` as an ISO time: it dates the headings' UTC days and times, which the page shows in the
 * reader's own clock (lib/display-time.ts displayRecordedDate). Workers before 16.0.0 leave it out (G19).
 */
export interface BuildStory { recap: string; paragraphs: string[]; writtenAt: string | null; writtenAtIso?: string; chapters?: StoryChapter[] }

/** A saved rule change: the model right after it, and the rule it saved (null from workers that don't say). */
export interface RuleSaveResult { model: WorkModel; savedRuleId: string | null; save?: SaveReceipt }
export interface SuggestionSaveResult { model: WorkModel; save?: SaveReceipt }

/** What the pure mapper produces; the source adds the connection it measured. */
export type MappedWorkModel = Omit<WorkModel, 'connection'>

/**
 * What the worker answers about one conversation (GET /api/work-view/conversations/continuation): whether it can be
 * continued from here and where its turn would run, and the exchanges sent to it from My Work since the worker
 * started, oldest first.
 */
export interface ConversationContinuationRead { target: ConversationContinuationTarget; exchanges: ConversationContinuation[] }

/**
 * What a row showing a continued conversation hears: a notice that an exchange started or ended (ids and state only),
 * or 'live-updates-reconnected' when the live stream opened again, after which a notice may have been missed. Either
 * way, a row it concerns reads its conversation again with loadConversationContinuation.
 */
export type ConversationContinuationEvent = ConversationContinuationNotice | 'live-updates-reconnected'

export interface WorkDataSource {
  readonly sourceKind: SourceKind
  loadWorkModel(): Promise<WorkModel>
  /** Optional for compact sources; old workers and sample data already carry complete request detail. */
  loadRequestDetail?(requestId: string, expectedFingerprint?: string, options?: { signal?: AbortSignal }): Promise<Request>
  /** Streams new models and connection changes until the returned function is called. */
  subscribeToLiveUpdates(onWorkModel: (model: WorkModel) => void, onConnectionChange: (status: ConnectionStatus) => void): () => void
  /**
   * Marks one version of a request checked, or undoes that. `expectedFingerprint` is the version on screen: the
   * worker refuses a check for any other version. Rejects when the save fails for a reason it can't name.
   */
  setRequestChecked(requestId: string, expectedFingerprint: string, checked: boolean, expectedReviewHash?: string | null): Promise<ReviewResult>
  /** Answers the exact suggestion the owner read; a refusal carries the newest model. */
  answerRequestSuggestion?(suggestion: NonNullable<Request['suggestion']>, action: 'join' | 'not-this'): Promise<SuggestionSaveResult>
  /** Saves one change to My Rules and answers with the model after it. Rejects with the reason it was not saved. */
  saveRuleChange(change: RuleChange): Promise<RuleSaveResult>
  /** Saves one focus change and returns its own saved snapshot, even when a newer live model is displayed. */
  saveFocusChange(change: FocusChange): Promise<WorkModel>
  /** Records the owner's stop for a subagent no recorded stop covers, and answers with the model after it. */
  markAgentFinished(agentId: string): Promise<WorkModel>
  /** Adds the MY-RULES.md import to ~/.claude/CLAUDE.md (once). Rejects with the reason when it can't. */
  loadRulesInClaudeCode(): Promise<WorkModel>
  /** Starts an on-demand refresh of goals and progress on this machine. `state` is `idle` when nothing was due. */
  refreshWork(): Promise<{ state: string }>

  // Continuing a conversation from My Work. Only the page this computer's worker serves has these: the sample source
  // and a cloud-served page cannot run a CLI on this computer, so they leave them out. Each call rejects with one plain
  // sentence the row can show as it is.
  /** Whether the conversation can be continued from here and where its turn would run, and what was sent to it from here. */
  loadConversationContinuation?(platform: ContinuablePlatform, conversationSessionId: string): Promise<ConversationContinuationRead>
  /**
   * Sends the owner's message to the conversation as one turn, and answers with its running exchange without waiting
   * for the reply. A refusal (such as a turn from here still running) rejects with the worker's own sentence.
   */
  continueConversation?(platform: ContinuablePlatform, conversationSessionId: string, ownerMessage: string): Promise<ConversationContinuation>
  /** Asks the running turn to end, and answers with its exchange, which stays running until the CLI has exited. */
  stopConversationContinuation?(platform: ContinuablePlatform, conversationSessionId: string): Promise<ConversationContinuation>
  /**
   * Hears every continuation notice, for any conversation, until the returned function is called. Notices come over the
   * live stream, so they arrive while subscribeToLiveUpdates holds it open.
   */
  subscribeToConversationContinuations?(listener: (event: ConversationContinuationEvent) => void): () => void
  /**
   * Opens the conversation in its tool's own app on this computer (the target's opensInAppNamed: Claude Code's, in the
   * Claude desktop app, on macOS), and resolves once the worker's command has exited, with what it printed. It starts no
   * turn. When the app did not open it, this rejects with the worker's sentence, which holds what the command printed.
   */
  openConversationInApp?(platform: ContinuablePlatform, conversationSessionId: string): Promise<ConversationOpenedInApp>
}

/**
 * A source that can continue a conversation from this page: it has the four calls above that continuing needs. The fifth,
 * openConversationInApp, stays optional: a row offers "Open in" only when its source has it.
 */
export type ConversationContinuationSource = WorkDataSource
  & Required<Pick<WorkDataSource, 'loadConversationContinuation' | 'continueConversation' | 'stopConversationContinuation' | 'subscribeToConversationContinuations'>>
