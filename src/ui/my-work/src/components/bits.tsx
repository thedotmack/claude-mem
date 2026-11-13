import { displayTime } from '@/lib/display-time'
import { useEffect, useState, type ReactNode } from 'react'
import { motion } from 'motion/react'
import { BotIcon, CloudAlertIcon, CloudCheckIcon, CloudIcon, CloudOffIcon, CornerLeftUpIcon, MessageSquareIcon, RefreshCwIcon, StarIcon, UserIcon } from 'lucide-react'
import { interpolate, useI18n } from '@/lib/i18n'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card'
import { Progress } from '@/components/ui/progress'
import { Spinner } from '@/components/ui/spinner'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { Req } from '@/spec/req'
import { STATE_LABEL, statusLabel, statusTone } from '@/live/status-label'
import { isSampleHref, measuredEstimate, SAMPLE_DEVICES, OTHER_FOCUS_AREA_ID, type Device, type LiveState, type Request, type Run, type SkillRun } from '@/data'
import { agentById, deviceById, useConnection, useStore, useWorkModel, useWorkspace } from '@/store'
import type { AutoRefresh } from '@/live/work-data-source'
import { focusAreaLabel, resolveFocusAreaId } from '@/live/to-focus-model'
import { presentSharedState } from '@/live/shared-state-presentation'
import { AgentMark } from './brand'

/**
 * The sliding highlight behind the active choice in a nav or toggle group (the `layoutId` pattern from aceternity/tabs).
 * Render it inside the active item only; the item needs `relative` and its content `relative` to sit above it.
 * Each group passes its own `layoutId` so pills never jump between groups.
 */
export function ActivePill({ layoutId, className }: { layoutId: string; className?: string }) {
  return <motion.span layoutId={layoutId} transition={{ type: 'spring', bounce: 0.3, duration: 0.6 }} className={cn('absolute inset-0 rounded-[inherit] bg-accent', className)} />
}


/** Agent mark, plus the machine it ran on (§13: remote agents are already synced, say where the work happened). */
export function AgentIcon({ agentId, withDevice = false }: { agentId: string; withDevice?: boolean }) {
  const { t } = useI18n()
  const agent = agentById(agentId)
  const device = deviceById(agent.deviceId)
  const onText = interpolate(t('on {name}'), { name: device.name })
  return (
    <Req ids={['R5.1', 'R10.4']}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex min-w-0 items-center gap-1.5">
            <span className="flex size-7 shrink-0 items-center justify-center rounded-lg border bg-card" aria-label={`${agent.name}, ${agent.role}, ${onText}`}>
              <AgentMark tool={agent.tool} className="size-4" />
            </span>
            {withDevice && <Req ids={['R13.4']}><span className="truncate text-xs text-muted-foreground">{agent.name} · {agent.role} · {device.name}</span></Req>}
          </span>
        </TooltipTrigger>
        <TooltipContent>{agent.name} · {agent.role} · {onText}</TooltipContent>
      </Tooltip>
    </Req>
  )
}

/** Each state's colors. */
export const STATE_SURFACE: Record<LiveState, string> = {
  working: 'border-working-border bg-working text-working-foreground',
  'needs-check': 'border-review-border bg-review text-review-foreground',
  'your-move': 'border-attention-border bg-attention font-medium text-attention-foreground',
  idle: 'border-idle-border bg-idle text-idle-foreground',
  checked: 'border-shipped-border bg-transparent text-shipped-foreground',
  closed: 'border-idle-border bg-transparent text-idle-foreground',
  shipped: 'border-shipped-border bg-shipped text-shipped-foreground',
}

/** The state's dot, shared by the badge and the thread list. */
export const STATE_DOT: Record<LiveState, string> = {
  working: 'bg-working-foreground motion-safe:animate-pulse',
  'needs-check': 'bg-review-foreground',
  'your-move': 'bg-attention-foreground',
  idle: 'bg-idle-foreground',
  // Resting without a ship: the shipped color, lighter, and a hollow ring for a thread that was closed.
  checked: 'bg-shipped-foreground/50',
  closed: 'border border-idle-foreground bg-transparent',
  shipped: 'bg-shipped-foreground',
}

/** One glance tells working, done-but-unchecked, waiting on you and shipped apart (§6). State is the only thing colored. */
export function StateBadge({ state, next }: { state: LiveState; next?: Request['next'] }) {
  const { t } = useI18n()
  // With the next step, the badge says what a person owes ("Needs you · review") in that move's colours.
  const tone = next ? statusTone({ state, next }) : state
  return (
    <Req ids={['R6.2']}>
      <Badge variant="outline" className={cn('shrink-0 gap-1.5 font-normal', STATE_SURFACE[tone])}>
        <span className={cn('size-1.5 rounded-full', STATE_DOT[tone])} />
        {next ? statusLabel({ state, next }, t) : t(STATE_LABEL[state])}
      </Badge>
    </Req>
  )
}

