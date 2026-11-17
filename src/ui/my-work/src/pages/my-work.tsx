import { displayRecordedDate, displayTime } from '@/lib/display-time'
import { t, useI18n, interpolate } from '@/lib/i18n'
import { useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { motion, useReducedMotion } from 'motion/react'
import { ArrowRightIcon, ArrowUpDownIcon, ImageIcon, InboxIcon, PlugIcon, ReplyIcon, TriangleAlertIcon } from 'lucide-react'
import { Agent, AgentContent, AgentHeader } from '@/components/ai-elements/agent'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button, buttonVariants } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleFoldTrigger } from '@/components/ui/collapsible'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { AgentIcon, ATTENTION_ORDER, FocusAreaChip, NextMove, ProgressMeter, RefreshButton, RefreshStatus, STATE_LABEL, STATE_SURFACE, StateBadge, WorkReadFailureAlert } from '@/components/bits'
import { sentenceWith } from '@/lib/sentence-with'
import { nextStepWords } from '@/live/next-step-words'
import { TracingBeam } from '@/components/aceternity/tracing-beam'
import { AgentMark } from '@/components/brand'
import { FocusChangeBar, useFocusChanges } from '@/components/focus-changes'
import { FocusHeader, OtherHeader } from '@/components/focus-header'
import { ChangeTicker } from '@/components/live-motion'
import { RequestCard } from '@/components/request-card'
import { RequestLine } from '@/components/request-line'
import { SplitFlapText } from '@/components/split-flap'
import { SaveButton } from '@/components/save-button'
import { useMatchesMedia } from '@/lib/use-media'
import { cn } from '@/lib/utils'
import { Req } from '@/spec/req'
import { needsYou, OTHER_FOCUS_AREA_ID, requestTitle, SAMPLE_RUNS, startedTimestamp, type Agent as WorkAgent, type LiveState, type Request } from '@/data'
import { type WorkFilter, type WorkListView, type WorkSort, deviceById, useFreshlyUpdated, useStore, useWorkModel, useWorkspace } from '@/store'
import type { HomeAnchor } from '@/store/home-anchor'
import { useShallow } from 'zustand/react/shallow'
import type { BuildStory, RequestReadError, StoryChapter } from '@/live/work-data-source'
import { asksToKeepOrDismiss, createFocusAreaResolver } from '@/live/to-focus-model'
import { nextStepShown } from '@/live/to-work-model'
import { refreshLineState } from '@/live/refresh-line'
import { CARD_SIZE, LINE_ROWS_PER_PAGE, cardGridEntries, linePage, lineSections, type CardGroup, type CardSize } from '@/live/card-groups'
import { datedHeading, fitLine, storyChapters, storyNumbers } from '@/live/build-story'
import { FocusOverview } from '@/components/focus-overview'
import '@/components/focus-overview.css'

type View = WorkListView
const VIEWS: { value: View; label: string }[] = [
  { value: 'cards', label: 'Cards' },
  { value: 'list', label: 'List' },
  { value: 'agents', label: 'By agent' },
  { value: 'team', label: 'Team' },
]
type Filter = WorkFilter
type SortKey = WorkSort
// Closed requests (every item dropped) show only under Closed, and that filter appears only when there are some (or it is selected).
// Each dot is still (rule 8: a pulsing Working dot here and in two other places put too many moving things on home).
const FILTERS: { value: Filter; label: string; matches: (request: Request) => boolean; dot?: string }[] = [
  { value: 'all', label: 'All', matches: (request) => !request.closed },
  { value: 'needs-you', label: 'Needs you', matches: (request) => !request.closed && needsYou(request), dot: 'bg-attention-foreground' },
  { value: 'working', label: 'Working', matches: (request) => !request.closed && request.state === 'working', dot: 'bg-working-foreground' },
  { value: 'shipped', label: 'Shipped', matches: (request) => !request.closed && request.state === 'shipped', dot: 'bg-shipped-foreground' },
  { value: 'closed', label: 'Closed', matches: (request) => !!request.closed },
]
const SORTS: { value: SortKey; label: string }[] = [
  { value: 'attention', label: 'Needs you first' },
  { value: 'started', label: 'Newest' },
  { value: 'progress', label: 'Most progress' },
]
const titleOf = (request: Request) => requestTitle(request, t)

/** Attention first by default (your move, then to check, then working, idle, shipped); newest first within a state. */
function sortRequests(requests: Request[], sort: SortKey) {
  const newest = (a: Request, b: Request) => startedTimestamp(b) - startedTimestamp(a)
  return [...requests].sort((a, b) =>
    sort === 'progress' ? (b.progress.percent ?? -1) - (a.progress.percent ?? -1) || newest(a, b)
      : sort === 'started' ? newest(a, b)
        : ATTENTION_ORDER.indexOf(a.state) - ATTENTION_ORDER.indexOf(b.state) || newest(a, b))
}

/**
 * How many moving requests are named before "Show all N" / "and N more": page-01's mockup draws three rows under
 * "Moving now" (the plan's "three titles readable"), and the rest are counted, not drawn (progressive-disclosure).
 */
const MOVING_NAMED = 3

/** Whether this page can continue a conversation: only the page this computer's worker serves (live/work-data-source). */
function useCanReply() {
  return useStore((state) => state.conversationContinuationSource() !== null)
}

/**
 * A request's answer buttons (G2): Reply opens its drawer with the reply box focused, and Open opens the drawer. Where
 * this page cannot continue a conversation (sample data, the cloud page) the one button is "Open request". `primary`
 * makes the first button the screen's one orange button (G1: one primary per decision unit); every other is outlined.
 */
function ReplyActions({ request, primary, onOpen, onReply }: { request: Request; primary: boolean; onOpen: (request: Request) => void; onReply: (request: Request) => void }) {
  const canReply = useCanReply()
  const variant = primary ? 'default' : 'outline'
  if (!canReply) return <Button variant={variant} onClick={() => onOpen(request)}>{t('Open request')}</Button>
  return (
    <>
      <Button variant={variant} onClick={() => onReply(request)}><ReplyIcon aria-hidden="true" />{t('Reply')}</Button>
      <Button variant="link" className="px-1" onClick={() => onOpen(request)}>{t('Open')}</Button>
    </>
  )
}

/** A section heading in the page's label style, with its count in monospace ("NEEDS YOU · 2"). */
function CountedHeading({ id, dot, tone, label, count }: { id?: string; dot: string; tone: string; label: string; count: number }) {
  return (
    <h2 id={id} className={cn('flex items-center gap-2 text-xs font-semibold tracking-[0.08em] uppercase', tone)}>
      <span aria-hidden="true" className={cn('size-2 shrink-0 rounded-full', dot)} />
      {t(label)}<span aria-hidden="true">·</span><span className="mono-number">{count}</span>
    </h2>
  )
}

/**
 * The home page's first block (page-01): what needs you, as full cards with their Reply (the first card's Reply is the
 * screen's one orange button, G1), then what is moving as one-line rows with their running time. The focus areas and
 * every request follow it, so the requests that need an answer are no longer 1,400px down the page.
 */
