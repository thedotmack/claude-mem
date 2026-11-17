import { clockTime, displayTime } from '@/lib/display-time'
import { sentenceWith } from '@/lib/sentence-with'
import { useState, type HTMLAttributes, type KeyboardEvent, type ReactNode, type Ref } from 'react'
import { motion, useReducedMotion } from 'motion/react'
import { BotIcon, CheckIcon, CircleDashedIcon, ClockIcon, CloudAlertIcon, CloudIcon, ExternalLinkIcon, FocusIcon, HistoryIcon, LaptopIcon, MessageSquareIcon, RefreshCwIcon, Share2Icon, StarIcon, UserIcon } from 'lucide-react'
import { interpolate, useI18n } from '@/lib/i18n'
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert'
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
import { isSampleHref, measuredEstimate, RefreshNotStartedError, SAMPLE_DEVICES, OTHER_FOCUS_AREA_ID, type AgentTool, type Device, type LiveState, type NextStepMissing, type Request, type Run, type SkillRun } from '@/data'
import { agentById, deviceById, useConnection, useStore, useWorkModel, useWorkspace } from '@/store'
import type { AutoRefresh } from '@/live/work-data-source'
import { pageStartsRefresh, refreshRecordKey, shownRefreshLine, type RefreshLineState, type RefreshPressAnswer } from '@/live/refresh-line'
import { ESTIMATE_PREFIX } from '@/live/measured-estimate'
import { isRefreshStartRefusal, isWaitingForAgentReason } from '../../../../shared/work-view-refresh-reasons.ts'
import { NOT_SORTED_YET_LABEL, focusAreaLabel, resolveFocusAreaId } from '@/live/to-focus-model'
import { presentSharedState } from '@/live/shared-state-presentation'
import { isServedFromCloud } from '@/live/served-from'
import { LIVE_CHIP_PROBLEM_SOURCE, liveChipProblem, type LiveChipProblem } from '@/live/live-chip'
import type { ConnectionTone } from '@/live/connection-status'
import type { StarCountRead } from '@/live/github-star-count'
import { nextStepShown, UNRECORDED_AGENT } from '@/live/to-work-model'
import { agentRoleWords, deviceName } from '@/lib/agent-words'
import { nextStepWords } from '@/live/next-step-words'
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
      {interpolate(count === 1 ? t('{count} needs you') : t('{count} need you'), { count })}
    </span>
  )
}

/**
 * The page's translator, as word tables take it: each entry calls it on its own literal words, so the catalog test
 * (tests/ui-i18n.test.ts, which reads literal t() calls) checks every one.
 */
export type Translate = (text: string) => string

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
  const details = unrecorded ? [] : [...(agent.name !== name ? [agent.name] : []), agentRoleWords(agent, t)]
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

/** Attention first (data.ts ATTENTION_ORDER, the one definition), kept here for the screens that import it from bits. */
export { ATTENTION_ORDER } from '@/data'

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

/**
 * A state's words never break inside a word, at any width, in every language: the chip's own rule breaks a label
 * anywhere once its row runs out (components/ui/badge.tsx), and squeezed rows stacked "Working" letter by letter. The
 * badge is never narrower than its longest word, and a label longer than its whole line wraps between words only, as
 * the split-flap tiles do (components/split-flap.tsx). keep-all keeps Korean and Chinese words whole as well, which
 * otherwise break between any two syllables or characters.
 */
const STATE_BADGE_WORDS_WHOLE = 'min-w-min wrap-normal break-keep'

/**
 * One glance tells working, done-but-unchecked, waiting on you and shipped apart (§6). State is the only thing colored.
 * `children` draws the state's word another way inside the same badge and mark (the List's split-flap tiles while a
 * status changes); left out, the badge shows the word.
 */
export function StateBadge({ state, children }: { state: LiveState; children?: ReactNode }) {
  const { t } = useI18n()
  return (
    <Req ids={['R6.2']}>
      <Badge variant="outline" data-state-badge={state} className={cn('shrink-0 gap-1.5 font-normal', STATE_BADGE_WORDS_WHOLE, STATE_SURFACE[state])}>
        <StateMark state={state} />
        {children ?? t(STATE_LABEL[state])}
      </Badge>
    </Req>
  )
}