/**
 * The focus area a request sits in: the area's name, "Other", or "Sorting…" before the next refresh places it.
 * A quiet link, not a colored pill: color is reserved for state. Opens My Work on that area.
 */
export function FocusAreaChip({ focusAreaId, onOpen }: { focusAreaId?: string; onOpen?: (focusAreaId: string) => void }) {
  const { t } = useI18n()
  const { focusAreas } = useWorkModel()
  const placed = resolveFocusAreaId(focusAreaId, focusAreas)
  const label = focusAreaLabel(focusAreaId, focusAreas)
  return (
    <Req ids={['R16.5']}>
      {placed ? (
        <button type="button" onClick={(event) => { event.stopPropagation(); onOpen?.(placed) }} className="inline-flex min-h-11 max-w-full items-center gap-1.5 self-start text-left text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline md:min-h-6">
          <CornerLeftUpIcon className="size-3.5 shrink-0" />
          <span className="truncate">{placed === OTHER_FOCUS_AREA_ID ? t('Other') : label}</span>
        </button>
      ) : (
        // Not placed yet is not the same claim as Other: the next refresh places it.
        <span className="inline-flex min-h-6 items-center gap-1.5 self-start text-xs text-muted-foreground/80 italic">{t(label)}</span>
      )}
    </Req>
  )
}

/** Whose move is next: the agent's or yours (§5). A person's move is the one thing that gets weight. */
export function NextMove({ next, className }: { next: Request['next']; className?: string }) {
  const { t } = useI18n()
  if (!next.text) return null
  const human = next.who === 'human'
  return (
    <Req ids={['R5.8', 'R6.3']}>
      <div className={cn('flex items-start gap-2 text-[0.84rem] leading-snug', human ? 'font-medium text-attention-foreground' : 'text-foreground/80', className)}>
        <span className={cn('mt-px flex size-5 shrink-0 items-center justify-center rounded-full', human ? 'bg-attention' : 'bg-muted')}>
          {human ? <UserIcon className="size-3" /> : <BotIcon className="size-3" />}
        </span>
        <span><span className="sr-only">{human ? t('Your move: ') : t('Agent’s move: ')}</span>{next.text}</span>
      </div>
    </Req>
  )
}

/** What the last memory review covered: "2 of 3 workstreams reviewed". */
export function reviewCoverage(request: Request, t?: (s: string) => string) {
  const { coverage, readings, reviewedAt } = request.progress
  const tr = t ?? ((s: string) => s)
  if (!readings) return tr('Not reviewed yet')
  if (!coverage) return interpolate(tr('reviewed {reviewedAt}'), { reviewedAt })
  const template = coverage.total === 1 ? tr('{reviewed} of {total} workstream reviewed {reviewedAt}') : tr('{reviewed} of {total} workstreams reviewed {reviewedAt}')
  return interpolate(template, { reviewed: coverage.reviewed, total: coverage.total, reviewedAt })
}

/** Progress from the last memory review (§5), with the measured-pace estimate only when it exists (decision 3). */
export function ProgressMeter({ request, compact = false }: { request: Request; compact?: boolean }) {
  const { t } = useI18n()
  const { progress } = request
  const estimate = measuredEstimate(request)
  const translatedEstimate = estimate
    ? (estimate.startsWith('at this pace, about ')
      ? interpolate(t('at this pace, about {date}'), { date: estimate.slice('at this pace, about '.length) })
      : t(estimate))
    : null
  return (
    <Req ids={['R5.9', 'R5.6', 'R5.11']}>
      <div className="space-y-1.5">
        <Progress value={progress.percent ?? 0} aria-label={progress.percent === null ? t('Not reviewed yet') : interpolate(t('{percent}% complete'), { percent: progress.percent })} className={cn('h-1.5 bg-muted [&_[data-slot=progress-indicator]]:duration-700 [&_[data-slot=progress-indicator]]:ease-out', request.state === 'working' && 'progress-sweep', {
          '[&_[data-slot=progress-indicator]]:bg-working-foreground/75': request.state === 'working',
          '[&_[data-slot=progress-indicator]]:bg-review-foreground/75': request.state === 'needs-check',
          '[&_[data-slot=progress-indicator]]:bg-attention-foreground/75': request.state === 'your-move',
          '[&_[data-slot=progress-indicator]]:bg-idle-foreground/75': request.state === 'idle',
          '[&_[data-slot=progress-indicator]]:bg-shipped-foreground/75': request.state === 'shipped',
        })} />
        <div className="flex flex-wrap justify-between gap-x-2 text-xs text-muted-foreground">
          <span>{progress.completedAt ? interpolate(t('Completed {completedAt}'), { completedAt: progress.completedAt }) : progress.readings ? <><span className="font-medium text-foreground/80 tabular-nums">{progress.percent}%</span>{compact ? '' : ` · ${reviewCoverage(request, t)}`}</> : t('Not reviewed yet')}</span>
          {!compact && translatedEstimate && <span>{translatedEstimate}</span>}
        </div>
      </div>
    </Req>
  )
}

