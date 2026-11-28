import { clockTime, clockTimeOrDay, displayTime, recordedTimeWords } from '@/lib/display-time'
import { useState, type HTMLAttributes, type ReactNode, type Ref } from 'react'
import { BotIcon, CheckIcon, CircleDashedIcon, FocusIcon, LaptopIcon, RefreshCwIcon, UserIcon } from 'lucide-react'
import { interpolate, useI18n } from '@/lib/i18n'
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleFoldTrigger } from '@/components/ui/collapsible'
import { Progress } from '@/components/ui/progress'
import { Spinner } from '@/components/ui/spinner'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { Req } from '@/spec/req'
import { isSampleHref, measuredEstimate, SAMPLE_DEVICES, type AgentTool, type LiveState, type NextStepMissing, type Request, type Run } from '@/data'
import { agentById, deviceById, useStore, useWorkModel, useWorkspace } from '@/store'
import { ESTIMATE_PREFIX } from '@/live/measured-estimate'
import { NOT_SORTED_YET_LABEL, focusAreaPlaceWords, resolveFocusAreaId } from '@/live/to-focus-model'
import { nextStepShown, UNRECORDED_AGENT } from '@/live/to-work-model'
import { agentRoleWords, deviceName } from '@/lib/agent-words'
import { nextStepWords } from '@/live/next-step-words'
import { AgentMark } from './brand'

/** How many requests need the person, as words in a quiet pill (c-shell-focus-nav: was an orange dot). */
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
 * (G10). Times were printed as raw UTC stamps (c-bits-live-indicator, c-bits-device-freshness). `form`: the clock, with
 * the day on another day (clockTime), or the clock today and the day before (clockTimeOrDay: a record, a review).
 */
export function LocalTime({ iso, className, form = 'time' }: { iso: string; className?: string; form?: 'time' | 'time-or-day' }) {
  const time = form === 'time' ? clockTime(iso) : clockTimeOrDay(iso)
  if (!time) throw new Error(`LocalTime needs an ISO time, got ${JSON.stringify(iso)}`)
  return (
    <Tooltip>
      <TooltipTrigger asChild><time dateTime={iso} className={cn('tabular', className)}>{time.short}</time></TooltipTrigger>
      <TooltipContent>{time.full}</TooltipContent>
    </Tooltip>
  )
}

/**
 * A time the model recorded, in the reader's words (V3: no English word in a time, in any language): from its ISO
 * instant when the model carries one (LocalTime, with the full stamp on hover and focus), else the words a sample
 * fixture or an older model carries, said by the one formatter (lib/display-time.ts displayTime).
 */
export function RecordedTime({ iso, words, form = 'time', className }: { iso?: string | null; words: string; form?: 'time' | 'time-or-day'; className?: string }) {
  return iso ? <LocalTime iso={iso} form={form} className={className} /> : <span className={cn('tabular', className)}>{displayTime(words)}</span>
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
      {/* A new state's colours come at once (transition-none over the Badge's own): a live change moves two things at
          most, the change ticker and, where rows show their status, the newest change's riffle (request-rows.tsx
          ListStatus); every changed card's badge fading to its colours was one more each (Phase 6 verify V2). */}
      <Badge variant="outline" data-state-badge={state} className={cn('shrink-0 gap-1.5 font-normal transition-none', STATE_BADGE_WORDS_WHOLE, STATE_SURFACE[state])}>
        <StateMark state={state} />
        {children ?? t(STATE_LABEL[state])}
      </Badge>
    </Req>
  )
}

/** Each state's words in its own colour, without the badge's chip (Codex's `.status`): the badge's text colours. */
const STATE_WORDS_COLOUR: Record<LiveState, string> = {
  working: 'text-working-foreground',
  'needs-check': 'text-review-foreground',
  'your-move': 'text-attention-foreground',
  idle: 'text-idle-foreground',
  shipped: 'text-shipped-foreground',
}