function NeedsYouFirst({ requests, onOpen, onReply, onOpenFocus, onShowWorking }: {
  requests: Request[]; onOpen: (request: Request) => void; onReply: (request: Request) => void
  onOpenFocus: (focusAreaId: string) => void; onShowWorking: () => void
}) {
  const waiting = sortRequests(requests.filter(needsYou), 'attention')
  const moving = sortRequests(requests.filter((request) => request.state === 'working'), 'started')
  const needsYouId = useId()
  const movingId = useId()
  return (
    <Req ids={['R12.2', 'R12.3', 'R1.1']}>
      <div className="space-y-6">
        <section aria-labelledby={needsYouId} className="space-y-3">
          <CountedHeading id={needsYouId} dot="bg-attention-foreground" tone="text-attention-foreground" label="Needs you" count={waiting.length} />
          {waiting.length === 0 ? <p className="text-sm text-muted-foreground">{t('Nothing needs you right now.')}</p> : (
            <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-2">
              {waiting.map((request, index) => (
                <RequestCard key={request.id} request={request} onOpen={() => onOpen(request)} onOpenFocus={onOpenFocus}
                  actions={<ReplyActions request={request} primary={index === 0} onOpen={onOpen} onReply={onReply} />} />
              ))}
            </div>
          )}
        </section>
        {moving.length > 0 && (
          <section aria-labelledby={movingId} className="space-y-2">
            <CountedHeading id={movingId} dot="bg-working-foreground" tone="text-working-foreground" label="Moving now" count={moving.length} />
            <ul className="divide-y divide-border/70 rounded-xl border border-border/70 bg-card/60 px-1 py-0.5">
              {moving.slice(0, MOVING_NAMED).map((request) => <li key={request.id}><RequestLine request={request} onOpen={onOpen} showState={false} /></li>)}
            </ul>
            {moving.length > MOVING_NAMED && (
              <Button variant="link" size="sm" className="px-1" onClick={onShowWorking}>{interpolate(t('Show all {count} moving'), { count: moving.length })}</Button>
            )}
          </section>
        )}
      </div>
    </Req>
  )
}

/** One moving request's title as a quiet link on the summary's line, cut with its whole title in a tooltip (G10). */
function MovingTitle({ request, onOpen }: { request: Request; onOpen: (request: Request) => void }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="bare" onClick={() => onOpen(request)} className="max-w-[16rem] min-w-0 truncate text-foreground/85 underline decoration-border underline-offset-4 hover-enabled:text-foreground hover-enabled:decoration-current">
          {titleOf(request)}
        </Button>
      </TooltipTrigger>
      <TooltipContent className="max-w-sm">{titleOf(request)}</TooltipContent>
    </Tooltip>
  )
}

/**
 * What leads a focus area's requests (c-work-summary, c-aceternity-pointer-highlight): the first thing that needs you
 * as a raised row with its Reply, then what is moving, by name, on one line. No drawn box or pointer: it drew itself
 * over a second on load and looked like someone else's cursor (the PointerHighlight file stays for other layouts).
 */
function Summary({ requests, primary, onOpen, onReply, onShowNeedsYou, onShowWorking }: {
  requests: Request[]
  /** Whether the first row's Reply is the screen's one orange button (G1): not when the area header holds one. */
  primary: boolean
  onOpen: (request: Request) => void; onReply: (request: Request) => void; onShowNeedsYou: () => void; onShowWorking: () => void
}) {
  const waiting = sortRequests(requests.filter(needsYou), 'attention')
  const moving = sortRequests(requests.filter((request) => request.state === 'working'), 'started')
  const first = waiting[0]
  const firstStep = first ? nextStepShown(first.next) : null
  return (
    <Req ids={['R12.2', 'R12.3', 'R1.1']}>
      <div className="space-y-2.5 rounded-xl border border-border/70 bg-card/60 p-3 md:p-4">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <p className="flex items-center gap-2 font-semibold">
            <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-attention-foreground" />
            {waiting.length ? interpolate(waiting.length === 1 ? t('{count} needs you') : t('{count} need you'), { count: waiting.length }) : t('Nothing needs you right now.')}
          </p>
          {waiting.length > 1 && <Button variant="link" size="sm" className="ml-auto px-1" onClick={onShowNeedsYou}>{interpolate(t('Show all {count} that need you'), { count: waiting.length })}</Button>}
        </div>
        {first && (
          <div className="flex flex-wrap items-center gap-3 rounded-lg border border-control-edge/55 bg-card p-3 shadow-panel">
            <div className="min-w-0 flex-1 space-y-0.5">
              {/* The step, or the request's title when no step is recorded (G3: never the filler). */}
              <p className="leading-snug font-semibold">{firstStep?.kind === 'step' ? nextStepWords(firstStep, t) : titleOf(first)}</p>
              {firstStep?.kind === 'step' && <p className="truncate text-xs text-muted-foreground">{titleOf(first)}</p>}
            </div>
            <div className="flex shrink-0 flex-wrap items-center gap-2"><ReplyActions request={first} primary={primary} onOpen={onOpen} onReply={onReply} /></div>
          </div>
        )}
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 text-sm text-muted-foreground">
          <span className="inline-flex items-center gap-1.5 text-working-foreground">
            <span aria-hidden="true" className="size-1.5 rounded-full bg-working-foreground" />
            {moving.length ? interpolate(t('{count} moving now'), { count: moving.length }) : t('Nothing is moving right now.')}
          </span>
          {/* Phones name the first one; wider screens name up to MOVING_NAMED. */}
          {moving.slice(0, MOVING_NAMED).map((request, index) => (
            <span key={request.id} className={cn('min-w-0 items-center gap-2', index === 0 ? 'inline-flex' : 'hidden md:inline-flex')}>
              <span aria-hidden="true">·</span><MovingTitle request={request} onOpen={onOpen} />
            </span>
          ))}
          {moving.length > 1 && <Button variant="link" size="sm" className="px-1 md:hidden" onClick={onShowWorking}>{interpolate(t('and {count} more'), { count: moving.length - 1 })}</Button>}
          {moving.length > MOVING_NAMED && <Button variant="link" size="sm" className="hidden px-1 md:inline-flex" onClick={onShowWorking}>{interpolate(t('and {count} more'), { count: moving.length - MOVING_NAMED })}</Button>}
        </div>
      </div>
    </Req>
  )
}

/**
 * The numbers the recap and the sheet lead with (c-work-today-panel, c-work-story-sheet), in monospace. The plan's
 * "shipped within the story's period" is left out: the story records no period (live/build-story.ts storyNumbers).
 */
function StoryNumbers({ requests }: { requests: Request[] }) {
  const { waiting, stillOpen } = storyNumbers(requests)
  const numbers = [
    { label: t('waiting on you'), count: waiting, dot: 'bg-attention-foreground' },
    { label: t('still open'), count: stillOpen, dot: 'bg-working-foreground' },
  ]
  return (
    <dl className="grid grid-cols-2 gap-2">
      {numbers.map(({ label, count, dot }) => (
        <div key={label} className="flex flex-col-reverse gap-0.5 rounded-lg border border-border/70 px-3 py-2">
          <dt className="flex items-center gap-1.5 text-xs text-muted-foreground"><span aria-hidden="true" className={cn('size-1.5 shrink-0 rounded-full', dot)} />{label}</dt>
          <dd className="text-2xl font-semibold mono-number">{count}</dd>
        </div>
      ))}
    </dl>
  )
}

