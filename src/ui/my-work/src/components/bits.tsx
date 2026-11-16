import { clockTime, displayTime } from '@/lib/display-time'
import { useState, type KeyboardEvent, type ReactNode } from 'react'
import { motion, useReducedMotion } from 'motion/react'
import { BotIcon, CheckIcon, CloudAlertIcon, CloudIcon, CornerLeftUpIcon, ExternalLinkIcon, HistoryIcon, LaptopIcon, MessageSquareIcon, RefreshCwIcon, Share2Icon, StarIcon, UserIcon } from 'lucide-react'
import { interpolate, useI18n } from '@/lib/i18n'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleFoldTrigger } from '@/components/ui/collapsible'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Progress } from '@/components/ui/progress'
import { Spinner } from '@/components/ui/spinner'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useGitHubStarCount } from '@/lib/use-github-star-count'
import { tabStopAfter, tabStops } from '@/lib/tab-order'
import { cn } from '@/lib/utils'
import { Req } from '@/spec/req'
import { isSampleHref, measuredEstimate, RefreshNotStartedError, SAMPLE_DEVICES, OTHER_FOCUS_AREA_ID, type AgentTool, type Device, type LiveState, type Request, type Run, type SkillRun } from '@/data'
import { agentById, deviceById, useConnection, useStore, useWorkModel, useWorkspace } from '@/store'
import type { AutoRefresh } from '@/live/work-data-source'
import { focusAreaLabel, resolveFocusAreaId } from '@/live/to-focus-model'
import { presentSharedState } from '@/live/shared-state-presentation'
import { isServedFromCloud } from '@/live/served-from'
import { LIVE_CHIP_PROBLEM_SOURCE, liveChipProblem, type LiveChipProblem } from '@/live/live-chip'
import type { ConnectionTone } from '@/live/connection-status'
import type { StarCountRead } from '@/live/github-star-count'
import { NEXT_STEP_NOT_RECORDED, RECORDED_SESSION_ROLE, SUBAGENT_ROLE_PREFIX, THIS_COMPUTER, UNRECORDED_AGENT } from '@/live/to-work-model'
import { AgentMark } from './brand'

/**
 * How a selected item shows besides its fill (c-bits-active-pill): an edge ≥3:1 against the page (rule 7; the fill
 * alone told selected from not by 1.53–1.9:1), and in the rail an orange bar at its left edge as well. `fill` is for a
 * control that draws its own ≥3:1 chosen edge already (the View switch's toggle items, D b22). The bar is the accent
 * text colour, ≥4.8:1 on the accent fill in both themes.
 */
const ACTIVE_PILL_LOOK = {
  fill: 'bg-accent',
  outline: 'border border-control-edge bg-accent',
  rail: 'border border-control-edge bg-accent before:absolute before:inset-y-1.5 before:left-0 before:w-[3px] before:rounded-full before:bg-accent-foreground',
} as const

/**
 * The slide between choices. The review measured a 0.3 bounce over 0.6 s, long for a switch the owner flips many times
 * an hour (c-bits-active-pill F spring-physics); 0.25 s with no bounce is the subtle transition of the UI UX Pro Max
 * design system for this product (Motion 2/10, 200–250 ms; the review's skill-output/design-system-from-first-run.md).
 */
const ACTIVE_PILL_SLIDE = { type: 'spring', bounce: 0, duration: 0.25 } as const

/**
 * The sliding highlight behind the active choice in a nav or toggle group (the `layoutId` pattern from aceternity/tabs).
 * Render it inside the active item only; the item needs `relative` and its content `relative` to sit above it.
 * Each group passes its own `layoutId` so pills never jump between groups. Under reduced motion it moves at once,
 * here in the component and not only through the app's MotionConfig (plan rule 8).
 */
export function ActivePill({ layoutId, className, look = 'fill' }: { layoutId: string; className?: string; look?: keyof typeof ACTIVE_PILL_LOOK }) {
  const reduceMotion = useReducedMotion()
  return <motion.span layoutId={layoutId} transition={reduceMotion ? { duration: 0 } : ACTIVE_PILL_SLIDE} className={cn('absolute inset-0 rounded-[inherit]', ACTIVE_PILL_LOOK[look], className)} />
}

/** How many requests in a rail entry need the person, as words in a quiet pill (c-shell-focus-nav: was an orange dot). */
export function NeedsYouPill({ count, className }: { count: number; className?: string }) {
  const { t } = useI18n()
  if (count === 0) return null
  return (
    <span className={cn('inline-flex shrink-0 items-center gap-1 rounded-full border border-control-edge px-1.5 py-px text-xs font-normal whitespace-nowrap text-attention-foreground tabular', className)}>
      <span aria-hidden="true" className="size-1.5 rounded-full bg-attention-foreground" />
      {interpolate(t(count === 1 ? '{count} needs you' : '{count} need you'), { count })}
    </span>
  )
}

