// The one boundary between the screens and where work comes from (plan: "The adapter decision").
// Screens consume a WorkModel and never see API shapes. Implementations: sampleSource (fixtures) and
// localSource (the worker at localhost:37777); cloudSource (cmem.ai) comes later.
import type { Agent, CurrentPeriod, Device, FocusArea, FocusAsk, FocusChange, FocusIconUpload, FocusPlan, FocusPlanSummary, PastPeriod, Request, SkillRun, StageFormatInfo } from '../data.ts'
import type { OwnerRunStartState } from '../../../../services/work-view/owner-runs.mjs'
import type { OwnerRule, RuleChange, RulesFile, RulesLearning, RuleScope } from '../data-rules.ts'
import type { ConnectionStatus } from './connection-status.ts'
import type { ReviewResult, SaveReceipt } from './review-response.ts'
import type { WorkViewRefreshState } from './work-view-api-types.ts'

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
  /** Every format a request can be staged in, as the worker lists them (built-ins, then the owner's own). Absent on older workers. */
  stageFormats?: StageFormatInfo[]
  /** The format automatic stages are made in; null while the owner has not turned them on (the default). */
  autoStageFormat?: string | null
  /** The owner's latest focus plan; null before the first. Its proposals are in the store (`work.focusPlan`). */
  focusPlan?: FocusPlanSummary | null
  /** The backend's own health. `connected: false` means it answered but could not read saved work. */
  sourceHealth: { connected: boolean; error: string | null }
  sharedState?: import('./work-view-api-types.ts').WorkViewSharedState
  /** The live feed's health (getConnectionStatus). Only SSE messages renew "live"; an HTTP read never does. */
  connection: ConnectionStatus
}

/** What the automatic refresh is doing. `finishedAt` is display text. */
export interface AutoRefresh { state: WorkViewRefreshState; finishedAt: string | null; error: string | null }

/** The last build story request-progress wrote. `writtenAt` is display text; null when not recorded. */
export interface BuildStory { recap: string; paragraphs: string[]; writtenAt: string | null }

/** A saved rule change: the model right after it, and the rule it saved (null from workers that don't say). */
export interface RuleSaveResult { model: WorkModel; savedRuleId: string | null; save?: SaveReceipt }
export interface SuggestionSaveResult { model: WorkModel; save?: SaveReceipt }

/**
 * How a one-click run began (answer, stage, plan). `started`: the worker started its one run, and the model will carry
 * how it ends. `duplicate`: this click already started one. `refused`: nothing was started, and `reason` says why in
 * words to show; for an answer the page then falls back to copying it and opening the chat.
 */
export type OwnerRunStart = { outcome: OwnerRunStartState } | { outcome: 'refused'; reason: string }

/** What the pure mapper produces; the source adds the connection it measured. */
export type MappedWorkModel = Omit<WorkModel, 'connection'>

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
  /** Sends the owner's answer into the request's own agent session. `token` is this click's id: the same token never starts a second run. */
  answerRequest?(requestId: string, text: string, token: string): Promise<OwnerRunStart>
  /** Starts one stage of a request in one format. Rejects with the reason when it could not start. */
  generateStage?(requestId: string, formatId: string, token: string): Promise<OwnerRunStart>
  /** Turns automatic stages on (a format id) or off (null) and answers with the model after it. It generates nothing by itself. */
  setAutoStageFormat?(formatId: string | null): Promise<WorkModel>
  /** Starts planning help for one focus area, or for all of them (null). Rejects with the reason when it could not start. */
  planFocus?(focusAreaId: string | null, token: string): Promise<OwnerRunStart>
  /** The latest plan with its proposals; null before the first. */
  loadFocusPlan?(): Promise<FocusPlan | null>
  /** Saves an image as one focus area's icon, or removes the icon (null), and answers with the model after it. */
  setFocusIcon?(focusAreaId: string, upload: FocusIconUpload | null): Promise<WorkModel>
  /**
   * Starts one run of the owner's agent that draws an icon for one focus area, steered by the owner's `direction` when
   * they typed one. Rejects with the reason when it could not start.
   */
  generateFocusIcon?(focusAreaId: string, token: string, direction?: string): Promise<OwnerRunStart>
}