/**
 * A chapter's date (monospace; a UTC day and time in the reader's own clock, display-time.ts displayRecordedDate) and
 * what happened, from its heading.
 */
function ChapterHeading({ heading, writtenAtIso }: { heading: string; writtenAtIso: string | undefined }) {
  const { date, title } = datedHeading(heading)
  return <>{date && <span className="mr-2 text-xs font-normal text-muted-foreground mono-number">{displayRecordedDate(date, writtenAtIso)}</span>}<span>{title}</span></>
}

/**
 * Dated lines in the recap: the newest three chapters with a date (c-work-today-panel's three lines; the rest are in
 * the sheet, one click away).
 */
const RECAP_DATED_LINES = 3

/** The chapters whose heading starts with a date, newest first. */
const datedChapters = (chapters: StoryChapter[]) => chapters.filter((chapter) => chapter.heading && datedHeading(chapter.heading).date).reverse()

/**
 * The build story's recap, after the work (c-work-today-panel): the three numbers, then the newest three dated lines of
 * at most 75 characters (UI UX Pro Max line-length-control; it was one 730-character paragraph 180 characters wide),
 * and the way into the whole story. In the sample, also the hero image slot and the sync funnel (§7, §8).
 */
function TodayPanel({ story, requests, onOpenStory }: { story: BuildStory; requests: Request[]; onOpenStory: () => void }) {
  const { mode, connected } = useWorkspace()
  // The daily recap image is not generated from real records yet, so live mode leaves its slot out.
  const sample = useWorkModel().sourceKind === 'sample'
  const dated = datedChapters(storyChapters(story))
  const lines = dated.slice(0, RECAP_DATED_LINES)
  const moreDated = dated.length - lines.length
  return (
    <div className={cn('grid gap-4 rounded-xl border bg-card/70 p-4 shadow-panel md:p-5', sample && 'sm:grid-cols-[132px_1fr]')}>
      {sample && (
        <Req ids={['R7.4']}>
          <div className="flex aspect-[3/1] items-center justify-center rounded-lg border border-dashed bg-surface text-muted-foreground sm:aspect-square"><ImageIcon className="size-5" /><span className="sr-only">{t("Today's hero image (not generated in the wireframe)")}</span></div>
        </Req>
      )}
      <div className="min-w-0 space-y-4">
        <Req ids={['R7.1', 'R7.2']}>
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <h2 className="section-label">{t('Build story')}</h2>
              {story.writtenAt && <span className="text-xs text-muted-foreground mono-number">{interpolate(t('written {date}'), { date: displayTime(story.writtenAt) })}</span>}
              {/* An outlined button, 36px at desktop (rule 6's 24px floor; it was a 23px link) and 44px on touch. */}
              <Button variant="outline" size="sm" className="ml-auto" onClick={onOpenStory}>{t('Read the build story')}<ArrowRightIcon aria-hidden="true" /></Button>
            </div>
            <StoryNumbers requests={requests} />
            {lines.length > 0 ? (
              <ul className="space-y-1.5 border-t border-border/70 pt-3 text-sm">
                {lines.map((chapter) => {
                  const { date, title } = datedHeading(chapter.heading!)
                  return (
                    <li key={chapter.heading} className="grid grid-cols-[minmax(5.5rem,auto)_1fr] gap-x-4">
                      <span className="text-xs leading-5 text-muted-foreground mono-number">{displayRecordedDate(date!, story.writtenAtIso)}</span>
                      <span>{fitLine(title)}</span>
                    </li>
                  )
                })}
                {/* The rest are in the sheet: said, with how many (plan rule 5). */}
                {moreDated > 0 && <li className="text-xs text-muted-foreground tabular">{interpolate(moreDated === 1 ? t('{count} more dated entry in the build story') : t('{count} more dated entries in the build story'), { count: moreDated })}</li>}
              </ul>
            ) : <p className="line-clamp-3 border-t border-border/70 pt-3 text-sm">{story.recap}</p>}
          </div>
        </Req>
        {sample && mode === 'home' && !connected && (
          <Req ids={['R8.2']}>
            <div className="flex flex-wrap items-center gap-2 border-t border-border/70 pt-3 text-sm">
              <PlugIcon className="size-4 text-muted-foreground" />
              <span className="mr-auto text-muted-foreground">{t("See this on your phone, and in Claude.ai and ChatGPT.")}</span>
              <Button size="sm" variant="outline">{t("Connect Claude.ai")}</Button>
              <Button size="sm" variant="outline">{t("Connect ChatGPT")}</Button>
            </div>
          </Req>
        )}
      </div>
    </div>
  )
}

/**
 * Shipping velocity, the narrative, and the preferences it found (§7, c-work-story-sheet, c-aceternity-tracing-beam).
 * The three numbers and the latest paragraph first, then what it learned with "Review in My Rules" (it was 3,900px
 * down), then the dated chapters in the story's own order, each a real heading over its paragraphs: the newest open,
 * the rest folded, every word still there. The entry being read (the one opened last) is marked on the rail.
 * Preferences are the same records My Rules shows.
 */
/**
 * Learned rules the sheet names before "Review in My Rules": with four, that button ends at 663px of a 900px sheet on
 * the owner's data (1440, Nov 16), so "What it learned" and its way to My Rules stay on the first screen
 * (c-work-story-sheet M). The rest are counted beside the button, and all of them are in My Rules.
 */
const STORY_LEARNED_NAMED = 4