/** Puts a node where a translated sentence has its `{slot}`, so a time or a command can sit inside the sentence. */
function sentenceWith(sentence: string, slot: string, node: ReactNode): ReactNode {
  const [before, after = ''] = sentence.split(`{${slot}}`)
  return <>{before}{node}{after}</>
}

/**
 * A recorded time in the reader's clock (G9, plan rule 9): short, with the full stamp on hover, keyboard focus and tap
 * (G10). Times were printed as raw UTC stamps (c-bits-live-indicator, c-bits-device-freshness).
 */
export function LocalTime({ iso, className }: { iso: string; className?: string }) {
  const time = clockTime(iso)
  if (!time) throw new Error(`LocalTime needs an ISO time, got ${JSON.stringify(iso)}`)
  return (
    <Tooltip>
      <TooltipTrigger asChild><time dateTime={iso} className={cn('tabular', className)}>{time.short}</time></TooltipTrigger>
      <TooltipContent>{time.full}</TooltipContent>
    </Tooltip>
  )
}

/** "This computer" is the mapper's English name for the machine the page runs on; any other machine keeps its own name. */
function deviceName(device: Device, t: (text: string) => string): string {
  return device.id === THIS_COMPUTER.id ? t(THIS_COMPUTER.name) : device.name
}

/**
 * The tool's own name, printed beside its mark where there is room (c-bits-agent-icon M, c-shell-brand M): nearly every
 * card carries the same mark, and on a phone the name was in a tooltip only. An agent on a platform we have no mark
 * for shows its own name instead.
 */
const AGENT_TOOL_NAME: Record<AgentTool, string | null> = {
  claude: 'Claude Code',
  codex: 'Codex',
  gemini: 'Gemini',
  other: null,
}

/**
 * An agent's role in the reader's language: the mapper's own English words (live/to-work-model.ts toAgent) go through
 * the catalog; a session title or folder name is the agent's and stays as written.
 */
function agentRoleWords(role: string, t: (text: string) => string): string {
  if (role.startsWith(SUBAGENT_ROLE_PREFIX)) return interpolate(t('Subagent · {role}'), { role: agentRoleWords(role.slice(SUBAGENT_ROLE_PREFIX.length), t) })
  return role === RECORDED_SESSION_ROLE ? t(RECORDED_SESSION_ROLE) : role
}

/**
 * Agent mark with its name, plus the machine it ran on (§13: remote agents are already synced, say where the work
 * happened). The tile edge is the ≥3:1 control edge (was 1.34–1.66:1), dashed for "Agent not recorded" so it never
 * reads as a known agent. `showName={false}` keeps the mark alone where a row has no room (the List).
 */
export function AgentIcon({ agentId, withDevice = false, showName = true }: { agentId: string; withDevice?: boolean; showName?: boolean }) {
  const { t } = useI18n()
  const agent = agentById(agentId)
  const device = deviceById(agent.deviceId)
  const unrecorded = agent.id === UNRECORDED_AGENT.id
  const name = unrecorded ? t(UNRECORDED_AGENT.name) : AGENT_TOOL_NAME[agent.tool] ?? agent.name
  const where = deviceName(device, t)
  // The agent's own name (often a worktree id) and its role only when they add something to the tool's name.
  const details = unrecorded ? [] : [...(agent.name !== name ? [agent.name] : []), agentRoleWords(agent.role, t)]
  const identity = [name, ...details, interpolate(t('on {name}'), { name: where })].join(' · ')
  return (
    <Req ids={['R5.1', 'R10.4']}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex min-w-0 items-center gap-1.5">
            {/* role="img" names the mark with everything known (G10: the trigger is a Tab stop); the words beside it
                repeat part of that, so readers skip them. */}
            <span role="img" aria-label={identity} className={cn('flex size-7 shrink-0 items-center justify-center rounded-lg border border-control-edge bg-card', unrecorded && 'border-dashed')}>
              <AgentMark tool={agent.tool} className="size-4" />
            </span>
            {withDevice ? (
              <Req ids={['R13.4']}>
                {/* A worktree id is one long word: it wraps instead of running out of the drawer (B #17 F). */}
                <span aria-hidden="true" className="min-w-0 text-xs text-muted-foreground [overflow-wrap:anywhere]">
                  <span className={unrecorded ? undefined : 'font-medium text-foreground/85'}>{name}</span>
                  {details.map((detail, index) => <span key={index}> · <span className={index === 0 && agent.name !== name ? 'font-mono' : undefined}>{detail}</span></span>)}
                  {' · '}<LaptopIcon aria-hidden="true" className="inline size-3.5 align-[-2px]" /> {where}
                </span>
              </Req>
            ) : showName && (
              // 9rem holds "Agent not recorded" and every tool name; a longer agent name ends in an ellipsis (the full
              // identity is in the tooltip), so the focus area link beside it keeps its room on a card.
              <span aria-hidden="true" className={cn('max-w-[9rem] truncate text-xs', unrecorded ? 'text-muted-foreground' : 'text-foreground/80')}>{name}</span>
            )}
          </span>
        </TooltipTrigger>
        <TooltipContent>{identity}</TooltipContent>
      </Tooltip>
    </Req>
  )
}