/**
 * The focus area a request sits in: the area's name or "Other", as a quiet link that opens My Work on that area
 * (c-bits-focus-area-chip). It reads as a link at rest and on touch, underlined, not only on hover, with the hand
 * cursor and a clearer hover. Its mark is the focus frame, the app's word for an area (the corner arrow meant nothing a
 * person would guess). Not placed yet is not the same claim as Other: "Not sorted yet" in upright words with a dashed
 * ring and no link look, until the next refresh places it (it read "Sorting…", italic at 80%, like a broken label).
 * Color is reserved for state, so neither is coloured. 44px on touch through the Button's own rule: its 24px desktop
 * minimum applies only where that rule does not (a plain min-h utility comes after touch-target-size in the stylesheet
 * and beat its 44px, V3). The unplaced words are the focus model's one definition (NOT_SORTED_YET_LABEL). They wrap in a
 * narrow row instead of being cut (plan rule 5: a cut must say what it hides, and these three words hide nothing), and
 * they keep the placed link's heights through the same touch rule, so the header does not change height when the next
 * refresh places the request.
 */
export function FocusAreaChip({ focusAreaId, onOpen }: { focusAreaId?: string; onOpen?: (focusAreaId: string) => void }) {
  const { t } = useI18n()
  const { focusAreas } = useWorkModel()
  const placed = resolveFocusAreaId(focusAreaId, focusAreas)
  const label = focusAreaLabel(focusAreaId, focusAreas)
  return (
    <Req ids={['R16.5']}>
      {placed ? (
        <Button variant="bare" data-focus-area="placed" onClick={(event) => { event.stopPropagation(); onOpen?.(placed) }}
          className="max-w-full gap-1.5 self-start text-xs text-muted-foreground underline decoration-control-edge underline-offset-4 md:not-pointer-coarse:min-h-6 hover-enabled:text-foreground hover-enabled:decoration-current">
          <FocusIcon aria-hidden="true" className="size-3.5 shrink-0" />
          <span className="truncate">{placed === OTHER_FOCUS_AREA_ID ? t('Other') : label}</span>
        </Button>
      ) : (
        <span data-focus-area="not-sorted" className="inline-flex min-w-0 items-center gap-1.5 self-start text-xs text-muted-foreground touch-target-size md:not-pointer-coarse:min-h-6">
          <CircleDashedIcon aria-hidden="true" className="size-3.5 shrink-0" />
          <span className="min-w-0 break-words">{t(NOT_SORTED_YET_LABEL)}</span>
        </span>
      )}
    </Req>
  )
}

/** Whose move a next step is, worded on screen (c-bits-next-move: these words were for screen readers only). */
const NEXT_MOVE_OWNER_WORDS: Record<Request['next']['who'], string> = {
  human: 'Your move',
  bot: 'Agent’s move',
}

/**
 * Why no step shows (decision G3): what a screen reader hears where the List draws "—". The words for the model's
 * missing value (data.ts NextStepMissing), one entry per reason.
 */
const NEXT_STEP_MISSING_WORDS: Record<NextStepMissing, string> = {
  'not-recorded': 'No next step recorded',
  'no-agent-work': 'No agent work recorded yet',
}

/**
 * Whose move is next: the agent's or yours (§5), with its words on screen. A person's move is the one thing that gets
 * weight. A missing step (G3: the model's missing value, or an older worker's English filler, both read by
 * nextStepShown) draws nothing on cards and in the drawer (`whenMissing="omit"`); the List passes `"dash"` for "—" with
 * the reason read out. `layout="line"` is the List's one-line cell (c-work-list-view: 48px rows): the step cut with an
 * ellipsis after its owner's icon, a person's step in the attention colour, and whose move it is read out first.
 */