function StorySheet({ open, story, requests, onClose, onOpenRules }: { open: boolean; story: BuildStory; requests: Request[]; onClose: () => void; onOpenRules: () => void }) {
  const { rules } = useWorkModel()
  const allLearned = rules.filter((rule) => rule.source === 'request-progress' && (rule.status === 'on' || rule.status === 'suggested'))
  const learned = allLearned.slice(0, STORY_LEARNED_NAMED)
  const moreLearned = allLearned.length - learned.length
  const chapters = storyChapters(story)
  const opening = chapters.filter((chapter) => chapter.heading === null).flatMap((chapter) => chapter.paragraphs)
  const entries = chapters.filter((chapter): chapter is StoryChapter & { heading: string } => chapter.heading !== null)
  // request-progress writes the story oldest first, so its last dated chapter is the newest: it starts open and marked.
  // (A closing chapter with no date, such as the owner's "What the record teaches", is not an entry of its own date.)
  const newest = entries.findLastIndex((chapter) => datedHeading(chapter.heading).date !== null)
  const [opened, setOpened] = useState<ReadonlySet<number>>(() => new Set([newest >= 0 ? newest : entries.length - 1]))
  const [reading, setReading] = useState(newest >= 0 ? newest : entries.length - 1)
  const [latestWhole, setLatestWhole] = useState(false)
  // The sheet scrolls, not the window, so the tracing beam follows the sheet's scroll.
  const scrollRef = useRef<HTMLDivElement>(null)
  const toggle = (index: number, next: boolean) => {
    setOpened((current) => { const changed = new Set(current); if (next) changed.add(index); else changed.delete(index); return changed })
    if (next) setReading(index)
  }
  return (
    <Sheet open={open} onOpenChange={(next) => { if (!next) onClose() }}>
      {/* The one sheet width and the scrolling come from SheetContent (D b17 M 355); this panel adds only its spacing. */}
      <SheetContent ref={scrollRef}>
        <SheetHeader className="pr-14">
          <SheetTitle>{t("Build story")}</SheetTitle>
          <SheetDescription>{interpolate(t('From request-progress, reviewed from memory{writtenAt}.'), { writtenAt: story.writtenAt ? `, ${interpolate(t('written {date}'), { date: displayTime(story.writtenAt) })}` : '' })}</SheetDescription>
        </SheetHeader>
        <div className="space-y-6 px-6 pb-8">
          <Req ids={['R7.1']}><StoryNumbers requests={requests} /></Req>
          {opening.length > 0 && (
            <Req ids={['R7.2']}>
              <section className="space-y-2">
                <h3 className="section-label">{t('Latest')}</h3>
                {/* Three lines, then the rest in place under the shared fold row (G5, progressive-disclosure): the opening
                    ran about 800 characters of numbers. */}
                <Collapsible open={latestWhole} onOpenChange={setLatestWhole} className="space-y-2">
                  {!latestWhole && <p className="line-clamp-3 text-sm">{opening.join(' ')}</p>}
                  <CollapsibleContent className="space-y-3 text-sm">
                    {opening.map((paragraph, index) => <p key={index}>{paragraph}</p>)}
                  </CollapsibleContent>
                  <CollapsibleFoldTrigger>{latestWhole ? t('Show less') : t('Read all')}</CollapsibleFoldTrigger>
                </Collapsible>
              </section>
            </Req>
          )}
          <Req ids={['R7.3']}>
            <section className="space-y-2">
              <h3 className="section-label">{t("What it learned about how you work")}</h3>
              {learned.length === 0 && <p className="text-sm text-muted-foreground">{t("No preferences learned yet.")}</p>}
              <ul className="space-y-2">
                {learned.map((rule) => (
                  <li key={rule.id} className="text-sm">
                    {rule.when ? interpolate(t('When {when}: {then}'), { when: rule.when, then: rule.then }) : rule.then}
                    {rule.status === 'suggested' && <span className="ml-1.5 text-xs text-muted-foreground">{t("· suggested, not approved yet")}</span>}
                  </li>
                ))}
              </ul>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <Button variant="outline" onClick={onOpenRules}>{t("Review in My Rules")}</Button>
                {moreLearned > 0 && <span className="text-xs text-muted-foreground tabular">{interpolate(t('{count} more in My Rules'), { count: moreLearned })}</span>}
              </div>
            </section>
          </Req>
          {entries.length > 0 && (
            <Req ids={['R7.2']}>
              <section className="space-y-2">
                <h3 className="section-label">{t('By date')}</h3>
                <TracingBeam scrollContainer={scrollRef} className="pl-[32px]">
                  {/* Starts below the beam's own dot (its top 12–28px), so that dot is not read as an entry's mark. */}
                  <ol className="space-y-2 pt-8">
                    {entries.map((chapter, index) => (
                      <li key={`${index}:${chapter.heading}`} aria-current={reading === index ? 'true' : undefined} className="relative">
                        {/* The rail mark: filled for the entry being read, a ring for the rest. */}
                        {/* On the beam's line: TracingBeam draws it 19px in from its left edge, in px at every root size, so the
                            list starts 32px in and the 10px mark's centre is 32 − 18 + 5 = 19px in (rem sizes put it 2.3px off
                            at the 17px desktop root). */}
                        <span aria-hidden="true" className={cn('absolute top-[17px] -left-[18px] size-[10px] rounded-full border-[1.5px]', reading === index ? 'border-primary bg-primary' : 'border-control-edge bg-card')} />
                        <Collapsible open={opened.has(index)} onOpenChange={(next) => toggle(index, next)}>
                          <h4>
                            <CollapsibleFoldTrigger count={chapter.paragraphs.length > 1 ? interpolate(t('{count} paragraphs'), { count: chapter.paragraphs.length }) : undefined}>
                              <ChapterHeading heading={chapter.heading} writtenAtIso={story.writtenAtIso} />
                            </CollapsibleFoldTrigger>
                          </h4>
                          <CollapsibleContent className="space-y-2 px-3 pt-2 pb-1 text-sm text-muted-foreground">
                            {chapter.paragraphs.map((paragraph, paragraphIndex) => <p key={paragraphIndex}>{paragraph}</p>)}
                          </CollapsibleContent>
                        </Collapsible>
                      </li>
                    ))}
                  </ol>
                </TracingBeam>
              </section>
            </Req>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}

/** card-hover-effect, in place: a soft panel fades in behind the card the pointer is on. It never slides between cards. */
function HoverCell({ children }: { children: ReactNode }) {
  return (
    <div className="group/hover-cell relative min-w-0">
      <span aria-hidden="true" className="pointer-events-none absolute -inset-2 block rounded-2xl bg-accent/70 opacity-0 transition-opacity duration-150 group-hover/hover-cell:opacity-100" />
      <div className="relative h-full">{children}</div>
    </div>
  )
}

/**
 * The List is a departures board (decision 2, R4.4): each status is a line of split-flap tiles exactly as wide as its
 * label, colored by its state. It riffles in when the List opens and again when the status changes, then stops.
 */
function FlipStatus({ state }: { state: LiveState }) {
  return <SplitFlapText text={t(STATE_LABEL[state])} tileClassName={STATE_SURFACE[state]} />
}

/** A card or row glides to its new place when the order changes (a status moved, a new request arrived). Position only:
 * a card that grows or shrinks snaps, so text never stretches mid-animation. Off under reduced motion (MotionConfig). */
const GLIDE = { type: 'spring', bounce: 0.15, duration: 0.55 } as const

/**
 * The board's glide and a card's entrance, off under reduced motion here in the component as well as through the
 * app's MotionConfig (plan rule 8): no layout animation, and a card is simply there.
 */
function useBoardMotion() {
  const reduceMotion = useReducedMotion()
  return reduceMotion
    ? { layout: false as const, entrance: { initial: false as const } }
    : { layout: 'position' as const, entrance: { initial: { opacity: 0, y: 8 }, animate: { opacity: 1, y: 0 } } }
}

/** One board card, its size by state (live/card-groups.ts CARD_SIZE); a card that needs you carries its Reply (G2). */
function CardCell({ request, size, onOpen, onReply, onOpenFocus }: { request: Request; size: Exclude<CardSize, 'line'>; onOpen: (request: Request) => void; onReply: (request: Request) => void; onOpenFocus: (focusAreaId: string) => void }) {
  const motionProps = useBoardMotion()
  return (
    <motion.div layout={motionProps.layout} transition={GLIDE} {...motionProps.entrance} className="min-w-0">
      <HoverCell>
        <RequestCard request={request} size={size} onOpen={() => onOpen(request)} onOpenFocus={onOpenFocus}
          actions={needsYou(request) ? <ReplyActions request={request} primary={false} onOpen={onOpen} onReply={onReply} /> : undefined} />
      </HoverCell>
    </motion.div>
  )
}

/** "Show 50 more · 68 left": the next page of one-line rows (G4, live/card-groups.ts LINE_ROWS_PER_PAGE). */
function ShowMoreRows({ left, onShowMore }: { left: number; onShowMore: () => void }) {
  if (left === 0) return null
  return (
    <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={onShowMore}>
      {interpolate(t('Show {count} more · {left} left'), { count: Math.min(LINE_ROWS_PER_PAGE, left), left })}
    </Button>
  )
}

/**
 * Idle or Shipped on the board (G4): one fold row, "Idle · 118" with its chevron (the shared fold row, G5), until it is
 * opened; opened, it draws one-line rows 50 at a time. Nothing folds by itself.
 */
function LineSection({ group, members, onOpen }: { group: CardGroup; members: Request[]; onOpen: (request: Request) => void }) {
  const [pages, setPages] = useState(0)
  const { shown, left } = linePage(members.length, pages)
  return (
    <Collapsible open={pages > 0} onOpenChange={(open) => setPages(open ? 1 : 0)} data-line-section={group.id}>
      <h3>
        <CollapsibleFoldTrigger count={<span className="mono-number">{members.length}</span>}>
          <span className="inline-flex items-center gap-2"><span aria-hidden="true" className={cn('size-2 rounded-full', group.dot)} />{t(group.label)}</span>
        </CollapsibleFoldTrigger>
      </h3>
      <CollapsibleContent className="space-y-1 pt-1">
        <ul className="divide-y divide-border/70">
          {members.slice(0, shown).map((request) => <li key={request.id}><RequestLine request={request} onOpen={onOpen} /></li>)}
        </ul>
        <ShowMoreRows left={left} onShowMore={() => setPages((current) => current + 1)} />
      </CollapsibleContent>
    </Collapsible>
  )
}

/**
 * The Cards view (c-work-cards-view). Attention-first with every request: what needs you as full cards with Reply,
 * what is working as medium cards, both in one grid under h3 headings (so a card whose status changes glides from one
 * section to the other), then Idle and Shipped folded to one line each (G4). Sorted another way or filtered, the
 * requests keep that order, each drawn at its state's size, 50 at a time.
 */
function CardsView({ requests, grouped, readErrors, onOpen, onReply, onOpenFocus }: { requests: Request[]; grouped: boolean; readErrors: RequestReadError[]; onOpen: (request: Request) => void; onReply: (request: Request) => void; onOpenFocus: (focusAreaId: string) => void }) {
  const [pages, setPages] = useState(1)
  const { layout } = useBoardMotion()
  const errors = readErrors.map((readError) => <RequestReadErrorCard key={readError.requestId} readError={readError} />)
  if (!grouped) {
    const { shown, left } = linePage(requests.length, pages)
    return (
      <div className="space-y-3">
        <div className="grid grid-cols-1 items-start gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {requests.slice(0, shown).map((request) => {
            const size = CARD_SIZE[request.state]
            return size === 'line'
              ? <div key={request.id} className="col-span-full"><RequestLine request={request} onOpen={onOpen} /></div>
              : <CardCell key={request.id} request={request} size={size} onOpen={onOpen} onReply={onReply} onOpenFocus={onOpenFocus} />
          })}
          {errors}
        </div>
        <ShowMoreRows left={left} onShowMore={() => setPages((current) => current + 1)} />
      </div>
    )
  }
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 items-start gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {cardGridEntries(requests).map((entry) => entry.kind === 'card'
          ? <CardCell key={entry.key} request={entry.request} size={entry.size} onOpen={onOpen} onReply={onReply} onOpenFocus={onOpenFocus} />
          : (
            <motion.div key={entry.key} layout={layout} transition={GLIDE} className="col-span-full flex items-center gap-2.5 pt-2 first:pt-0">
              <span aria-hidden="true" className={cn('size-2 rounded-full', entry.group.dot)} />
              <h3 className="text-sm font-semibold tracking-tight">{t(entry.group.label)}</h3>
              <span className="text-sm text-muted-foreground mono-number">{entry.count}</span>
              <span className="h-px flex-1 bg-border/70" />
            </motion.div>
          ))}
      </div>
      {lineSections(requests).map(({ group, members }) => <LineSection key={group.id} group={group} members={members} onOpen={onOpen} />)}
      {errors.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-sm font-semibold tracking-tight">{t("Couldn't read")}</h3>
          <div className="grid grid-cols-1 items-start gap-4 sm:grid-cols-2 xl:grid-cols-3">{errors}</div>
        </div>
      )}
    </div>
  )
}

