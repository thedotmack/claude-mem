// Machine and sync (`?view=machine`; design pass Phase 4, Codex D13 and D14, Claude D13): the one quiet home for system
// status, reached from Workspace and from the failure line under a page's title. This computer (where the work is read
// from, the live feed, the worker version, records not linked to a request), cloud sync (its state, what waits to
// upload, how updates arrive, sharing) and the focus review (when it last ran, a failure with its cause and "Try review
// again", when the goals run last finished or why it could not be read, and what the last learning run found). It
// replaced the bar's Live chip and its panel, the machine count, the refresh banner on six pages, the refresh lines of
// Suggested and Past focus and My Rules' learning-run box. Every fact comes from the work model and the live feed this
// page already reads, and the worker version from one read of GET /api/version where the host runs the worker; a read
// that was refused or failed, or not made, says so in place of its value, so nothing looks loaded that was not.
import { useEffect, useState, type ReactNode } from 'react'
import { CheckIcon, ChevronRightIcon, CircleAlertIcon, ClockIcon, ExternalLinkIcon, MonitorIcon, RefreshCwIcon } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Spinner } from '@/components/ui/spinner'
import { API_PROVIDER_GUIDE_URL, FailureDetails, LocalTime, RecordedTime, RefreshButton, type Translate } from '@/components/bits'
import { Panel, PanelPair, PanelTitle } from '@/components/panel'
import { TechnicalDetails } from '@/components/error-details'
import { recordedTimeWords } from '@/lib/display-time'
import { interpolate, useI18n } from '@/lib/i18n'
import { sentenceWith } from '@/lib/sentence-with'
import { cn } from '@/lib/utils'
import { Req } from '@/spec/req'
import { RefreshNotStartedError, SAMPLE_RUNS, type SkillRun } from '@/data'
import type { RulesLearning } from '@/data-rules'
import type { ConnectionTone } from '@/live/connection-status'
import { pageStartsRefresh, refreshRecordKey, shownRefreshLine, type RefreshLineState, type RefreshPressAnswer } from '@/live/refresh-line'
import { isServedFromCloud } from '@/live/served-from'
import { sharedViewerOwner } from '@/live/shared-viewer-session'
import { presentSharedState } from '@/live/shared-state-presentation'
import type { AutoRefresh, SourceKind } from '@/live/work-data-source'
import { readWorkerVersion, workerVersionReadHere, type WorkerVersionRead, type WorkerVersionReadState } from '@/live/worker-version'
import { useConnection, useStore, useWorkModel, useWorkspace } from '@/store'
import { isRefreshStartRefusal, isWaitingForAgentReason } from '../../../../shared/work-view-refresh-reasons.ts'
import { syncDetailWords, type SyncDeliveryMode } from '../../../viewer/utils/sync-presentation'

/** Where the cloud sync guide lives (docs.claude-mem.ai). */
const CLOUD_SYNC_GUIDE_URL = 'https://docs.claude-mem.ai/cloud-sync'

/** Where the page's work is read from, in words. */
const SOURCE_WORDS: Record<SourceKind, (t: Translate) => string> = {
  local: (t) => t('Local worker'),
  cloud: (t) => t('Cloud viewer'),
  sample: (t) => t('Sample data'),
}

/** How cloud updates arrive, as a fact (the sentence after the state names the same mode in full). */
const SYNC_MODE_WORDS: Record<SyncDeliveryMode, (t: Translate) => string> = {
  realtime: (t) => t('Realtime'),
  polling: (t) => t('HTTP polling'),
}

/** The worker version's row for each state of its read (live/worker-version.ts). */
const VERSION_WORDS: Record<WorkerVersionReadState, (read: WorkerVersionRead, t: Translate) => string> = {
  reading: (_read, t) => t('Reading…'),
  read: (read) => read.state === 'read' ? read.version : '',
  refused: (read, t) => read.state !== 'refused' ? '' : read.reason
    ? interpolate(t('Not read here: {reason}'), { reason: t(read.reason) })
    : interpolate(t('Not read: the server answered {status}.'), { status: read.status }),
  failed: (_read, t) => t('Couldn’t read it.'),
  'not-read-here': (_read, t) => t('Not read here: cmem.ai shows your synced work and runs no worker.'),
}

/** A fact's value in a state that wants the person's attention reads in the attention colour; the words carry the state. */
const TONE_CLASS_NAME: Record<ConnectionTone, string> = {
  neutral: 'text-foreground',
  positive: 'text-foreground',
  warning: 'text-attention-foreground',
}