export function NextMove({ next, className, whenMissing = 'omit', layout = 'block' }: {
  next: Request['next'] | null | undefined; className?: string; whenMissing?: 'omit' | 'dash'; layout?: 'block' | 'line'
}) {
  const { t } = useI18n()
  const shown = nextStepShown(next)
  if (shown.kind === 'missing') {
    if (whenMissing === 'omit') return null
    return (
      <Req ids={['R5.8', 'R6.3']}>
        <span data-next-move="missing" className={cn('text-[0.84rem] text-muted-foreground', className)}>
          <span aria-hidden="true">—</span>
          <span className="sr-only">{t(NEXT_STEP_MISSING_WORDS[shown.missing])}</span>
        </span>
      </Req>
    )
  }
  const human = shown.who === 'human'
  const ownerIcon = (
    <span aria-hidden="true" className={cn('flex shrink-0 items-center justify-center rounded-full', layout === 'line' ? 'size-4' : 'mt-px size-5', human ? 'bg-attention text-attention-foreground' : 'bg-muted text-muted-foreground')}>
      {human ? <UserIcon className={layout === 'line' ? 'size-2.5' : 'size-3'} /> : <BotIcon className={layout === 'line' ? 'size-2.5' : 'size-3'} />}
    </span>
  )
  if (layout === 'line') {
    const words = nextStepWords(shown, t)
    return (
      <Req ids={['R5.8', 'R6.3']}>
        <span data-next-move={shown.who} className={cn('flex min-w-0 items-center gap-1.5 text-[0.84rem]', className)}>
          {ownerIcon}
          <span className={cn('min-w-0 truncate', human ? 'font-medium text-attention-foreground' : 'text-foreground/80')}>
            <span className="sr-only">{interpolate(t('{owner}: {step}'), { owner: t(NEXT_MOVE_OWNER_WORDS[shown.who]), step: words })}</span>
            <span aria-hidden="true">{words}</span>
          </span>
        </span>
      </Req>
    )
  }
  return (
    <Req ids={['R5.8', 'R6.3']}>
      <div data-next-move={shown.who} className={cn('flex items-start gap-2 text-[0.84rem] leading-snug', className)}>
        {ownerIcon}
        <span className="min-w-0">
          <span className={cn('block text-xs font-medium', human ? 'text-attention-foreground' : 'text-muted-foreground')}>{t(NEXT_MOVE_OWNER_WORDS[shown.who])}</span>
          <span className={human ? 'font-medium text-foreground' : 'text-foreground/80'}>{nextStepWords(shown, t)}</span>
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
 * finished bar ends in a check; the percent is monospace and dates keep tabular figures (plan rule 9). Nothing on it
 * moves: a light sweep ran on every working bar, and with the board's working cards that broke rule 8's two moving
 * things per view (the bar still eases to a new value). `compact` is the List's cell, on one line for its 48px rows
 * (c-work-list-view, D b20 M 418): a short bar, then the percent in monospace at the right; a request no review measured
 * says so in words.
 */
export function ProgressMeter({ request, compact = false }: { request: Request; compact?: boolean }) {
  const { t } = useI18n()
  const { progress } = request
  const estimate = measuredEstimate(request)
  const translatedEstimate = estimate
    ? (estimate.startsWith(ESTIMATE_PREFIX)
      ? interpolate(t('at this pace, about {date}'), { date: displayTime(estimate.slice(ESTIMATE_PREFIX.length)) })
      : t(estimate))
    : null
  const bar = (
    <Progress value={progress.percent} aria-label={progress.percent === null ? t('Not reviewed yet') : interpolate(t('{percent}% complete'), { percent: progress.percent })} className={cn('[&_[data-slot=progress-indicator]]:duration-700 [&_[data-slot=progress-indicator]]:ease-out', compact && 'w-14 shrink-0', STATE_PROGRESS_FILL[request.state])} />
  )
  const finished = progress.percent === 100 && <CheckIcon data-slot="progress-finished" aria-hidden="true" className="size-3.5 shrink-0 stroke-3 text-foreground/80" />
  if (compact) {
    return (
      <Req ids={['R5.9', 'R5.6', 'R5.11']}>
        <div data-progress="compact" className="flex items-center justify-end gap-2 text-xs">
          {(progress.readings || progress.completedAt) && progress.percent !== null
            // The bar's name already says "30% complete", so readers skip the number beside it (it was read twice).
            ? <>{bar}<span aria-hidden="true" className="w-10 shrink-0 text-right font-medium text-foreground/80 mono-number">{progress.percent}%</span>{finished}</>
            : <span className="text-muted-foreground">{t('Not reviewed yet')}</span>}
        </div>
      </Req>
    )
  }
  return (
    <Req ids={['R5.9', 'R5.6', 'R5.11']}>
      <div className="space-y-1.5">
        <div className="flex items-center gap-1.5">
          {bar}
          {finished}
        </div>
        <div className="flex flex-wrap justify-between gap-x-2 text-xs text-muted-foreground tabular">
          <span>{progress.completedAt ? interpolate(t('Completed {completedAt}'), { completedAt: progress.completedAt }) : progress.readings ? <><span className="font-medium text-foreground/80 mono-number">{progress.percent}%</span>{` · ${reviewCoverage(request, t)}`}</> : t('Not reviewed yet')}</span>
          {translatedEstimate && <span>{translatedEstimate}</span>}
        </div>
      </div>
    </Req>
  )
}

/**
 * A work-product link (c-bits-product-link). A real link opens a new tab and says so to a screen reader (F: nothing
 * showed that). Fixture links have nothing behind them, so they say so instead of looking real (§12). No href: a
 * recorded item with nothing to open (a commit whose remote is not GitHub), drawn as plain text; the drawer's list
 * offers Copy beside it (deliverable-list.tsx). Other props, such as a tooltip trigger's handlers and its ref, reach
 * the element drawn, so a caller can give a chip its full name on focus.
 */
export function ProductLink({ href, children, className, ref, ...props }: { href?: string; children: ReactNode; className?: string; ref?: Ref<HTMLElement> } & Omit<HTMLAttributes<HTMLElement>, 'children' | 'className'>) {
  const { t } = useI18n()
  if (href === undefined) return <span ref={ref} className={className} {...props}>{children}</span>
  if (!isSampleHref(href)) {
    return (
      <a ref={ref as Ref<HTMLAnchorElement>} href={href} target="_blank" rel="noreferrer" className={className} {...props}>
        {children}<span className="sr-only"> {t('(opens in a new tab)')}</span>
      </a>
    )
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span ref={ref} tabIndex={0} className={cn('cursor-help', className)} {...props}>
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

/**
 * One row of a header popover: a mark, what it is about, and its state (with a time) at the right. A `<div>` in a
 * `<dl>` may hold only `<dt>` and `<dd>`, so the mark sits inside the term it marks.
 */
function StatusRow({ mark, title, tone = 'neutral', children }: { mark: ReactNode; title: string; tone?: ConnectionTone; children: ReactNode }) {
  return (
    <div className="flex items-start gap-2">
      <dt className="flex items-start gap-2 font-medium">
        <span aria-hidden="true" className="flex h-4 w-4 shrink-0 items-center justify-center text-muted-foreground">{mark}</span>
        {title}
      </dt>
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

/**
 * How long the sample's pretend run shows as running (or queued) before it reads idle again. Sample mode only, so a
 * press can be seen to do something; nothing is started, the timer only resets this fixture button. 2.4 s: the longest
 * line it shows, My Rules' "Running rules from preferences on MacBook Pro…" (7 words; My Work's is 5), reads in 1.8 s at
 * the 238 words a minute adults read silently (Brysbaert 2019, Journal of Memory and Language 109), which leaves about
 * half a second to find the line; and it stays under WCAG 2.2.2's 5 s, past which moving content needs a pause control.
 */
const SAMPLE_RUN_SHOWN_FOR_MS = 2400

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
    setTimeout(() => setState('idle'), SAMPLE_RUN_SHOWN_FOR_MS)
  }
  return (
    <Req ids={[...ids, 'R14.10', 'R14.11']}>
      <div className="flex w-full items-center gap-3 sm:w-auto">
        <span className="min-w-0 flex-1 text-xs leading-tight text-muted-foreground sm:text-right" aria-live="polite">
          {state === 'queued' && <>{interpolate(t('Queued for {name}'), { name: nextMachine.name })}</>}
          {state === 'running' && <>{interpolate(t('Running {label} on {name}…'), { label: run.label, name: runMachine.name })}</>}
          {state === 'idle' && <>{interpolate(t('Last run {lastRunAt}'), { lastRunAt: displayTime(run.lastRunAt) })}<br />{interpolate(t('on {name}'), { name: runMachine.name })}</>}
        </span>
        {/* The Button owns the 44px touch size (plan rule 6); the page adds no size of its own. */}
        <Button variant="outline" size="sm" onClick={start} disabled={state !== 'idle'} aria-label={interpolate(t('Refresh {label}'), { label: run.label })}>
          {state === 'idle' ? <RefreshCwIcon /> : <Spinner />}
          {t('Refresh')}
        </Button>
      </div>
    </Req>
  )
}

/**
 * The refresh line's sentence for each of its four states (c-bits-refresh-controls; the state is
 * live/refresh-line.ts RefreshLineState), each in its own t() call so the catalog test reads every one. `{time}` is
 * the refresh's own time when the worker reported one.
 */
const REFRESH_LINE_SENTENCE: Record<RefreshLineState, (t: Translate) => string> = {
  'up-to-date': (t) => t('Last refreshed {time}'),
  updating: (t) => t('Updating your goals and progress…'),
  failed: (t) => t('Could not refresh at {time}.'),
  'waiting-for-agent': (t) => t('Waiting for an agent to run the refresh. The next check tries again by itself.'),
}

/**
 * Each state's mark, so a state never rests on its words' colour alone (a failure had no icon and no colour). Each
 * draws at render time, so importing this file creates no elements (as STATE_MARK).
 */
const REFRESH_LINE_MARK: Record<RefreshLineState, () => ReactNode> = {
  'up-to-date': () => <CheckIcon aria-hidden="true" className="size-3.5 shrink-0" />,
  updating: () => <Spinner />,
  failed: () => null, // the Alert's attention kind draws its own mark
  'waiting-for-agent': () => <ClockIcon aria-hidden="true" className="size-3.5 shrink-0" />,
}

/** A time the worker reported: the reader's own clock with the full stamp on hover and focus (G9), or as recorded. */
function RefreshTime({ display, iso }: { display: string; iso?: string }) {
  return iso ? <LocalTime iso={iso} /> : <span className="tabular">{displayTime(display)}</span>
}

/**
 * A failure in plain words, then its raw cause folded under Details in monospace (G17), so no internal id, database
 * message or browser error is the visible text. Nothing to fold when there is no cause. The Details row is the shared
 * fold row as it is (G5): 44px on touch by its own rule, so no size is set here. The cause keeps its own line breaks,
 * as a CLI printed them (a turn that did not finish).
 */
export function FailureDetails({ cause }: { cause: string | null | undefined }) {
  const { t } = useI18n()
  if (!cause) return null
  return (
    <Collapsible>
      <CollapsibleFoldTrigger className="mt-1.5 w-auto text-xs">{t('Details')}</CollapsibleFoldTrigger>
      <CollapsibleContent>
        <p className="mt-2 rounded-md bg-card px-3 py-2 font-mono text-xs whitespace-pre-wrap break-words text-foreground/80">{cause}</p>
      </CollapsibleContent>
    </Collapsible>
  )
}

/**
 * Why a refresh did not start (G17): plain words in the person's language, and the raw cause for Details. The worker's
 * refusal sentences (src/shared/work-view-refresh-reasons.ts, the route's own words for people) stay visible; anything
 * else it answered, such as a raw error with a file path in it, and a bare status or a browser error ("Failed to
 * fetch"), goes under Details.
 */
function refreshNotStartedWords(cause: unknown, t: Translate): { words: string; details: string | null } {
  if (cause instanceof RefreshNotStartedError) {
    if (isRefreshStartRefusal(cause.workerReason)) return { words: interpolate(t('Refresh could not start: {reason}'), { reason: t(cause.workerReason) }), details: null }
    return { words: t('Refresh could not start. The worker refused it.'), details: cause.workerReason ?? interpolate(t('The worker answered {status}.'), { status: cause.status }) }
  }
  return { words: t('Refresh could not start. The worker did not answer; it may be restarting.'), details: cause instanceof Error ? cause.message : String(cause) }
}

/**
 * Starts this computer's refresh of goals and progress on demand (POST /api/work-view/refresh, which runs at most one
 * refresh at a time). Remembers what the worker answered the last press (live/refresh-line.ts RefreshPressAnswer), or
 * why the start failed, worded at render so the words follow a change of language. `recordAtPress` is the refresh
 * record on screen at the press (refreshRecordKey), so the line can tell when the worker's record catches up.
 */
function useRefreshStart() {
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

/** A start that failed, announced once as an alert: what happened, then the raw cause folded (G17). */
function RefreshStartFailure({ cause }: { cause: unknown }) {
  const { t } = useI18n()
  const { words, details } = refreshNotStartedWords(cause, t)
  return (
    <Alert variant="attention" role="alert" className="w-full py-2.5 text-xs">
      <AlertTitle className="text-xs font-normal">{words}</AlertTitle>
      {details && <AlertDescription><FailureDetails cause={details} /></AlertDescription>}
    </Alert>
  )
}

/**
 * The worker's automatic refresh of goals and progress (c-bits-refresh-controls, page-01): it runs owner-goals and
 * request-progress on the user's own logged-in agent whenever something is due, so there is no command to copy. One
 * line in four states (live/refresh-line.ts): up to date (when it last refreshed, or before its first run the last
 * saved run), updating, waiting for an agent, and failed. A failure says when it failed and how old the shown review
 * is, folds the raw cause under Details (G17: it printed "Refresh failed: <agent>: reviews: <group id>: database is
 * locked") and is announced once as an alert. The worker's own sentences for people (why it waits for an agent,
 * src/shared/work-view-refresh-reasons.ts) are the visible line (#5535: the "why" is in sight); anything else it sent
 * goes under Details below a plain line. A press of Try again or Refresh now always shows its outcome
 * (live/refresh-line.ts shownRefreshLine): the run updating, a new failure with its own time, or "Nothing new to
 * refresh".
 */
export function RefreshStatus({ refresh, run, ids, label = 'Last run', canStartRefresh }: {
  refresh: AutoRefresh | null; run: SkillRun | null; ids: string[]; label?: string
  /**
   * Left out: a failed refresh carries Try again wherever this page can start a refresh (live/refresh-line.ts
   * pageStartsRefresh), so My Rules and Suggested areas have it with no prop. `true`: "Refresh now" in every state,
   * reading "Try again" after a failure (My Work: the review's time beside Refresh, c-work-filters; Past focus, whose
   * line had its own Refresh now beside it). `false`: no button.
   */
  canStartRefresh?: boolean
}) {
  const { t } = useI18n()
  const starting = useRefreshStart()
  const sourceKind = useStore((state) => state.work.sourceKind)
  const shown = shownRefreshLine(refresh, starting.answer)
  const state = shown.state
  const lastRun = run ? <>{t(label)} <span className="tabular">{displayTime(run.lastRunAt)}</span></> : null
  const recordedTime = refresh?.finishedAt ? <RefreshTime display={refresh.finishedAt} iso={refresh.finishedAtIso} /> : null
  const offersButton = state === 'failed' ? canStartRefresh ?? pageStartsRefresh(sourceKind) : canStartRefresh === true
  // While the worker runs a refresh the button waits (aria-disabled, so it stays reachable, G16) and the line beside it
  // says why; only this page's own press shows the button busy, so one spinner turns, not two (rule 8).
  const button = offersButton && (
    <Button variant="outline" size="sm" className="shrink-0" onClick={() => void starting.start(refreshRecordKey(refresh))} busy={starting.pending}
      aria-disabled={state === 'updating' || undefined} busyLabel={t('Refreshing…')}>
      <RefreshCwIcon />{state === 'failed' ? t('Try again') : t('Refresh now')}
    </Button>
  )
  const nothingNew = shown.nothingNew && <span role="status" className="text-xs text-muted-foreground">{t('Nothing new to refresh')}</span>
  // A start that failed is that press's outcome: it shows until the worker's record changes, as an answer does.
  const startFailure = starting.failure && starting.failure.recordAtPress === refreshRecordKey(refresh) && <RefreshStartFailure cause={starting.failure.cause} />
  if (state === 'failed') {
    // A start that failed before the worker's record caught up shows when it failed; the record's older cause waits.
    const failedAt = shown.failedAtIso ? <LocalTime iso={shown.failedAtIso} /> : recordedTime
    const cause = shown.failedAtIso ? null : refresh?.error ?? null
    return (
      <Req ids={[...ids, 'R14.10']}>
        <div data-refresh-line={state} className="w-full space-y-2">
          <Alert variant="attention" role="alert" className="@container py-2.5">
            <AlertTitle className="font-normal">
              {failedAt ? sentenceWith(REFRESH_LINE_SENTENCE.failed(t), 'time', failedAt) : t('Could not refresh.')}
              {lastRun && <> {lastRun}.</>}
            </AlertTitle>
            {cause && <AlertDescription><FailureDetails cause={cause} /></AlertDescription>}
            {/* Beside the words; under them in a narrow box (My Rules' side column, where beside them it ran out of
                the box). */}
            {button && <AlertAction className="@max-xs:col-start-2 @max-xs:row-span-1 @max-xs:row-start-3 @max-xs:self-start @max-xs:pt-1">{button}</AlertAction>}
          </Alert>
          {nothingNew}
          {startFailure}
        </div>
      </Req>
    )
  }
  const workerSaid = refresh?.error ?? null
  const waitingReason = state === 'waiting-for-agent' && isWaitingForAgentReason(workerSaid) ? workerSaid : null
  const sentence = state === 'up-to-date'
    ? recordedTime ? sentenceWith(REFRESH_LINE_SENTENCE[state](t), 'time', recordedTime)
      : run ? <>{lastRun} {interpolate(t('on {name}'), { name: run.deviceName })}</> : null
    : waitingReason ? interpolate(t('Waiting to refresh: {error}'), { error: t(waitingReason) })
      : REFRESH_LINE_SENTENCE[state](t)
  // Anything else the worker sent with a waiting refresh, under Details (G17).
  const details = state === 'waiting-for-agent' && !waitingReason ? workerSaid : null
  if (!sentence && !button) return null
  return (
    <Req ids={[...ids, 'R14.10']}>
      <div data-refresh-line={state} className="flex w-full flex-wrap items-center justify-end gap-x-3 gap-y-2 sm:w-auto">
        {sentence && (
          // One status region: the line is read out when its state changes, once (it was a polite region of plain text).
          <p role="status" className="flex min-w-0 items-start gap-1.5 text-xs leading-snug text-muted-foreground">
            <span className="mt-px flex shrink-0 empty:hidden">{REFRESH_LINE_MARK[state]()}</span>
            <span className="min-w-0">{sentence}</span>
          </p>
        )}
        {details && <div className="w-full sm:w-auto"><FailureDetails cause={details} /></div>}
        {nothingNew}
        {button}
        {startFailure}
      </div>
    </Req>
  )
}

/**
 * The work could not be read, as one alert (G17): plain words, the raw cause folded under Details, and Try again, which
 * reads the work again (the store's retryWorkRead). The one alert for both failed reads: the worker's records
 * (pages/my-work.tsx SourceReadAlert) and the read after a save (ReadAfterSaveNotice).
 */
export function WorkReadFailureAlert({ title, description, cause }: { title: string; description?: string; cause: string | null }) {
  const { t } = useI18n()
  const retryWorkRead = useStore((state) => state.retryWorkRead)
  const [retrying, setRetrying] = useState(false)
  return (
    <Alert variant="attention" role="alert">
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription className="text-foreground/80">
        {description}
        <FailureDetails cause={cause} />
      </AlertDescription>
      <AlertAction>
        <Button variant="outline" size="sm" busy={retrying} onClick={async () => { setRetrying(true); try { await retryWorkRead() } finally { setRetrying(false) } }}>{t('Try again')}</Button>
      </AlertAction>
    </Alert>
  )
}

/**
 * A save went through but reading the work after it failed (the store's work.readAfterSaveFailure, which nothing
 * showed before): the save stands and the screen may be behind until a read succeeds. A successful read clears it,
 * and so does a newer model from the live feed (store/slices/work-slice.ts).
 */
export function ReadAfterSaveNotice() {
  const { t } = useI18n()
  const failure = useStore((state) => state.work.readAfterSaveFailure)
  if (!failure) return null
  return <WorkReadFailureAlert title={t('Saved. The newest work could not be read, so this page may be behind.')} cause={failure} />
}

/**
 * Starts the local goals and progress refresh on demand. No page here mounts it any more: beside RefreshStatus it made
 * a second button for one failed refresh (Refresh now next to Try again), so the pages pass `canStartRefresh` to
 * RefreshStatus instead and the line and its one button change together. It stays exported for other board layouts
 * (plan rule 2; PR #6054).
 */
export function ManualRefreshButton({ ids, running = false }: { ids: string[]; running?: boolean }) {
  const { t } = useI18n()
  const starting = useRefreshStart()
  return (
    <Req ids={ids}>
      <div className="flex flex-wrap items-center justify-end gap-2">
        {starting.answer?.state === 'idle' && !running && <span role="status" className="text-xs text-muted-foreground">{t('Nothing new to refresh')}</span>}
        {/* The Button owns the 44px touch size (plan rule 6) and its busy look; the page adds neither. */}
        <Button variant="outline" size="sm" onClick={() => void starting.start(refreshRecordKey(null))} busy={starting.pending} aria-disabled={running || undefined} busyLabel={t('Refreshing…')}>
          <RefreshCwIcon />
          {t('Refresh now')}
        </Button>
        {starting.failure && <RefreshStartFailure cause={starting.failure.cause} />}
      </div>
    </Req>
  )
}