// The List switches from stacked lines to the table at Tailwind's md breakpoint (768px); only one of them is built.
const TABLE_QUERY = '(min-width: 768px)'

/** A List line that glides when the order changes and glows once when its record changes. */
function ListItem({ requestId, children }: { requestId: string; children: ReactNode }) {
  const fresh = useFreshlyUpdated(requestId)
  return <motion.li layout="position" transition={GLIDE} className={cn(fresh && 'just-updated')}>{children}</motion.li>
}

/** The table row version of ListItem, with TableRow's own look (components/ui/table.tsx). */
function ListTableRow({ requestId, onClick, children }: { requestId: string; onClick: () => void; children: ReactNode }) {
  const fresh = useFreshlyUpdated(requestId)
  return (
    <motion.tr layout="position" transition={GLIDE} data-slot="table-row" onClick={onClick}
      className={cn('cursor-pointer border-b border-border/80 transition-colors hover:bg-surface', fresh && 'just-updated')}>
      {children}
    </motion.tr>
  )
}

function ListView({ requests, sort, onSort, onOpen, onOpenFocus }: { requests: Request[]; sort: SortKey; onSort: (sort: SortKey) => void; onOpen: (request: Request) => void; onOpenFocus: (focusAreaId: string) => void }) {
  const { team } = useWorkspace()
  const wide = useMatchesMedia(TABLE_QUERY)
  const sortHead = (label: string, value: SortKey) => (
    <TableHead aria-sort={sort === value ? 'descending' : undefined}>
      <Button variant="ghost" size="sm" className="-ml-3 h-8 text-[0.82rem] font-medium text-muted-foreground" onClick={() => onSort(value)}>{t(label)}<ArrowUpDownIcon className={sort === value ? '' : 'opacity-30'} /></Button>
    </TableHead>
  )
  return (
    <Req ids={['R4.2', 'R4.4', 'R2.1', 'R5.8', 'R11.1']}>
      {/* Phones: stacked rows, request then status then next step. */}
      {!wide && <ul className="divide-y rounded-xl border bg-card shadow-panel">
        {requests.map((request) => (
          <ListItem key={request.id} requestId={request.id}>
            <button type="button" onClick={() => onOpen(request)} className="flex w-full flex-col gap-2 p-4 text-left focus-visible:outline-2 focus-visible:outline-ring">
              <span className="flex w-full items-start gap-2.5">
                <AgentIcon agentId={request.agentId} showName={false} />
                <span className={cn('min-w-0 flex-1 pt-0.5 text-[0.95rem] leading-snug font-medium', !request.title && 'text-muted-foreground')}>{titleOf(request)}</span>
              </span>
              <span className="flex flex-col items-start gap-1.5 pl-[38px]">
                <FlipStatus state={request.state} />
                <NextMove next={request.next} />
              </span>
            </button>
          </ListItem>
        ))}
      </ul>}

      {wide && <div className="overflow-hidden rounded-xl border bg-card shadow-panel">
        <Table>
          <TableHeader className="bg-surface/60">
            <TableRow>
              <TableHead className="w-10"><span className="sr-only">{t("Agent")}</span></TableHead>
              <TableHead>{t("Request")}</TableHead>
              {team && <TableHead>{t("Asked by")}</TableHead>}
              {sortHead('Status', 'attention')}
              <TableHead>{t("Next step")}</TableHead>
              {sortHead('Progress', 'progress')}
              {sortHead('Started', 'started')}
            </TableRow>
          </TableHeader>
          <TableBody>
            {requests.map((request) => (
              <ListTableRow key={request.id} requestId={request.id} onClick={() => onOpen(request)}>
                <TableCell className="align-top"><AgentIcon agentId={request.agentId} showName={false} /></TableCell>
                <TableCell className="max-w-72 align-top whitespace-normal">
                  <button type="button" onClick={(event) => { event.stopPropagation(); onOpen(request) }} className={cn('rounded-sm text-left leading-snug font-medium hover:underline focus-visible:outline-2 focus-visible:outline-ring', !request.title && 'text-muted-foreground')}>{titleOf(request)}</button>
                  <div><FocusAreaChip focusAreaId={request.focusAreaId} onOpen={onOpenFocus} /></div>
                </TableCell>
                {team && <TableCell className="align-top text-sm">{request.askedBy}</TableCell>}
                <TableCell className="align-top"><FlipStatus state={request.state} /></TableCell>
                <TableCell className="max-w-64 align-top whitespace-normal"><NextMove next={request.next} /></TableCell>
                <TableCell className="w-32 align-top"><ProgressMeter request={request} compact /></TableCell>
                <TableCell className="align-top text-xs text-muted-foreground"><time dateTime={request.startedAtIso}>{displayTime(request.startedAt)}</time></TableCell>
              </ListTableRow>
            ))}
          </TableBody>
        </Table>
      </div>}
    </Req>
  )
}