/**
 * The sentences behind a panel's facts, one quiet press away (Codex's `textbtn`, as Technical details): for whoever
 * wants the whole story, not the next step.
 */
function DetailsFold({ children }: { children: ReactNode }) {
  const { t } = useI18n()
  return (
    <Collapsible className="mt-2">
      <CollapsibleTrigger asChild>
        <Button variant="ghost" size="sm" className="group/details -ml-2 text-accent-foreground">
          <ChevronRightIcon aria-hidden="true" className="transition-transform group-aria-expanded/details:rotate-90 motion-reduce:transition-none" />{t('Details')}
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-1.5 pt-1 text-sm text-muted-foreground">{children}</CollapsibleContent>
    </Collapsible>
  )
}

/**
 * Reads the worker version once, when the page opens. The sample reads nothing and shows no row; a host that runs no
 * worker (cmem.ai, live/worker-version.ts workerVersionReadHere) is not asked, and the row says why.
 */
function useWorkerVersion(wanted: boolean): WorkerVersionRead | null {
  const here = workerVersionReadHere(sharedViewerOwner())
  const [read, setRead] = useState<WorkerVersionRead>(here ? { state: 'reading' } : { state: 'not-read-here' })
  useEffect(() => {
    if (!wanted || !here) return
    let current = true
    void readWorkerVersion((input, init) => fetch(input, init)).then((answer) => { if (current) setRead(answer) })
    return () => { current = false }
  }, [wanted, here])
  return wanted ? read : null
}

/** One fact: what it is at the left, its value at the right (Codex's `.fact`), a hairline between facts. */
function Fact({ label, children, tone = 'neutral', fact }: { label: string; children: ReactNode; tone?: ConnectionTone; fact?: string }) {
  return (
    <div data-fact={fact} className="flex items-baseline justify-between gap-4 border-b border-border py-2.5 text-sm text-muted-foreground last:border-b-0">
      <dt>{label}</dt>
      <dd className={cn('min-w-0 text-right font-medium [overflow-wrap:anywhere]', TONE_CLASS_NAME[tone])}>{children}</dd>
    </div>
  )
}

/** Where the work on this page is read from, and how the live feed is doing. */
function ThisComputer({ version }: { version: WorkerVersionRead | null }) {
  const { t } = useI18n()
  const { mode } = useWorkspace()
  const { sourceKind, sourceHealth, unlinkedWorkCount } = useWorkModel()
  const connection = useConnection()
  const sample = sourceKind === 'sample'
  const cloud = isServedFromCloud(window.location.hostname)
  return (
    <Req ids={['R6.4', 'R13.1']}>
      <Panel>
        <span aria-hidden="true" className="flex size-10 items-center justify-center rounded-lg bg-working text-working-foreground"><MonitorIcon className="size-5" /></span>
        <PanelTitle className="mt-3">{cloud ? t('Cloud viewer') : t('This computer')}</PanelTitle>
        <p data-source-status="" className="text-muted-foreground">
          {sample ? t('Sample data · not your work')
            : !sourceHealth.connected ? t('The worker answered, but could not read your saved work. It may be busy; try again in a moment.')
              : cloud ? t('Your synced work is available.') : t('Local work is available.')}
        </p>
        {!sample && !sourceHealth.connected && sourceHealth.error && <FailureDetails cause={sourceHealth.error} />}
        <dl className="mt-4 border-t border-border pt-1">
          <Fact label={t('Memory source')} fact="source">{SOURCE_WORDS[sourceKind](t)}</Fact>
          <Fact label={t('Live feed')} fact="feed" tone={sample ? 'neutral' : connection.tone}>
            {sample ? (mode === 'home' ? t('Streams from the local worker, localhost:37777 (demonstration)') : t('Checks cmem.ai for new sync changes every few seconds (demonstration)')) : t(connection.label)}
          </Fact>
          {!sample && connection.lastSuccessfulCheckAt && <Fact label={t('Last checked')} fact="checked"><LocalTime iso={connection.lastSuccessfulCheckAt} /></Fact>}
          {version && (
            <Fact label={t('Worker version')} fact="version" tone={version.state === 'refused' || version.state === 'failed' ? 'warning' : 'neutral'}>
              <span data-version-read={version.state}>{VERSION_WORDS[version.state](version, t)}</span>
            </Fact>
          )}
        </dl>
        {version?.state === 'failed' && <FailureDetails cause={version.cause} />}
        {unlinkedWorkCount > 0 && (
          <p data-unlinked-work="" className="mt-3 text-sm text-muted-foreground">
            {interpolate(unlinkedWorkCount === 1 ? t("{count} work record isn't linked to a request yet.") : t("{count} work records aren't linked to a request yet."), { count: unlinkedWorkCount })}
          </p>
        )}
        {!sample && (
          <DetailsFold>
            <p>{t(connection.detail)}</p>
            {connection.activityCheckedAt && <p>{sentenceWith(t('Activity last inspected {time}'), 'time', <LocalTime iso={connection.activityCheckedAt} />)}</p>}
            {connection.clockSkew && <p>{t('Source and browser clocks differ; freshness uses received heartbeats.')}</p>}
            <p>{t('Connection status does not indicate an agent is running.')}</p>
          </DetailsFold>
        )}
      </Panel>
    </Req>
  )
}