export const STATE_LABEL: Record<LiveState, string> = {
  working: 'Working', 'needs-check': 'Done, not checked', 'your-move': 'Your move', idle: 'Idle', shipped: 'Shipped',
}

/** Attention first: what waits on you, then what to check, then what is moving, then the rest. */
export const ATTENTION_ORDER: LiveState[] = ['your-move', 'needs-check', 'working', 'idle', 'shipped']

/**
 * Each state's colors, shared by the badge and the List view's flipboard so both read as the same state. The edge is
 * the state's own text colour at 80%: ≥3.18:1 against the card and the page in both themes (plan rule 7; the *-border
 * tokens measured 1.4–1.9:1 against the card).
 */
export const STATE_SURFACE: Record<LiveState, string> = {
  working: 'border-working-foreground/80 bg-working text-working-foreground',
  'needs-check': 'border-review-foreground/80 bg-review text-review-foreground',
  'your-move': 'border-attention-foreground/80 bg-attention font-medium text-attention-foreground',
  idle: 'border-idle-foreground/80 bg-idle text-idle-foreground',
  shipped: 'border-shipped-foreground/80 bg-shipped text-shipped-foreground',
}

/**
 * The mark beside each state's word (decision G11), so a state never rests on colour alone: your move a filled dot,
 * done but not checked a half dot, working an open ring, idle a hollow ring, shipped a check. Every mark is still:
 * a turning ring on each working badge put 14 moving things on the home page, and rule 8 allows two per view, so a
 * card's one activity indicator is what moves. Drawn in the state's text colour, ≥4.6:1 on its fill. One table for
 * StateBadge, the List status pill and the split-flap rows. Each entry draws at render time, so importing this file
 * creates no elements.
 */
const STATE_MARK: Record<LiveState, () => ReactNode> = {
  'your-move': () => <span className="size-2 rounded-full bg-current" />,
  'needs-check': () => <span className="size-2.5 rounded-full border-[1.5px] border-current bg-[linear-gradient(90deg,currentColor_50%,transparent_50%)]" />,
  working: () => <span className="size-2.5 rounded-full border-[1.5px] border-current border-t-transparent" />,
  idle: () => <span className="size-2.5 rounded-full border-[1.5px] border-current" />,
  shipped: () => <CheckIcon className="size-3 stroke-3" />,
}

export function StateMark({ state, className }: { state: LiveState; className?: string }) {
  return (
    <span data-state-mark={state} aria-hidden="true" className={cn('inline-flex size-3 shrink-0 items-center justify-center', className)}>
      {STATE_MARK[state]()}
    </span>
  )
}