const AGENT_STATUS_LABEL: Record<NonNullable<WorkAgent['status']>, string> = { working: 'Working', quiet: 'No recent step', finished: 'Finished' }

/**
 * A subagent's recorded state. Finished only on a recorded stop; a quiet subagent stays quiet, never guessed done.
 * One that finished before stops were recorded can be marked finished by the owner (saved as a work-state row).
 */
function SubagentStatus({ agent }: { agent: WorkAgent }) {
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (!agent.status) return null
  // Resolves false on failure so the button shows no check; the error line below says what went wrong.
  const mark = async () => {
    setSaving(true)
    setError(null)
    try {
      await useStore.getState().markAgentFinished(agent.id)
      return true
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
      return false
    } finally {
      setSaving(false)
    }
  }
  return (
    <div className="space-y-1 px-3 pb-2">
      <div className="flex min-h-9 items-center justify-between gap-2 text-xs">
        <span className={cn('text-muted-foreground', agent.status === 'finished' && 'text-shipped-foreground')}>
          {t(AGENT_STATUS_LABEL[agent.status])}{agent.status === 'finished' && agent.finishedAt ? ` · ${displayTime(agent.finishedAt)}` : ''}
        </span>
        {agent.canMarkFinished && (
          <SaveButton className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'h-11 shrink-0 text-xs md:h-7')} disabled={saving} onClick={mark}>{t("Mark finished")}</SaveButton>
        )}
      </div>
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    </div>
  )
}

/** Each agent with its requests in this view, busiest first: most urgent request, then how many; idle agents last. */
function agentsByUrgency(agents: WorkAgent[], requests: Request[]) {
  const urgency = (theirs: Request[]) => theirs.length ? Math.min(...theirs.map((request) => ATTENTION_ORDER.indexOf(request.state))) : ATTENTION_ORDER.length
  return agents
    .map((agent, index) => ({ agent, index, theirs: requests.filter((request) => request.agentId === agent.id) }))
    .sort((a, b) => urgency(a.theirs) - urgency(b.theirs) || b.theirs.length - a.theirs.length || a.index - b.index)
}

/** One card per running agent: its mark, its role and machine, so two agents of one tool are told apart (§4, §13.2). */
function ByAgentView({ requests, onOpen }: { requests: Request[]; onOpen: (request: Request) => void }) {
  const { agents } = useWorkModel()
  return (
    <Req ids={['R4.3', 'R13.2', 'R13.4']}>
      {/* Masonry columns, so a short card never leaves a gap under a long one. Agents with work in this view come
          first, the one with the most urgent request on top; agents with nothing here go last. */}
      <div className="min-w-0 gap-4 md:columns-2 xl:columns-3">
        {agentsByUrgency(agents, requests).map(({ agent, theirs }) => {
          const device = deviceById(agent.deviceId)
          return (
            <motion.div key={agent.id} layout="position" transition={GLIDE} className="mb-4 break-inside-avoid">
            <HoverCell>
            <Agent className="min-w-0">
              <AgentHeader name={agent.name} role={agent.role} icon={<AgentMark tool={agent.tool} className="size-5" />}
                model={`${device.name} · ${device.syncedMinutesAgo === 0 ? t("this machine") : interpolate(t('synced {minutes} min ago'), { minutes: device.syncedMinutesAgo })}`} />
              <AgentContent className="space-y-0 px-2 pb-2">
                <SubagentStatus agent={agent} />
                {theirs.length === 0 && <p className="px-3 pb-3 text-sm text-muted-foreground">{t("Nothing on it in this view.")}</p>}
                {theirs.map((request) => (
                  <button key={request.id} type="button" onClick={() => onOpen(request)} className="flex w-full min-w-0 flex-col gap-1.5 rounded-lg px-3 py-2.5 text-left hover:bg-surface focus-visible:outline-2 focus-visible:outline-ring">
                    <span className="flex w-full min-w-0 items-start justify-between gap-2">
                      <span className={cn('min-w-0 text-sm leading-snug font-medium', !request.title && 'text-muted-foreground')}>{titleOf(request)}</span>
                      <StateBadge state={request.state} />
                    </span>
                    <NextMove next={request.next} className="text-xs" />
                  </button>
                ))}
              </AgentContent>
            </Agent>
            </HoverCell>
            </motion.div>
          )
        })}
      </div>
    </Req>
  )
}