/** The cloud copy: its state in plain words, what waits to upload, how updates arrive, and sharing. */
function CloudSync() {
  const { t } = useI18n()
  const { sourceKind, sharedState } = useWorkModel()
  const connection = useConnection()
  const sample = sourceKind === 'sample'
  const sync = sample ? undefined : connection.sync
  const shared = sample ? null : presentSharedState(sharedState)
  const mode = sync?.detailParts?.mode ?? null
  const remaining = sync?.detailParts?.remaining ?? null
  const pending = sync?.pendingUpload ?? null
  return (
    <Panel title={t('Cloud sync')}>
        {!sync ? <p className="text-muted-foreground">{t('Checks cmem.ai for new sync changes every few seconds (demonstration)')}</p> : (
          <>
            <p data-sync-sentence="" className="text-muted-foreground">{t(sync.detailParts?.sentence ?? sync.detail)}</p>
            <dl className="mt-3">
              <Fact label={t('State')} fact="sync-state" tone={sync.tone}>{t(sync.label)}</Fact>
              {pending !== null && <Fact label={t('Waiting to upload')} fact="upload">{interpolate(t(pending === 1 ? '{count} item' : '{count} items'), { count: pending })}</Fact>}
              {mode && <Fact label={t('Mode')} fact="mode">{SYNC_MODE_WORDS[mode](t)}</Fact>}
              {remaining !== null && <Fact label={t('Changes remaining')} fact="remaining"><span className="tabular">{remaining}</span></Fact>}
              {shared && <Fact label={t('Sharing')} fact="sharing" tone={shared.attention ? 'warning' : 'neutral'}>{t(shared.label)}</Fact>}
            </dl>
            <DetailsFold>
              <p data-sync-detail="">{syncDetailWords(sync, t)}</p>
              {shared && <p>{t(shared.detail)}</p>}
            </DetailsFold>
          </>
        )}
        <Button asChild variant="ghost" size="sm" className="-ml-2 text-accent-foreground">
          <a href={CLOUD_SYNC_GUIDE_URL} target="_blank" rel="noreferrer">{t('Sync details')}<ExternalLinkIcon aria-hidden="true" /></a>
        </Button>
    </Panel>
  )
}

/**
 * Starts this computer's review of goals and progress on demand (POST /api/work-view/refresh, which runs at most one at
 * a time). Remembers what the worker answered the last press (live/refresh-line.ts RefreshPressAnswer), or why the
 * start failed, worded at render so the words follow a change of language. `recordAtPress` is the record on screen at
 * the press (refreshRecordKey), so the panel can tell when the worker's record catches up.
 */
function useReviewStart() {
  const refreshWork = useStore((state) => state.refreshWork)
  const [pending, setPending] = useState(false)
  const [failure, setFailure] = useState<{ cause: unknown; recordAtPress: string } | null>(null)
  const [answer, setAnswer] = useState<RefreshPressAnswer | null>(null)
  const start = async (recordAtPress: string) => {
    setPending(true)
    setFailure(null)
    setAnswer(null)
    try {
      const { state } = await refreshWork()
      setAnswer({ state, atIso: new Date().toISOString(), recordAtPress })
    } catch (cause) { setFailure({ cause, recordAtPress }) }
    finally { setPending(false) }
  }
  return { start, pending, failure, answer }
}