/** A work-product link. Fixture links have nothing behind them, so they say so instead of looking real (§12). */
/** No href: a recorded item with nothing to open (a commit whose remote is not GitHub). */
export function ProductLink({ href, children, className }: { href?: string; children: ReactNode; className?: string }) {
  const { t } = useI18n()
  if (href === undefined) return <span className={className}>{children}</span>
  if (!isSampleHref(href)) return <a href={href} target="_blank" rel="noreferrer" className={className}>{children}</a>
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0} className={cn('cursor-help', className)}>
          {children}
          <span className="ml-2 shrink-0 rounded border border-dashed px-1.5 text-[10px] text-muted-foreground">{t('sample')}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent>{t('Sample link. The real page attaches when the agent records it.')}</TooltipContent>
    </Tooltip>
  )
}

/**
 * Live connection indicator (§6). Sample mode demonstrates the placement. A live source shows the feed's measured
 * health (getConnectionStatus): it reads "Live updates" only while SSE messages keep arriving, never from an HTTP read.
 */
export function LiveIndicator() {
  const { t } = useI18n()
  const { mode } = useWorkspace()
  const { sourceKind, sharedState } = useWorkModel()
  const shared = sourceKind === 'sample' ? null : presentSharedState(sharedState)
  const connection = useConnection()
  const demonstration = sourceKind === 'sample'
  const live = demonstration || connection.isLive
  return (
    <Req ids={['R6.1', 'R6.4', 'R8.1']}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span tabIndex={0} data-connection-state={demonstration ? 'demonstration' : connection.state} className="inline-flex h-8 items-center gap-1.5 px-1 text-xs text-muted-foreground">
            <span className="relative flex size-2">
              {live && <span className="absolute inline-flex size-full rounded-full bg-shipped-foreground/40 motion-safe:animate-ping" />}
              <span className={cn('relative inline-flex size-2 rounded-full', live ? 'bg-shipped-foreground' : connection.tone === 'warning' ? 'bg-attention-foreground' : 'bg-idle-foreground')} />
            </span>
            {/* Keep transport and cloud freshness distinct on phones as well as wider screens. */}
            <span className="sr-only sm:not-sr-only">{demonstration ? t('Live') : t(connection.label)}</span>
            {!demonstration && connection.sync && (
              <span role="status" aria-label={`${connection.sync.label}. ${connection.sync.detail}`} data-sync-state={connection.sync.state} className={cn('inline-flex items-center border-l pl-2', connection.sync.tone === 'warning' ? 'text-attention-foreground' : 'text-muted-foreground')}>
                {connection.sync.tone === 'warning' ? <CloudAlertIcon aria-hidden="true" className="size-4 shrink-0 sm:hidden" />
                  : connection.sync.isCurrent ? <CloudCheckIcon aria-hidden="true" className="size-4 shrink-0 sm:hidden" />
                    : <CloudIcon aria-hidden="true" className="size-4 shrink-0 sm:hidden" />}
                <span className="sr-only sm:not-sr-only">{connection.sync.label}</span>
              </span>
            )}
            {shared && <span role="status" aria-label={`${shared.label}. ${shared.detail}`} data-shared-state={shared.state} className={cn('inline-flex items-center border-l pl-2', shared.attention && 'text-attention-foreground')}>
              {shared.attention ? <CloudAlertIcon aria-hidden="true" className="size-4 sm:hidden" /> : shared.state === 'disabled' ? <CloudOffIcon aria-hidden="true" className="size-4 sm:hidden" /> : <CloudIcon aria-hidden="true" className="size-4 sm:hidden" />}
              <span className="sr-only sm:not-sr-only">{shared.label}</span>
            </span>}
          </span>
        </TooltipTrigger>
        <TooltipContent className="max-w-72">
          {demonstration
            ? mode === 'home' ? t('Streams from the local worker, localhost:37777 (demonstration)') : t('Checks cmem.ai for new sync changes every few seconds (demonstration)')
            : <>{t(connection.detail)} {connection.tooltip} {connection.sync?.detail} {shared?.detail}</>}
        </TooltipContent>
      </Tooltip>
    </Req>
  )
}