/** One glance tells working, done-but-unchecked, waiting on you and shipped apart (§6). State is the only thing colored. */
export function StateBadge({ state }: { state: LiveState }) {
  const { t } = useI18n()
  return (
    <Req ids={['R6.2']}>
      <Badge variant="outline" data-state-badge={state} className={cn('shrink-0 gap-1.5 font-normal', STATE_SURFACE[state])}>
        <StateMark state={state} />
        {t(STATE_LABEL[state])}
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

/**
 * The next step to show, or null when none is recorded: no text, or the English filler (NEXT_STEP_NOT_RECORDED) that
 * the mapper, older workers and the 15.19.0 worker the preview reads write in its place. Decision G3: the UI treats
 * that filler as a missing step, not as a step.
 */
function recordedNextStep(next: Request['next'] | null | undefined): Request['next'] | null {
  const text = next?.text?.trim()
  return next && text && text !== NEXT_STEP_NOT_RECORDED ? next : null
}

/** Whose move a next step is, worded on screen (c-bits-next-move: these words were for screen readers only). */
const NEXT_MOVE_OWNER_WORDS: Record<Request['next']['who'], string> = {
  human: 'Your move',
  bot: 'Agent’s move',
}

/**
 * Whose move is next: the agent's or yours (§5), with its words on screen. A person's move is the one thing that gets
 * weight. A missing step (G3) draws nothing on cards and in the drawer (`whenMissing="omit"`); the List passes
 * `"dash"` for "—" with "No next step recorded" read out.
 */
export function NextMove({ next, className, whenMissing = 'omit' }: { next: Request['next'] | null | undefined; className?: string; whenMissing?: 'omit' | 'dash' }) {
  const { t } = useI18n()
  const step = recordedNextStep(next)
  if (!step) {
    if (whenMissing === 'omit') return null
    return (
      <Req ids={['R5.8', 'R6.3']}>
        <span data-next-move="missing" className={cn('text-[0.84rem] text-muted-foreground', className)}>
          <span aria-hidden="true">—</span>
          <span className="sr-only">{t('No next step recorded')}</span>
        </span>
      </Req>
    )
  }
  const human = step.who === 'human'
  return (
    <Req ids={['R5.8', 'R6.3']}>
      <div data-next-move={step.who} className={cn('flex items-start gap-2 text-[0.84rem] leading-snug', className)}>
        <span aria-hidden="true" className={cn('mt-px flex size-5 shrink-0 items-center justify-center rounded-full', human ? 'bg-attention text-attention-foreground' : 'bg-muted text-muted-foreground')}>
          {human ? <UserIcon className="size-3" /> : <BotIcon className="size-3" />}
        </span>
        <span className="min-w-0">
          <span className={cn('block text-xs font-medium', human ? 'text-attention-foreground' : 'text-muted-foreground')}>{t(NEXT_MOVE_OWNER_WORDS[step.who])}</span>
          <span className={human ? 'font-medium text-foreground' : 'text-foreground/80'}>{step.text}</span>
        </span>
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

/**
 * Each state's bar fill at full strength: ≥3:1 against the muted track in both themes (the Phase 1 contract; the /75
 * fills were 2.86:1 shipped and 3.00:1 review in light).
 */
const STATE_PROGRESS_FILL: Record<LiveState, string> = {
  working: '[&_[data-slot=progress-indicator]]:bg-working-foreground',
  'needs-check': '[&_[data-slot=progress-indicator]]:bg-review-foreground',
  'your-move': '[&_[data-slot=progress-indicator]]:bg-attention-foreground',
  idle: '[&_[data-slot=progress-indicator]]:bg-idle-foreground',
  shipped: '[&_[data-slot=progress-indicator]]:bg-shipped-foreground',
}

/**
 * Progress from the last memory review (§5), with the measured-pace estimate only when it exists (decision 3). The bar
 * reports its value, and a request no review measured shows the unknown track, not 0% (c-bits-progress-meter); a
 * finished bar ends in a check; the percent is monospace and dates keep tabular figures (plan rule 9). A working bar's
 * light sweep runs only when motion is allowed.
 */
export function ProgressMeter({ request, compact = false }: { request: Request; compact?: boolean }) {
  const { t } = useI18n()
  const motionReduced = useReducedMotion()
  const { progress } = request
  const estimate = measuredEstimate(request)
  const translatedEstimate = estimate
    ? (estimate.startsWith('at this pace, about ')
      ? interpolate(t('at this pace, about {date}'), { date: displayTime(estimate.slice('at this pace, about '.length)) })
      : t(estimate))
    : null
  return (
    <Req ids={['R5.9', 'R5.6', 'R5.11']}>
      <div className="space-y-1.5">
        <div className="flex items-center gap-1.5">
          <Progress value={progress.percent} aria-label={progress.percent === null ? t('Not reviewed yet') : interpolate(t('{percent}% complete'), { percent: progress.percent })} className={cn('[&_[data-slot=progress-indicator]]:duration-700 [&_[data-slot=progress-indicator]]:ease-out', STATE_PROGRESS_FILL[request.state], request.state === 'working' && !motionReduced && 'progress-sweep')} />
          {progress.percent === 100 && <CheckIcon data-slot="progress-finished" aria-hidden="true" className="size-3.5 shrink-0 stroke-3 text-foreground/80" />}
        </div>
        <div className="flex flex-wrap justify-between gap-x-2 text-xs text-muted-foreground tabular">
          <span>{progress.completedAt ? interpolate(t('Completed {completedAt}'), { completedAt: progress.completedAt }) : progress.readings ? <><span className="font-medium text-foreground/80 mono-number">{progress.percent}%</span>{compact ? '' : ` · ${reviewCoverage(request, t)}`}</> : t('Not reviewed yet')}</span>
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
 * The header's controls share one look (c-shell-resizable-navbar): an outlined button with the ≥3:1 control edge
 * (was 1.34:1), 34px tall on the 17px desktop root, the mockup's 32px look, and 44px on touch through the Button's own
 * touch rule; quiet text, so nothing in the bar outshines the page.
 */
const HEADER_CONTROL_CLASS_NAME = 'h-8 gap-1.5 px-2.5 text-xs font-normal text-muted-foreground'

/**
 * The chip's words for each problem it can name, short enough for a phone's header, and whether it asks for attention
 * (a problem never reads positive).
 */
const LIVE_CHIP_WORDS: Record<LiveChipProblem, { words: string; tone: Exclude<ConnectionTone, 'positive'> }> = {
  'feed-unavailable': { words: 'Can’t read work', tone: 'warning' },
  'feed-stale': { words: 'Not up to date', tone: 'warning' },
  'feed-reconnecting': { words: 'Reconnecting', tone: 'warning' },
  'feed-connecting': { words: 'Connecting', tone: 'neutral' },
  'sharing-refused': { words: 'Sharing problem', tone: 'warning' },
  'cloud-behind': { words: 'Cloud behind', tone: 'warning' },
}

/** One row of a header popover: a mark, what it is about, and its state (with a time) at the right. */
function StatusRow({ mark, title, tone = 'neutral', children }: { mark: ReactNode; title: string; tone?: ConnectionTone; children: ReactNode }) {
  return (
    <div className="flex items-start gap-2">
      <span aria-hidden="true" className="flex h-4 w-4 shrink-0 items-center justify-center text-muted-foreground">{mark}</span>
      <dt className="font-medium">{title}</dt>
      <dd className={cn('ml-auto min-w-0 text-right', tone === 'warning' ? 'text-attention-foreground' : 'text-muted-foreground')}>{children}</dd>
    </div>
  )
}

const STATUS_DOT_CLASS_NAME = 'size-2 rounded-full'

/**
 * A header panel opens with focus on the panel itself, not on its first time stamp: the stamp's tooltip opened over the
 * panel and the first Escape closed only that tooltip (seen on real data). Tab moves into the panel from there and
 * Escape closes it. Radix sends this event to the panel, which it makes focusable (tabindex -1), as in ui/sheet.tsx.
 */
function focusPanelOnOpen(event: Event) {
  event.preventDefault()
  if (event.target instanceof HTMLElement) event.target.focus({ preventScroll: true })
}

/**
 * Tab leaves a header panel as if the panel sat right after its button. The panel is drawn at the end of the page (a
 * portal), so Tab past its last control used to fall to the page body while the panel closed (WCAG 2.4.3). Now Tab
 * from the last control, or from the panel itself when it has none, goes to the stop after the button, and the panel
 * closes because focus left it (Radix). Shift+Tab from the first control, or from the panel, goes back to the button,
 * and the panel stays open. Radix points the open panel's button at the panel (`aria-controls`), so the panel's
 * `onKeyDown` is all it needs.
 */
function tabOutOfPanel(event: KeyboardEvent<HTMLDivElement>) {
  if (event.key !== 'Tab' || event.altKey || event.ctrlKey || event.metaKey) return
  const panel = event.currentTarget
  const trigger = panel.id ? document.querySelector<HTMLElement>(`[aria-controls="${CSS.escape(panel.id)}"]`) : null
  if (!trigger) return
  const stops = tabStops(panel)
  const from = document.activeElement
  const leaving = event.shiftKey
    ? from === panel || from === stops[0]
    : from === panel ? stops.length === 0 : from === stops.at(-1)
  if (!leaving) return
  // Nothing after the button: the browser's own Tab leaves the page, as it would from the button.
  const next = event.shiftKey ? trigger : tabStopAfter(trigger, panel)
  if (!next) return
  event.preventDefault()
  next.focus()
}

/**
 * Live connection chip (§6, c-bits-live-indicator). One chip: "Live" when all is well, otherwise the one problem that
 * most needs the person (live/live-chip.ts keeps the order). It opens a popover on click, tap or Enter (G10) with three
 * plain rows, this computer, the cloud copy and sharing, times in the reader's clock, and the full sentences folded
 * under Details. Sample mode demonstrates the placement. The feed reads "Live" only while SSE messages keep arriving
 * (getConnectionStatus), never from an HTTP read. Nothing moves: a pinging dot on every page was one of the many
 * moving things rule 8 counts.
 */
export function LiveIndicator() {
  const { t } = useI18n()
  const { mode } = useWorkspace()
  const { sourceKind, sharedState } = useWorkModel()
  const connection = useConnection()
  const demonstration = sourceKind === 'sample'
  const shared = demonstration ? null : presentSharedState(sharedState)
  const problem = demonstration ? null : liveChipProblem(connection, shared)
  const chip = problem ? LIVE_CHIP_WORDS[problem] : null
  const source = problem ? LIVE_CHIP_PROBLEM_SOURCE[problem] : null
  const sync = connection.sync
  // What a screen reader hears when the chip changes: its words, then the name of the state behind them. A status
  // region reads its whole text again whenever any of it changes, and the sentences behind a state carry numbers that
  // change on every poll ("Changes remaining: 1234."), so they stay in the popover's Details: a change is heard once.
  const problemLabel = source === 'feed' ? t(connection.label)
    : source === 'sharing' && shared ? t(shared.label)
      : source === 'cloud' && sync ? t(sync.label) : null
  const announcement = chip ? [t(chip.words), problemLabel].filter(Boolean).join('. ') : t('Live')
  const servedFromCloud = isServedFromCloud(window.location.hostname)
  return (
    <Req ids={['R6.1', 'R6.4', 'R8.1']}>
      <Popover>
        <PopoverTrigger asChild>
          <Button variant="outline" size="sm" data-connection-state={demonstration ? 'demonstration' : connection.state} data-live-chip={problem ?? 'live'}
            className={cn(HEADER_CONTROL_CLASS_NAME, 'min-w-0', chip?.tone === 'warning' && 'text-attention-foreground')}>
            {source === 'cloud' ? <CloudAlertIcon aria-hidden="true" />
              : <span aria-hidden="true" className={cn(STATUS_DOT_CLASS_NAME, 'shrink-0', !chip ? 'bg-shipped-foreground' : chip.tone === 'warning' ? 'bg-attention-foreground' : 'bg-idle-foreground')} />}
            {/* A feed that is live beside a cloud or sharing problem says so where there is room. */}
            {chip && source !== 'feed' && <span className="hidden sm:inline">{t('Live')} ·</span>}
            {/* Long translations end in an ellipsis on a phone rather than widening the page; the popover has them whole.
                9rem (144px on a phone): at 390px the bar has 164.8px for these words once the logo, its gaps, this chip's
                dot and padding, the machines and the menu are placed (measured on real data, 2026-11-16), so the page
                title keeps about 20px. From 640px up there is room for every language's words. */}
            <span className="max-w-[9rem] truncate sm:max-w-none">{chip ? t(chip.words) : t('Live')}</span>
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" onOpenAutoFocus={focusPanelOnOpen} onKeyDown={tabOutOfPanel} className="w-80 gap-3">
          <p className="text-sm font-medium">{t('Connection')}</p>
          {demonstration ? (
            <p className="text-xs text-muted-foreground">{mode === 'home' ? t('Streams from the local worker, localhost:37777 (demonstration)') : t('Checks cmem.ai for new sync changes every few seconds (demonstration)')}</p>
          ) : (
            <>
              <dl className="grid gap-2.5 text-xs">
                <StatusRow title={servedFromCloud ? t('Cloud feed') : t('This computer')} tone={connection.tone}
                  mark={<span className={cn(STATUS_DOT_CLASS_NAME, connection.isLive ? 'bg-shipped-foreground' : connection.tone === 'warning' ? 'bg-attention-foreground' : 'bg-idle-foreground')} />}>
                  {t(connection.label)}
                  {connection.lastSuccessfulCheckAt && <> · {sentenceWith(t('checked {time}'), 'time', <LocalTime iso={connection.lastSuccessfulCheckAt} />)}</>}
                </StatusRow>
                {sync && <StatusRow title={t('Cloud copy')} tone={sync.tone} mark={sync.tone === 'warning' ? <CloudAlertIcon className="size-4" /> : <CloudIcon className="size-4" />}>{t(sync.label)}</StatusRow>}
                {shared && <StatusRow title={t('My Work sharing')} tone={shared.attention ? 'warning' : 'neutral'} mark={<Share2Icon className="size-4" />}>{t(shared.label)}</StatusRow>}
              </dl>
              <Collapsible>
                <CollapsibleFoldTrigger className="text-xs">{t('Details')}</CollapsibleFoldTrigger>
                <CollapsibleContent className="space-y-1.5 pt-2 text-xs text-muted-foreground">
                  <p>{t(connection.detail)}</p>
                  {connection.activityCheckedAt && <p>{sentenceWith(t('Activity last inspected {time}'), 'time', <LocalTime iso={connection.activityCheckedAt} />)}</p>}
                  {connection.clockSkew && <p>{t('Source and browser clocks differ; freshness uses received heartbeats.')}</p>}
                  {/* English for now: the worker's message plus sentences from src/ui/viewer/utils/sync-presentation.ts.
                      They go through t() once that file's change in the classic viewer's worktree reaches main. */}
                  {sync && <p>{sync.detail}</p>}
                  {shared && <p>{t(shared.detail)}</p>}
                </CollapsibleContent>
              </Collapsible>
              <p className="text-xs text-muted-foreground">{t('Connection status does not indicate an agent is running.')}</p>
            </>
          )}
        </PopoverContent>
      </Popover>
      {/* The chip's words are read out when they change (Keep: role="status" on the changing text). */}
      <span role="status" className="sr-only" data-sync-state={demonstration ? undefined : sync?.state}>{announcement}</span>
    </Req>
  )
}

/** Where the cloud-sync docs explain adding a machine (docs/public/cloud-sync.mdx, "Requirements and setup"). */
const CLOUD_SYNC_GUIDE_URL = 'https://docs.claude-mem.ai/cloud-sync'
/** The command those docs give for connecting a machine to cloud sync. */
const CONNECT_MACHINE_COMMAND = 'npx claude-mem install'

/**
 * Which machines are reporting and how fresh each one is (§13.6, c-bits-device-freshness). This computer's freshness
 * is the live feed's. Opens on click, tap or Enter (G10; it was a button that did nothing, its card hover-only). Each
 * machine has a dot, a word and a time in the reader's clock; the Live sentence is not repeated here.
 */
export function DeviceFreshness({ className }: { className?: string }) {
  const { t } = useI18n()
  const { sourceKind, devices } = useWorkModel()
  const connection = useConnection()
  const sample = sourceKind === 'sample'
  const reportingNow = (device: Device) => sample || device.syncedMinutesAgo !== 0 ? device.online : connection.isLive
  const countWord = devices.length === 1 ? t('machine') : t('machines')
  return (
    <Req ids={['R13.8', 'R13.2']}>
      <Popover>
        <PopoverTrigger asChild>
          <Button variant="outline" size="sm" className={cn(HEADER_CONTROL_CLASS_NAME, className)}>
            <LaptopIcon aria-hidden="true" />
            <span className="tabular">{devices.length}</span>
            {/* A phone and the floating pill show the icon and the number; the word is still read out. */}
            <span className="max-sm:sr-only [.header-pill_&]:sr-only">{countWord}</span>
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" onOpenAutoFocus={focusPanelOnOpen} onKeyDown={tabOutOfPanel} className="w-80 gap-3">
          <p className="text-sm font-medium">{t('Machines reporting into this view')}</p>
          <dl className="grid gap-2.5 text-xs">
            {devices.map((device) => (
              <StatusRow key={device.id} title={deviceName(device, t)} mark={<span className={cn(STATUS_DOT_CLASS_NAME, reportingNow(device) ? 'bg-shipped-foreground' : 'bg-idle-foreground')} />}>
                {device.syncedMinutesAgo !== 0 ? interpolate(t('synced {minutes} min ago'), { minutes: device.syncedMinutesAgo })
                  : sample ? t('this machine')
                    : <>{t(connection.label)}{connection.lastSuccessfulCheckAt && <> · {sentenceWith(t('checked {time}'), 'time', <LocalTime iso={connection.lastSuccessfulCheckAt} />)}</>}</>}
              </StatusRow>
            ))}
          </dl>
          {devices.length === 1 && (
            <p className="border-t pt-3 text-xs text-muted-foreground">
              {sentenceWith(t('To see another machine’s work here, run {command} on it and choose CMEM Pro.'), 'command', <code className="font-mono text-foreground">{CONNECT_MACHINE_COMMAND}</code>)}{' '}
              <a href={CLOUD_SYNC_GUIDE_URL} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-foreground underline underline-offset-4 hover:decoration-2">
                {t('Cloud sync guide')}<ExternalLinkIcon aria-hidden="true" className="size-3" />
              </a>
            </p>
          )}
        </PopoverContent>
      </Popover>
    </Req>
  )
}

export const CLAUDE_MEM_REPO_URL = 'https://github.com/thedotmack/claude-mem'

/**
 * The star count in a box that keeps its width before and after it loads (c-bits-github-stars M: the button grew and
 * pushed the header when the number arrived). Seven characters fits the longest compact form our languages write
 * ("117,4 k" in French). A quiet bar stands in while GitHub is asked (at most GITHUB_STARS_TIMEOUT_MS), then the
 * number, or a dash with its reason read out when GitHub gave none (live/github-star-count.ts).
 */
export function StarCount({ read, className }: { read: StarCountRead; className?: string }) {
  const { t, locale } = useI18n()
  return (
    <span data-star-count={read.state} className={cn('inline-flex w-[7ch] shrink-0 items-center justify-end mono-number', className)}>
      {read.state === 'reading' ? <span aria-hidden="true" className="h-1.5 w-full rounded-full bg-foreground/10" />
        : read.state === 'read' ? new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 }).format(read.count)
          : <><span aria-hidden="true">—</span><span className="sr-only">{t('Star count unavailable')}</span></>}
    </span>
  )
}

/** The repo's GitHub star button. My Work's header keeps it in its "…" menu (G6); the component stays for other layouts. */
export function GitHubStars() {
  const { t } = useI18n()
  // On the bar the count is always in sight, so it is asked for at once.
  const stars = useGitHubStarCount()
  return (
    <Button asChild variant="outline" size="sm" className={cn(HEADER_CONTROL_CLASS_NAME, 'text-foreground')}>
      <a href={CLAUDE_MEM_REPO_URL} target="_blank" rel="noreferrer" aria-label={t('Star claude-mem on GitHub')}>
        <StarIcon className="size-3.5" />
        <span className="hidden sm:inline">{t('Star')}</span>
        <StarCount read={stars} />
      </a>
    </Button>
  )
}

/** Opens the My Work feedback form on GitHub (.github/ISSUE_TEMPLATE/my-work-feedback.yml). */
export const MY_WORK_FEEDBACK_URL = 'https://github.com/thedotmack/claude-mem/issues/new?template=my-work-feedback.yml'

/**
 * Feedback, which leaves the app for GitHub, so it carries an external-link mark and keeps its word on a phone
 * (c-bits-feedback-link). My Work's header keeps it in its "…" menu (G6); the component stays for other layouts.
 */
export function FeedbackLink() {
  const { t } = useI18n()
  return (
    <Button asChild variant="outline" size="sm" className={cn(HEADER_CONTROL_CLASS_NAME, 'text-foreground')}>
      <a href={MY_WORK_FEEDBACK_URL} target="_blank" rel="noreferrer" aria-label={t('Send feedback about My Work on GitHub')}>
        <MessageSquareIcon className="size-3.5" />
        <span>{t('Feedback')}</span>
        <ExternalLinkIcon aria-hidden="true" className="size-3" />
      </a>
    </Button>
  )
}

/** The previous memory viewer, still served by the worker. */
export const CLASSIC_VIEWER_PATH = '/viewer'

/**
 * The classic viewer: the door to the memory feed, an outlined button with an icon (c-bits-classic-viewer-link; it was
 * a 17px text link). From 768px up it sits in the bar; on a phone it is a row in the "…" menu (header-menu.tsx). What it
 * opens is in a tooltip, which shows on keyboard focus as well as hover (G10; it was a native title, hover only).
 */
export function ClassicViewerLink({ className }: { className?: string }) {
  const { t } = useI18n()
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button asChild variant="outline" size="sm" className={cn(HEADER_CONTROL_CLASS_NAME, 'hidden text-foreground md:inline-flex', className)}>
          <a href={CLASSIC_VIEWER_PATH}>
            <HistoryIcon aria-hidden="true" />
            {t('Classic viewer')}
          </a>
        </Button>
      </TooltipTrigger>
      <TooltipContent>{t('Open the previous memory viewer')}</TooltipContent>
    </Tooltip>
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

/**
 * Why a refresh did not start, in the person's language: the worker's own reason when it gave one (its words are the
 * worker's), otherwise the status it answered, or the failure itself (no connection).
 */
function refreshNotStartedWords(cause: unknown, t: (text: string) => string): string {
  if (cause instanceof RefreshNotStartedError) {
    return cause.workerReason !== null
      ? interpolate(t('Refresh could not start: {reason}'), { reason: cause.workerReason })
      : interpolate(t('Refresh could not start: the worker answered {status}'), { status: cause.status })
  }
  return interpolate(t('Refresh could not start: {reason}'), { reason: cause instanceof Error ? cause.message : String(cause) })
}

/** Starts the local goals and progress refresh on demand. */
export function ManualRefreshButton({ ids, running = false }: { ids: string[]; running?: boolean }) {
  const { t } = useI18n()
  const refreshWork = useStore((state) => state.refreshWork)
  const [pending, setPending] = useState(false)
  // Why the last start failed; worded at render, so the words follow a change of language.
  const [failure, setFailure] = useState<{ cause: unknown } | null>(null)
  const [nothingNew, setNothingNew] = useState(false)
  const start = async () => {
    setPending(true)
    setFailure(null)
    setNothingNew(false)
    try { setNothingNew((await refreshWork()).state === 'idle') }
    catch (cause) { setFailure({ cause }) }
    finally { setPending(false) }
  }
  return (
    <Req ids={ids}>
      <div className="flex items-center gap-2">
        {failure && <span role="alert" className="text-xs text-attention-foreground">{refreshNotStartedWords(failure.cause, t)}</span>}
        {nothingNew && !running && <span aria-live="polite" className="text-xs text-muted-foreground">{t('Nothing new to refresh')}</span>}
        <Button variant="outline" size="sm" className="h-11 min-w-11 md:h-8 md:min-w-0" onClick={start} disabled={pending || running}>
          {pending || running ? <Spinner /> : <RefreshCwIcon />}
          {t('Refresh now')}
        </Button>
      </div>
    </Req>
  )
}