/**
 * Why a review did not start (G17): plain words in the person's language, and the raw cause for its details. The
 * worker's refusal sentences (src/shared/work-view-refresh-reasons.ts, the route's own words for people) stay visible;
 * anything else it answered, and a bare status or a browser error ("Failed to fetch"), goes under the details.
 */
function reviewNotStartedWords(cause: unknown, t: Translate): { words: string; details: string | null } {
  if (cause instanceof RefreshNotStartedError) {
    if (isRefreshStartRefusal(cause.workerReason)) return { words: interpolate(t('The review could not start: {reason}'), { reason: t(cause.workerReason) }), details: null }
    return { words: t('The review could not start. The worker refused it.'), details: cause.workerReason ?? interpolate(t('The worker answered {status}.'), { status: cause.status }) }
  }
  return { words: t('The review could not start. The worker did not answer; it may be restarting.'), details: cause instanceof Error ? cause.message : String(cause) }
}

/** Each review state's mark, so a state never rests on its words' colour alone. Each draws at render time. */
const REVIEW_MARK: Record<RefreshLineState, () => ReactNode> = {
  'up-to-date': () => <CheckIcon aria-hidden="true" className="size-4.5 shrink-0" />,
  updating: () => <Spinner className="size-4.5" />,
  failed: () => <CircleAlertIcon aria-hidden="true" className="size-4.5 shrink-0" />,
  'waiting-for-agent': () => <ClockIcon aria-hidden="true" className="size-4.5 shrink-0" />,
}

/**
 * The review's first line for each of its states (live/refresh-line.ts RefreshLineState, which takes each state the
 * worker reports, WorkViewRefreshState, from one Record): a new state fails the typecheck here until it has words.
 * `time`: when it last finished or failed; `reason`: the worker's own sentence for why it waits for an agent.
 */
const REVIEW_SENTENCE: Record<RefreshLineState, (t: Translate, time: ReactNode | null, reason: string | null) => ReactNode> = {
  'up-to-date': (t, time) => time ? sentenceWith(t('Last reviewed at {time}.'), 'time', time) : t('No review has finished yet.'),
  updating: (t) => t('Reviewing your goals and progress now…'),
  failed: (t, time) => time ? sentenceWith(t('The {time} review failed.'), 'time', time) : t('The last review failed.'),
  'waiting-for-agent': (t, _time, reason) => reason ? interpolate(t('Waiting to review: {reason}'), { reason: t(reason) }) : t('Waiting for an agent to run the review. The next check tries again by itself.'),
}

/** The colour of the review's first line: a failure and a wait ask for attention. */
const REVIEW_TONE: Record<RefreshLineState, string> = {
  'up-to-date': 'text-foreground',
  updating: 'text-foreground',
  failed: 'text-attention-foreground',
  'waiting-for-agent': 'text-attention-foreground',
}

/** What the last learning run (request-progress) read and found, as a small table, in the reader's number format. */
function LearningRunNumbers({ learning, run, earlier }: { learning: RulesLearning; run: SkillRun; earlier: boolean }) {
  const { t, locale } = useI18n()
  const alreadyDecided = learning.preferencesFound - learning.newSuggestions
  return (
    <div data-slot="learning-run-numbers" className="space-y-2 text-sm">
      <table className="w-full">
        <tbody className="divide-y">
          <tr><th scope="row" className="py-2 text-left font-normal text-muted-foreground">{t('Request reviews read')}</th><td className="mono-number py-2 text-right">{learning.reviewsRead.toLocaleString(locale)}</td></tr>
          <tr><th scope="row" className="py-2 text-left font-normal text-muted-foreground">{t('Preferences found')}</th><td className="mono-number py-2 text-right">{learning.preferencesFound.toLocaleString(locale)}</td></tr>
          <tr>
            <th scope="row" className="py-2 text-left font-normal text-muted-foreground">{earlier ? t('Waiting for your decision after it') : t('Waiting for your decision')}</th>
            <td className="mono-number py-2 text-right text-attention-foreground">{learning.newSuggestions.toLocaleString(locale)}</td>
          </tr>
        </tbody>
      </table>
      {/* Why found and waiting differ: a found preference you already decided is not suggested again. */}
      {alreadyDecided > 0 && <p className="text-muted-foreground">{interpolate(alreadyDecided === 1 ? t('The other {count} is already decided.') : t('The other {count} are already decided.'), { count: alreadyDecided.toLocaleString(locale) })}</p>}
      <p className="text-muted-foreground">{interpolate(t('Ran on {device}.'), { device: run.deviceName })}</p>
    </div>
  )
}