/** Which machines are reporting and how fresh each one is (§13.6). This computer's freshness is the live feed's. */
export function DeviceFreshness() {
  const { t } = useI18n()
  const { sourceKind, devices } = useWorkModel()
  const connection = useConnection()
  const reportingNow = (device: Device) => sourceKind === 'sample' || device.syncedMinutesAgo !== 0 ? device.online : connection.isLive
  return (
    <Req ids={['R13.8', 'R13.2']}>
      <HoverCard openDelay={100}>
        <HoverCardTrigger asChild>
          <Button variant="ghost" size="sm" className="px-2 text-xs text-muted-foreground">{devices.length}<span className="hidden sm:inline">{devices.length === 1 ? t('machine') : t('machines')}</span><span className="sr-only sm:hidden">{devices.length === 1 ? t('machine') : t('machines')}</span></Button>
        </HoverCardTrigger>
        <HoverCardContent className="w-64 space-y-2">
          <p className="text-xs font-medium">{t('Machines reporting into this view')}</p>
          {devices.map((device) => (
            <div key={device.id} className="flex items-center justify-between text-xs">
              <span className="flex items-center gap-2">
                <span className={cn('size-1.5 rounded-full', reportingNow(device) ? 'bg-shipped-foreground' : 'bg-idle-foreground')} />
                {device.name}
              </span>
              <span className="text-muted-foreground">{device.syncedMinutesAgo !== 0 ? interpolate(t('synced {minutes} min ago'), { minutes: device.syncedMinutesAgo }) : sourceKind === 'sample' ? t('this machine') : t(connection.label)}</span>
            </div>
          ))}
          {sourceKind !== 'sample' && <p className="text-xs text-muted-foreground">{connection.tooltip}</p>}
        </HoverCardContent>
      </HoverCard>
    </Req>
  )
}

const CLAUDE_MEM_REPO_URL = 'https://github.com/thedotmack/claude-mem'
const CLAUDE_MEM_REPO_API_URL = 'https://api.github.com/repos/thedotmack/claude-mem'

/** The repo's GitHub star count, read once from the public API. Shows no number until a real one arrives. */
export function GitHubStars() {
  const { t, locale } = useI18n()
  const [stargazerCount, setStargazerCount] = useState<number | null>(null)
  useEffect(() => {
    let cancelled = false
    fetch(CLAUDE_MEM_REPO_API_URL)
      .then((response) => {
        if (!response.ok) throw new Error(`GitHub repo read failed: HTTP ${response.status}`)
        return response.json() as Promise<{ stargazers_count: number }>
      })
      .then((repo) => { if (!cancelled) setStargazerCount(repo.stargazers_count) })
      .catch((error: unknown) => console.warn('[my-work] GitHub star count unavailable:', error))
    return () => { cancelled = true }
  }, [])
  return (
    <Button asChild variant="outline" size="sm" className="h-7 gap-1.5 px-2 text-xs">
      <a href={CLAUDE_MEM_REPO_URL} target="_blank" rel="noreferrer" aria-label={t('Star claude-mem on GitHub')}>
        <StarIcon className="size-3.5" />
        <span className="hidden sm:inline">{t('Star')}</span>
        {stargazerCount !== null && <span className="tabular-nums">{new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 }).format(stargazerCount)}</span>}
      </a>
    </Button>
  )
}

/** Opens the My Work feedback form on GitHub (.github/ISSUE_TEMPLATE/my-work-feedback.yml). */
const MY_WORK_FEEDBACK_URL = `${CLAUDE_MEM_REPO_URL}/issues/new?template=my-work-feedback.yml`

export function FeedbackLink() {
  const { t } = useI18n()
  return (
    <Button asChild variant="outline" size="sm" className="h-7 gap-1.5 px-2 text-xs">
      <a href={MY_WORK_FEEDBACK_URL} target="_blank" rel="noreferrer" aria-label={t('Send feedback about My Work on GitHub')}>
        <MessageSquareIcon className="size-3.5" />
        <span className="hidden sm:inline">{t('Feedback')}</span>
      </a>
    </Button>
  )
}

/** The previous memory viewer, still served by the worker at /viewer. */
export function ClassicViewerLink() {
  const { t } = useI18n()
  return (
    <a href="/viewer" className="hidden text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline md:inline" title={t('Open the previous memory viewer')}>
      {t('Classic viewer')}
    </a>
  )
}