/** TeamBrain on the same GUI: one column per person, with collisions called out (§9). */
function TeamBoard({ requests, onOpen }: { requests: Request[]; onOpen: (request: Request) => void }) {
  const { sourceKind, people } = useWorkModel()
  return (
    <Req ids={['R9.2', 'R9.1', 'R9.3']}>
      <div className="space-y-4">
        {sourceKind === 'sample' && (
          <Alert className="border-attention-border bg-attention text-attention-foreground">
            <TriangleAlertIcon />
            <AlertTitle>{t("Possible collision (sample)")}</AlertTitle>
            <AlertDescription className="text-attention-foreground">{t("Alex and Priya both have agents changing the price forecast page.")}</AlertDescription>
          </Alert>
        )}
        <div className="grid gap-4 md:grid-cols-3">
          {people.map((person) => (
            <div key={person} className="space-y-2.5 rounded-xl border bg-card/60 p-4 shadow-panel">
              <p className="section-label">{person}</p>
              {requests.filter((request) => request.askedBy === person).map((request) => (
                <button key={request.id} type="button" onClick={() => onOpen(request)} className="w-full space-y-2 rounded-lg border bg-card p-3 text-left hover:bg-surface">
                  <p className="text-sm leading-snug">{titleOf(request)}</p>
                  <div className="flex items-center justify-between gap-2"><AgentIcon agentId={request.agentId} /><StateBadge state={request.state} /></div>
                </button>
              ))}
            </div>
          ))}
        </div>
      </div>
    </Req>
  )
}

/** A request whose records disagree with the lifecycle rules: its own card, with the reason and its source (plan R3). */
function RequestReadErrorCard({ readError }: { readError: RequestReadError }) {
  return (
    <Req ids={['R12.1']}>
      <Alert className="h-full border-attention-border bg-card">
        <TriangleAlertIcon />
        <AlertTitle className="line-clamp-none">{interpolate(t("Couldn't read this request: {reason}"), { reason: readError.reason })}</AlertTitle>
        <AlertDescription>
          {readError.title && <p>{readError.title}</p>}
          {readError.evidenceHref && <a href={readError.evidenceHref} target="_blank" rel="noreferrer" className="underline underline-offset-4 hover:text-foreground">{t("Open the prompt it came from")}</a>}
        </AlertDescription>
      </Alert>
    </Req>
  )
}

/**
 * The work model could not be read from the worker's records (sourceHealth): plain words, the worker's own message
 * folded under Details in monospace, and Try again (G17; it printed the raw message as the description). The one
 * read-failure alert (components/bits.tsx WorkReadFailureAlert).
 */
function SourceReadAlert({ error }: { error: string | null }) {
  return <WorkReadFailureAlert title={t("Can't read local work right now")} description={t('The worker answered, but could not read your saved work. It may be busy; try again in a moment.')} cause={error} />
}

/**
 * The row above the requests (c-work-filters): the view as one joined control and the filters as chips, each with a
 * small visible label; Sort with its word and its choice; and the refresh line at the end. Chosen items show the
 * primitive's chosen look (fill, edge, weight, check; no orange) and counts are monospace. On a phone it is two 44px
 * rows: the view, then the filter chips (they scroll sideways inside their row) with Sort. It wraps instead of
 * widening the page at any width (the page measured 807–824px at a 768–820px window).
 */