/**
 * The goals run (owner-goals), which Suggested and Past focus come from: when it last finished and on which machine, or,
 * when its result could not be read, that it could not and why (the cause under Technical details), or that none has
 * finished yet. It sat at the foot of Suggested and Past focus before the design pass.
 */
function GoalsRun({ run, readError }: { run: SkillRun | null; readError: string | null }) {
  const { t } = useI18n()
  return (
    <div data-goals-run={readError ? 'unreadable' : run ? 'read' : 'none'} className="space-y-1.5 border-t pt-3 text-sm">
      {readError ? (
        <>
          <p className="font-medium text-attention-foreground">{t('The last goals run could not be read.')}</p>
          <p className="text-muted-foreground">{t('Suggested and Past focus wait until it can be read.')}</p>
          <TechnicalDetails cause={readError} />
        </>
      ) : run ? (
        <>
          <p className="font-medium">{t('Last goals run')} <span className="mono-number font-normal text-muted-foreground">{recordedTimeWords(run.lastRunAtIso, run.lastRunAt)}</span></p>
          <p className="text-muted-foreground">{t('Suggested and Past focus come from it.')} {interpolate(t('Ran on {device}.'), { device: run.deviceName })}</p>
        </>
      ) : <p className="text-muted-foreground">{t('No goals run has finished yet.')}</p>}
    </div>
  )
}

/**
 * The worker's automatic review of goals and progress (it runs owner-goals and request-progress on the person's own
 * logged-in agent whenever something is due): one panel in four states. Up to date says when it last ran; updating
 * says so; waiting for an agent shows the worker's own sentence (the "why" in sight, #5535) and where to set an API
 * provider instead; a failure says when it failed and how old the review on screen is, folds the raw cause under
 * Technical details (G17) and offers "Try review again". A press always shows its outcome (live/refresh-line.ts
 * shownRefreshLine): updating at once, a new failure at its own time, or "Nothing new to review". Only the page this
 * computer's worker serves can start one (pageStartsRefresh); the sample's pretend run is its own button. Below, the
 * goals run (`goalsRun`, or why it could not be read, `goalsReadError`), then what the last learning run (`run`,
 * request-progress) found, marked as an earlier run's while the latest review failed.
 */