/** Sample runs only (their machines are fixtures). Runs a skill from the GUI (§14): last run time, machine and progress (cost display dropped by the owner, Oct 20, 2026). On the web it queues for an online machine. */
export function RefreshButton({ run, ids }: { run: Run; ids: string[] }) {
  const { t } = useI18n()
  const { mode } = useWorkspace()
  const [state, setState] = useState(run.state)
  const nextMachine = SAMPLE_DEVICES.find((device) => device.online)!
  const runMachine = SAMPLE_DEVICES.find((device) => device.id === run.deviceId)
  if (!runMachine) throw new Error(`Sample run ${run.label} names no sample device ${run.deviceId}`)
  const start = () => {
    setState(mode === 'web' ? 'queued' : 'running')
    setTimeout(() => setState('idle'), 2400)
  }
  return (
    <Req ids={[...ids, 'R14.10', 'R14.11']}>
      <div className="flex w-full items-center gap-3 sm:w-auto">
        <span className="min-w-0 flex-1 text-xs leading-tight text-muted-foreground sm:text-right" aria-live="polite">
          {state === 'queued' && <>{interpolate(t('Queued for {name}'), { name: nextMachine.name })}</>}
          {state === 'running' && <>{interpolate(t('Running {label} on {name}…'), { label: run.label, name: runMachine.name })}</>}
          {state === 'idle' && <>{interpolate(t('Last run {lastRunAt}'), { lastRunAt: displayTime(run.lastRunAt) })}<br />{interpolate(t('on {name}'), { name: runMachine.name })}</>}
        </span>
        <Button variant="outline" size="sm" className="h-11 min-w-11 md:h-8 md:min-w-0" onClick={start} disabled={state !== 'idle'} aria-label={interpolate(t('Refresh {label}'), { label: run.label })}>
          {state === 'idle' ? <RefreshCwIcon /> : <Spinner />}
          {t('Refresh')}
        </Button>
      </div>
    </Req>
  )
}

/**
 * The worker's automatic refresh: it runs owner-goals and request-progress on
 * the user's own logged-in agent whenever something is due, so there is no
 * command to copy. Before its first run, the last saved run shows instead.
 */
export function RefreshStatus({ refresh, run, ids, label = 'Last run' }: { refresh: AutoRefresh | null; run: SkillRun | null; ids: string[]; label?: string }) {
  const { t } = useI18n()
  let text: ReactNode = null
  if (refresh?.state === 'running') text = <span className="inline-flex items-center gap-1.5"><Spinner />{t('Updating your goals and progress…')}</span>
  else if (refresh?.error) text = refresh.state === 'waiting-for-agent' ? <>{interpolate(t('Waiting to refresh: {error}'), { error: refresh.error })}</> : <>{interpolate(t('Refresh failed: {error}'), { error: refresh.error })}</>
  else if (refresh?.finishedAt) text = <>{interpolate(t('Last refreshed {finishedAt}'), { finishedAt: refresh.finishedAt })}</>
  else if (run) text = <>{t(label)} {displayTime(run.lastRunAt)}<br />{interpolate(t('on {name}'), { name: run.deviceName })}</>
  if (!text) return null
  return (
    <Req ids={[...ids, 'R14.10']}>
      <span className="block w-full text-xs leading-tight text-muted-foreground sm:w-auto sm:text-right" aria-live="polite">{text}</span>
    </Req>
  )
}

/** Starts the local goals and progress refresh on demand. */
export function ManualRefreshButton({ ids, running = false }: { ids: string[]; running?: boolean }) {
  const { t } = useI18n()
  const refreshWork = useStore((state) => state.refreshWork)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [nothingNew, setNothingNew] = useState(false)
  const start = async () => {
    setPending(true)
    setError(null)
    setNothingNew(false)
    try { setNothingNew((await refreshWork()).state === 'idle') }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setPending(false) }
  }
  return (
    <Req ids={ids}>
      <div className="flex items-center gap-2">
        {error && <span role="alert" className="text-xs text-attention-foreground">{error}</span>}
        {nothingNew && !running && <span aria-live="polite" className="text-xs text-muted-foreground">{t('Nothing new to refresh')}</span>}
        <Button variant="outline" size="sm" className="h-11 min-w-11 md:h-8 md:min-w-0" onClick={start} disabled={pending || running}>
          {pending || running ? <Spinner /> : <RefreshCwIcon />}
          {t('Refresh now')}
        </Button>
      </div>
    </Req>
  )
}
