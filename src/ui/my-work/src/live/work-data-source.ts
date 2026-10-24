// The one boundary between the screens and where work comes from (plan: "The adapter decision").
// Screens consume a WorkModel and never see API shapes. Implementations: sampleSource (fixtures) and
// localSource (the worker at localhost:37777); cloudSource (cmem.ai) comes later.
import type { Agent, CurrentPeriod, Device, GoalItem, PastPeriod, Request, SkillRun } from '../data.ts'
import type { OwnerRule, RuleChange, RulesFile, RulesLearning, RuleScope } from '../data-rules.ts'
import type { ConnectionStatus } from './connection-status.ts'
import type { ReviewResult } from './review-response.ts'

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
  /** The owner-goals run, as recorded; never re-ranked or re-counted here. */
  priorities: GoalItem[]
  openAsks: GoalItem[]
  /** Null when owner-goals has not run (or could not be read: see goalsReadError). */
  currentPeriod: CurrentPeriod | null
  pastPeriods: PastPeriod[]
  /** Why the recorded goals could not be read. My Goals says so instead of showing anything made up. */
  goalsReadError: string | null
  /**
   * Sample fixtures only: older requests that serve goals but are not in today's inbox. Live sources leave it
   * empty, since every recorded request is already in `requests`.
   */
  goalOnlyRequests: Request[]
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
  /** The live feed's health (getConnectionStatus). Only SSE messages renew "live"; an HTTP read never does. */
  connection: ConnectionStatus
}

/** What the automatic refresh is doing. `finishedAt` is display text. */
export interface AutoRefresh { state: 'idle' | 'running' | 'ok' | 'failed' | 'waiting-for-agent'; finishedAt: string | null; error: string | null }

/** The last build story request-progress wrote. `writtenAt` is display text; null when not recorded. */
export interface BuildStory { recap: string; paragraphs: string[]; writtenAt: string | null }

/** What the pure mapper produces; the source adds the connection it measured. */
export type MappedWorkModel = Omit<WorkModel, 'connection'>

export interface WorkDataSource {
  readonly sourceKind: SourceKind
  loadWorkModel(): Promise<WorkModel>
  /** Streams new models and connection changes until the returned function is called. */
  subscribeToLiveUpdates(onWorkModel: (model: WorkModel) => void, onConnectionChange: (status: ConnectionStatus) => void): () => void
  /**
   * Marks one version of a request checked, or undoes that. `expectedFingerprint` is the version on screen: the
   * worker refuses a check for any other version. Rejects when the save fails for a reason it can't name.
   */
  setRequestChecked(requestId: string, expectedFingerprint: string, checked: boolean): Promise<ReviewResult>
  /** Saves one change to My Rules and answers with the model after it. Rejects with the reason it was not saved. */
  saveRuleChange(change: RuleChange): Promise<WorkModel>
  /** Records the owner's stop for a subagent no recorded stop covers, and answers with the model after it. */
  markAgentFinished(agentId: string): Promise<WorkModel>
  /** Adds the MY-RULES.md import to ~/.claude/CLAUDE.md (once). Rejects with the reason when it can't. */
  loadRulesInClaudeCode(): Promise<WorkModel>
}