export function FocusReview({ refresh, run, learning, goalsRun, goalsReadError }: {
  refresh: AutoRefresh | null; run: SkillRun | null; learning: RulesLearning | null; goalsRun: SkillRun | null; goalsReadError: string | null
}) {
  const { t } = useI18n()
  const starting = useReviewStart()
  const sourceKind = useStore((state) => state.work.sourceKind)
  const shown = shownRefreshLine(refresh, starting.answer)
  const state = shown.state
  const canStart = pageStartsRefresh(sourceKind)
  const finished = refresh?.finishedAt ? <RecordedTime iso={refresh.finishedAtIso} words={refresh.finishedAt} /> : null
  const lastRun = run ? <RecordedTime iso={run.lastRunAtIso} words={run.lastRunAt} /> : null
  // A start that failed before the worker's record caught up says when it failed; the record's older cause waits.
  const time = state === 'failed' ? (shown.failedAtIso ? <LocalTime iso={shown.failedAtIso} /> : finished)
    : state === 'up-to-date' ? (refresh?.state === 'ok' && finished ? finished : lastRun) : null
  const workerSaid = refresh?.error ?? null
  const waitingReason = state === 'waiting-for-agent' && isWaitingForAgentReason(workerSaid) ? workerSaid : null
  const cause = state === 'failed' && !shown.failedAtIso ? workerSaid : state === 'waiting-for-agent' && !waitingReason ? workerSaid : null
  const startFailure = starting.failure && starting.failure.recordAtPress === refreshRecordKey(refresh) ? reviewNotStartedWords(starting.failure.cause, t) : null
  return (
    <Req ids={['R14.10', 'R14.12', 'R14.13']}>
      <Panel className="space-y-3">
        <div data-focus-review={state} className="space-y-2">
          {/* One status region: the line is read out when its state changes, once. */}
          <p role="status" className={cn('flex items-start gap-2.5 font-medium', REVIEW_TONE[state])}>
            <span className="mt-0.5 flex">{REVIEW_MARK[state]()}</span>
            <span className="min-w-0">{REVIEW_SENTENCE[state](t, time, waitingReason)}</span>
          </p>
          {state === 'failed' && lastRun && <p className="text-muted-foreground">{sentenceWith(t('Your last reviewed view is from {time}.'), 'time', lastRun)}</p>}
          {state === 'waiting-for-agent' && (
            <Button asChild variant="link" size="sm" className="h-auto px-0">
              <a href={API_PROVIDER_GUIDE_URL} target="_blank" rel="noopener noreferrer">{t('Configure My Work to use an API provider')}<ExternalLinkIcon aria-hidden="true" /></a>
            </Button>
          )}
          {sourceKind === 'cloud' && <p className="text-sm text-muted-foreground">{t('claude-mem learns again on its own whenever new work is due, using the agent you are logged in to.')}</p>}
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          {canStart && (
            // While the worker runs a review the button waits (aria-disabled, so it stays reachable, G16) and the line
            // above says why; only this page's own press shows the button busy.
            <Button variant="outline" onClick={() => void starting.start(refreshRecordKey(refresh))} busy={starting.pending}
              aria-disabled={state === 'updating' || undefined} busyLabel={t('Reviewing…')}>
              <RefreshCwIcon />{state === 'failed' ? t('Try review again') : t('Review now')}
            </Button>
          )}
          {sourceKind === 'sample' && <RefreshButton run={SAMPLE_RUNS.progress} ids={['R14.12']} />}
          {cause && <TechnicalDetails cause={cause} />}
          {shown.nothingNew && <span role="status" className="text-sm text-muted-foreground">{t('Nothing new to review')}</span>}
        </div>
        {startFailure && (
          <Alert variant="attention" role="alert" className="py-2.5 text-sm">
            <AlertTitle className="font-normal">{startFailure.words}</AlertTitle>
            {startFailure.details && <AlertDescription><FailureDetails cause={startFailure.details} /></AlertDescription>}
          </Alert>
        )}
        <GoalsRun run={goalsRun} readError={goalsReadError} />
        {learning && run && (
          <Req ids={['R7.3']}>
            <div className="space-y-2 border-t pt-3">
              <p className="text-sm font-medium">{state === 'failed'
                ? interpolate(t('The last learning run that finished, {date}'), { date: recordedTimeWords(run.lastRunAtIso, run.lastRunAt) })
                : <>{t('Last learning run')} <span className="mono-number font-normal text-muted-foreground">{recordedTimeWords(run.lastRunAtIso, run.lastRunAt)}</span></>}</p>
              <LearningRunNumbers learning={learning} run={run} earlier={state === 'failed'} />
            </div>
          </Req>
        )}
      </Panel>
    </Req>
  )
}

/** What the page says it reads from, in one line under its title. */
function leadWords(sourceKind: SourceKind, cloud: boolean, t: Translate): string {
  if (sourceKind === 'sample') return t('Sample data: nothing here is read from a computer.')
  return cloud ? t('This page reads your cloud viewer, which your computers sync to.') : t('This page reads the worker on this computer.')
}

export function MachineAndSync() {
  const { t } = useI18n()
  const { sourceKind, refresh, lastRuns, rulesLearning, sharedState, goalsReadError } = useWorkModel()
  const connection = useConnection()
  const sample = sourceKind === 'sample'
  const cloud = isServedFromCloud(window.location.hostname)
  const version = useWorkerVersion(!sample)
  const shared = sample ? null : presentSharedState(sharedState)
  // What a screen reader hears when a state changes: the feed's, the cloud copy's and sharing's names, never the
  // sentences behind them, which carry counts that change on every poll ("Changes remaining: 1234."), so a change is
  // heard once.
  const announcement = sample ? '' : [t(connection.label), connection.sync ? t(connection.sync.label) : null, shared ? t(shared.label) : null].filter(Boolean).join('. ')
  return (
    <div className="space-y-6 md:space-y-8">
      <p className="text-base text-muted-foreground md:text-lg">{leadWords(sourceKind, cloud, t)}</p>
      <PanelPair>
        <ThisComputer version={version} />
        <CloudSync />
      </PanelPair>
      <section className="space-y-3 md:space-y-4">
        <h2 className="text-section-title-phone md:text-section-title">{t('Focus review')}</h2>
        <FocusReview refresh={refresh} run={lastRuns.progress} learning={rulesLearning} goalsRun={lastRuns.goals} goalsReadError={goalsReadError} />
      </section>
      <span role="status" className="sr-only" data-sync-state={sample ? undefined : connection.sync?.state}>{announcement}</span>
    </div>
  )
}