/** A state's mark and word at the end of a row (Find work's requests), quieter than the badge; the mark keeps it off colour alone. */
export function StateWords({ state }: { state: LiveState }) {
  const { t } = useI18n()
  return (
    <Req ids={['R6.2']}>
      <span data-state-words={state} className={cn('inline-flex shrink-0 items-center gap-1.5 text-sm font-medium whitespace-nowrap', STATE_WORDS_COLOUR[state])}>
        <StateMark state={state} />{t(STATE_LABEL[state])}
      </span>
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
 * refresh places the request. (The List table, whose cells keep one line, draws only a focus area's own requests since
 * design pass Phase 6, so it never shows these words.)
 */
export function FocusAreaChip({ focusAreaId, onOpen }: { focusAreaId?: string; onOpen?: (focusAreaId: string) => void }) {
  const { t } = useI18n()
  const { focusAreas } = useWorkModel()
  const placed = resolveFocusAreaId(focusAreaId, focusAreas)
  const label = focusAreaPlaceWords(focusAreaId, focusAreas, t)
  return (
    <Req ids={['R16.5']}>
      {placed ? (
        <Button variant="bare" data-focus-area="placed" onClick={(event) => { event.stopPropagation(); onOpen?.(placed) }}
          className="max-w-full gap-1.5 self-start text-xs text-muted-foreground underline decoration-control-edge underline-offset-4 md:not-pointer-coarse:min-h-6 hover-enabled:text-foreground hover-enabled:decoration-current">
          <FocusIcon aria-hidden="true" className="size-3.5 shrink-0" />
          <span className="truncate">{label}</span>
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
 * `layout="lines"` is the same look with the whole step, wrapping under its icon: the rows that give the title a line
 * of its own (By agent's cards, the Team columns) show the step whole, as HEAD's cards did (rule 2).
 */
export function NextMove({ next, className, whenMissing = 'omit', layout = 'block' }: {
  next: Request['next'] | null | undefined; className?: string; whenMissing?: 'omit' | 'dash'; layout?: 'block' | 'line' | 'lines'
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
  const small = layout === 'line' || layout === 'lines'
  const ownerIcon = (
    <span aria-hidden="true" className={cn('flex shrink-0 items-center justify-center rounded-full', small ? 'size-4' : 'mt-px size-5', layout === 'lines' && 'mt-0.5', human ? 'bg-attention text-attention-foreground' : 'bg-muted text-muted-foreground')}>
      {human ? <UserIcon className={small ? 'size-2.5' : 'size-3'} /> : <BotIcon className={small ? 'size-2.5' : 'size-3'} />}
    </span>
  )
  if (small) {
    const words = nextStepWords(shown, t)
    return (
      <Req ids={['R5.8', 'R6.3']}>
        <span data-next-move={shown.who} className={cn('flex min-w-0 gap-1.5 text-[0.84rem]', layout === 'line' ? 'items-center' : 'items-start leading-snug', className)}>
          {ownerIcon}
          <span className={cn('min-w-0', layout === 'line' ? 'truncate' : 'wrap-break-word', human ? 'font-medium text-attention-foreground' : 'text-foreground/80')}>
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

/** What the last memory review covered: "2 of 3 workstreams reviewed", with when, in the reader's words (V3). */
export function reviewCoverage(request: Request, t?: (s: string) => string) {
  const { coverage, readings } = request.progress
  const reviewedAt = recordedTimeWords(request.progress.reviewedAtIso, request.progress.reviewedAt, 'time-or-day')
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
 * things per view (and a new value is drawn at once). `compact` is the List's cell, on one line for its 48px rows
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
    // The bar takes a new value at once (plan rule 8, Phase 6 verify V2): a review that updates many requests in one live
    // change eased every one of their bars for 0.7 s, each a moving thing.
    <Progress value={progress.percent} aria-label={progress.percent === null ? t('Not reviewed yet') : interpolate(t('{percent}% complete'), { percent: progress.percent })} className={cn('[&_[data-slot=progress-indicator]]:transition-none', compact && 'w-14 shrink-0', STATE_PROGRESS_FILL[request.state])} />
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
          <span>{progress.completedAt ? interpolate(t('Completed {completedAt}'), { completedAt: recordedTimeWords(progress.completedAtIso, progress.completedAt) }) : progress.readings ? <><span className="font-medium text-foreground/80 mono-number">{progress.percent}%</span>{` · ${reviewCoverage(request, t)}`}</> : t('Not reviewed yet')}</span>
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

export const CLAUDE_MEM_REPO_URL = 'https://github.com/thedotmack/claude-mem'

/** The My Work feedback form on GitHub (.github/ISSUE_TEMPLATE/my-work-feedback.yml), linked from Workspace's Help and feedback. */
export const MY_WORK_FEEDBACK_URL = 'https://github.com/thedotmack/claude-mem/issues/new?template=my-work-feedback.yml'

/** Where My Work can be set to review through an API provider when no agent is logged in (#6214): Machine and sync's Focus review and My Rules' empty state. */
export const API_PROVIDER_GUIDE_URL = 'https://docs.claude-mem.ai/configuration#my-work-refresh-models'

/**
 * How long the sample's pretend run shows as running (or queued) before it reads idle again. Sample mode only, so a
 * press can be seen to do something; nothing is started, the timer only resets this fixture button. 2.4 s: its longer
 * line, Machine and sync's "Running request-progress on Mac Studio…" (5 words; "Queued for MacBook Pro" is 4), reads in
 * 1.3 s at the 238 words a minute adults read silently (Brysbaert 2019, Journal of Memory and Language 109), which
 * leaves about a second to find the line; and it stays under WCAG 2.2.2's 5 s, past which moving content needs a pause
 * control.
 */
const SAMPLE_RUN_SHOWN_FOR_MS = 2400

/**
 * Sample runs only (their machines are fixtures): Machine and sync's Focus review in the sample. Runs a skill from the
 * GUI (§14): last run time, machine and progress (cost display dropped by the owner, Oct 20, 2026), in the words the
 * real review uses ("Review now"). On the web it queues for an online machine.
 */
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
        <Button variant="outline" size="sm" onClick={start} disabled={state !== 'idle'}>
          {state === 'idle' ? <RefreshCwIcon /> : <Spinner />}
          {t('Review now')}
        </Button>
      </div>
    </Req>
  )
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
 * The work could not be read, as one alert (G17): plain words, the raw cause folded under Details, and Try again, which
 * reads the work again (the store's retryWorkRead). The one alert for both failed reads: the worker's records
 * (SourceReadAlert, below) and the read after a save (ReadAfterSaveNotice).
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
 * The work model could not be read from the worker's records (sourceHealth): plain words, the worker's own message
 * folded under Details in monospace, and Try again (G17; it printed the raw message as the description). The home page
 * and Requests show it first (pages/my-work.tsx, pages/requests.tsx), and so do Focus areas and a focus area's page.
 */
export function SourceReadAlert({ error }: { error: string | null }) {
  const { t } = useI18n()
  return <WorkReadFailureAlert title={t("Can't read local work right now")} description={t('The worker answered, but could not read your saved work. It may be busy; try again in a moment.')} cause={error} />
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