function WorkToolbar({ view, filter, sort, requests, team, refreshLine, refreshFailed, onView, onFilter, onSort }: {
  view: View; filter: Filter; sort: SortKey; requests: Request[]; team: boolean; refreshLine: ReactNode
  /** A failed refresh is an alert with its own Try again and Details: it takes a row of its own. */
  refreshFailed: boolean
  onView: (view: View) => void; onFilter: (filter: Filter) => void; onSort: (sort: SortKey) => void
}) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-5 gap-y-3">
      <Req ids={['R4.1', 'R4.2', 'R4.3', 'R9.2']}>
        <div className="flex min-w-0 items-center gap-2 max-md:w-full">
          {/* The group's name is these same words (aria-label), so the visible label is not read twice. */}
          <span aria-hidden="true" className="hidden text-xs text-muted-foreground md:inline">{t('View')}</span>
          <ToggleGroup type="single" variant="outline" size="sm" spacing={0} value={view} onValueChange={(next) => next && onView(next as View)} aria-label={t('View')} className="max-md:w-full max-md:flex-nowrap max-md:*:flex-1">
            {VIEWS.filter((entry) => entry.value !== 'team' || team).map(({ value, label }) => (
              <ToggleGroupItem key={value} value={value} className="px-3.5">{t(label)}</ToggleGroupItem>
            ))}
          </ToggleGroup>
        </div>
      </Req>
      <div className="flex min-w-0 items-center gap-2 max-md:w-full">
        <span aria-hidden="true" className="hidden text-xs text-muted-foreground md:inline">{t('Filter')}</span>
        {/* A phone keeps the chips on one row that scrolls sideways inside itself; the page never does. */}
        <ToggleGroup type="single" variant="outline" size="sm" spacing={1} value={filter} onValueChange={(next) => next && onFilter(next as Filter)} aria-label={t('Filter')} className="min-w-0 max-md:flex-1 max-md:flex-nowrap max-md:overflow-x-auto max-md:py-0.5">
          {FILTERS.filter((entry) => entry.value !== 'closed' || filter === 'closed' || requests.some(entry.matches)).map(({ value, label, dot, matches: test }) => (
            <ToggleGroupItem key={value} value={value} className="gap-1.5 px-3">
              {dot && <span aria-hidden="true" className={cn('size-1.5 rounded-full', dot)} />}
              {t(label)}
              <span className="text-muted-foreground mono-number group-data-[state=on]/toggle:text-foreground">{requests.filter(test).length}</span>
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        {view !== 'agents' && view !== 'team' && (
          <Select value={sort} onValueChange={(next) => onSort(next as SortKey)}>
            {/* "Sort: Needs you first" with the primitive's ≥3:1 edge (G12; it had none). A phone shows the word and the icon. */}
            <SelectTrigger size="sm" aria-label={t('Sort')} className="shrink-0 bg-transparent text-[0.82rem]">
              <ArrowUpDownIcon aria-hidden="true" className="size-4 md:hidden" />
              <span className="md:hidden">{t('Sort')}</span>
              <span className="hidden md:inline">{sentenceWith(t('Sort: {choice}'), 'choice', <span className="text-foreground"><SelectValue /></span>)}</span>
            </SelectTrigger>
            <SelectContent>{SORTS.map(({ value, label }) => <SelectItem key={value} value={value}>{t(label)}</SelectItem>)}</SelectContent>
          </Select>
        )}
      </div>
      {refreshLine && <div className={cn('flex min-w-0 grow basis-full justify-end', !refreshFailed && 'md:basis-auto')}>{refreshLine}</div>}
    </div>
  )
}

/**
 * My Work: the live inbox. The home page leads with what needs you and what is moving (page-01), then the focus areas,
 * then every request. With a focus area (or Other) selected, its header comes first and only the requests in it show;
 * requests not sorted yet ("Sorting…") show only under every request. `onReply` opens a request's drawer with its reply
 * box focused (G2); without it, Reply opens the drawer.
 */
export function MyWork({ focusAreaId, onOpen, onReply = onOpen, onOpenFocus, onOpenRules }: { focusAreaId: string | null; onOpen: (request: Request) => void; onReply?: (request: Request) => void; onOpenFocus: (focusAreaId: string) => void; onOpenRules: () => void }) {
  useI18n()
  const { team } = useWorkspace()
  const { sourceKind, requests: allRequests, requestReadErrors: allReadErrors, unlinkedWorkCount, sourceHealth, buildStory, lastRuns, refresh, focusAreas } = useWorkModel()
  const area = focusAreaId && focusAreaId !== OTHER_FOCUS_AREA_ID ? focusAreas.find((entry) => entry.id === focusAreaId) ?? null : null
  const requests = useMemo(() => {
    if (!focusAreaId) return allRequests
    const resolveArea = createFocusAreaResolver(focusAreas)
    return allRequests.filter((request) => resolveArea(request.focusAreaId) === focusAreaId)
  }, [allRequests, focusAreas, focusAreaId])
  // A request that could not be read has no placement to file it under, so its card shows only under every request.
  const requestReadErrors = focusAreaId ? [] : allReadErrors
  const focusChanges = useFocusChanges()
  const sample = sourceKind === 'sample'
  // How the person likes to see My Work is saved across visits (store/create-store.ts).
  const { listView: view, filter, sort } = useStore(useShallow((state) => ({ listView: state.view.listView, filter: state.view.filter, sort: state.view.sort })))
  const focusArtwork = useStore((state) => state.view.focusArtwork)
  const homeAnchorRequest = useStore((state) => state.view.homeAnchorRequest)
  const { setListView: setView, setFilter, setSort, goToHome } = useStore.getState()
  const [storyOpen, setStoryOpen] = useState(false)
  const matches = FILTERS.find((entry) => entry.value === filter)!.matches
  const visible = useMemo(() => sortRequests(requests.filter(matches), sort), [requests, matches, sort])
  const open = requests.filter((request) => !request.closed)
  // "Show all N" lands on every request with that filter on (the home page's All requests; a focus page's own board).
  const showOnBoard = (next: Filter) => { setFilter(next); if (!focusAreaId) goToHome('all-requests') }
  // Live mode shows the worker's automatic refresh, or the last review before its first run. No cost. This page's
  // worker can start one, so the line carries its button (c-work-filters: the review's time beside Refresh).
  const refreshLine = sample ? <RefreshButton run={SAMPLE_RUNS.progress} ids={['R14.12']} />
    : sourceKind === 'local' ? <RefreshStatus refresh={refresh} run={lastRuns.progress} label="Last reviewed" ids={['R14.12']} canStartRefresh />
      : (refresh || lastRuns.progress) ? <RefreshStatus refresh={refresh} run={lastRuns.progress} label="Last reviewed" ids={['R14.12']} /> : null

  return (
    <div className="space-y-4 md:space-y-5">
      {!sourceHealth.connected && <SourceReadAlert error={sourceHealth.error} />}
      <FocusChangeBar changes={focusChanges} />
      {!focusAreaId && <NeedsYouFirst requests={open} onOpen={onOpen} onReply={onReply} onOpenFocus={onOpenFocus} onShowWorking={() => showOnBoard('working')} />}
      {/* `/#focus-areas` (the rail's and chip row's "All N", the bottom bar's Focus) opens this board with every area shown. */}
      {!focusAreaId && <FocusOverview anchorId={'focus-areas' satisfies HomeAnchor} expandAllOn={homeAnchorRequest?.anchor === 'focus-areas' ? homeAnchorRequest.sequence : 0} areas={focusAreas} requests={allRequests} incomplete={allReadErrors.length > 0} onOpenArea={onOpenFocus} onOpenRequest={onOpen} artwork={focusArtwork} onArtworkChange={useStore.getState().setFocusArtwork} />}
      {/* Every request in the area, closed ones too: the combined progress counts each reviewed request (D1's rule). */}
      {area ? <FocusHeader key={area.id} area={area} requests={requests} changes={focusChanges} />
        : focusAreaId === OTHER_FOCUS_AREA_ID && <OtherHeader requests={requests} />}
      {/* `/#all-requests`: the rail's and the bottom bar's My Work land here (page-02 deep-linking). */}
      {!focusAreaId && <h2 id={'all-requests' satisfies HomeAnchor} className="section-label">{t('All requests')}</h2>}
      {focusAreaId && <Summary requests={open} primary={!(area && asksToKeepOrDismiss(area))} onOpen={onOpen} onReply={onReply} onShowNeedsYou={() => showOnBoard('needs-you')} onShowWorking={() => showOnBoard('working')} />}
      <ChangeTicker onOpen={(requestId) => { const request = allRequests.find((entry) => entry.id === requestId); if (request) onOpen(request) }} />

      <WorkToolbar view={view} filter={filter} sort={sort} requests={requests} team={team} refreshLine={refreshLine} refreshFailed={!sample && refreshLineState(refresh) === 'failed'}
        onView={setView} onFilter={setFilter} onSort={setSort} />

      {requests.length === 0 && requestReadErrors.length === 0 ? (
        <Req ids={['R12.1']}>
          <Empty className="border bg-card/60">
            <EmptyHeader>
              <EmptyMedia variant="icon"><InboxIcon /></EmptyMedia>
              <EmptyTitle>{focusAreaId ? t("No requests in this area yet.") : t("No requests recorded yet.")}</EmptyTitle>
              <EmptyDescription>{focusAreaId ? t("A refresh places new requests here, or move one here from its page.") : t("Ask an agent for something and it appears here.")}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        </Req>
      ) : visible.length === 0 && requestReadErrors.length === 0 ? (
        <Req ids={['R12.1']}>
          <Empty className="border bg-card/60">
            <EmptyHeader>
              <EmptyMedia variant="icon"><InboxIcon /></EmptyMedia>
              <EmptyTitle>{t("Nothing here")}</EmptyTitle>
              <EmptyDescription>{t("No requests match. New work shows up as soon as an agent writes it.")}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        </Req>
      ) : view === 'cards' ? (
        <CardsView requests={visible} grouped={sort === 'attention' && filter === 'all'} readErrors={requestReadErrors} onOpen={onOpen} onReply={onReply} onOpenFocus={onOpenFocus} />
      ) : view === 'list' ? <ListView requests={visible} sort={sort} onSort={setSort} onOpen={onOpen} onOpenFocus={onOpenFocus} />
        : view === 'agents' ? <ByAgentView requests={visible} onOpen={onOpen} />
          : <TeamBoard requests={visible} onOpen={onOpen} />}
      {view !== 'cards' && requestReadErrors.length > 0 && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {requestReadErrors.map((readError) => <RequestReadErrorCard key={readError.requestId} readError={readError} />)}
        </div>
      )}
      {unlinkedWorkCount > 0 && (
        <p className="text-xs text-muted-foreground">{interpolate(unlinkedWorkCount === 1 ? t("{count} work record isn't linked to a request yet.") : t("{count} work records aren't linked to a request yet."), { count: unlinkedWorkCount })}</p>
      )}

      {/* The recap and the build story are written by request-progress; with no story, both are hidden. */}
      {buildStory && (
        <>
          <TodayPanel story={buildStory} requests={requests} onOpenStory={() => setStoryOpen(true)} />
          <StorySheet open={storyOpen} story={buildStory} requests={requests} onClose={() => setStoryOpen(false)} onOpenRules={() => { setStoryOpen(false); onOpenRules() }} />
        </>
      )}
    </div>
  )
}
