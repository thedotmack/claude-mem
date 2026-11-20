import { displayRecordedDate, recordedTimeWords } from '@/lib/display-time'
import { t, useI18n, interpolate } from '@/lib/i18n'
import { useCallback, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { ArrowDownIcon, ArrowRightIcon, ArrowUpDownIcon, ExternalLinkIcon, ImageIcon, InboxIcon, PlugIcon, PlusIcon, TriangleAlertIcon, UsersIcon } from 'lucide-react'
import { Agent, AgentContent, AgentHeader } from '@/components/ai-elements/agent'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleFoldTrigger } from '@/components/ui/collapsible'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Table, TableBody, TableCell, TableHead, TableHeader, TablePageFooter, TableRow } from '@/components/ui/table'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { AgentIcon, FocusAreaChip, LocalTime, NeedsYouPill, NextMove, ProgressMeter, RecordedTime, RefreshButton, RefreshStatus, StateMark, WorkReadFailureAlert } from '@/components/bits'
import { sentenceWith } from '@/lib/sentence-with'
import { TracingBeam } from '@/components/aceternity/tracing-beam'
import { AgentMark } from '@/components/brand'
import { FocusChangeBar, useFocusChanges } from '@/components/focus-changes'
import { FocusHeader, NotStartedAsks, OtherHeader } from '@/components/focus-header'
import { FocusMainCard, ReplyActions } from '@/components/focus-main-card'
import { ErrorDetails } from '@/components/error-details'
import { agentOwnRoleWords, deviceName } from '@/lib/agent-words'
import { ChangeTicker, RunningFor } from '@/components/live-motion'
import { RequestCard } from '@/components/request-card'
import { RequestLine } from '@/components/request-line'
import { useWidthOf } from '@/lib/use-media'
import { cn } from '@/lib/utils'
import { Req } from '@/spec/req'
import { byAttention, firstNeedingYou, isSubagent, isWorkingNow, needsYou, OTHER_FOCUS_AREA_ID, requestTitle, SAMPLE_RUNS, startedTimestamp, type Agent as WorkAgent, type LiveState, type Request } from '@/data'
import { type WorkFilter, type WorkListView, type WorkSort, deviceById, useFreshlyUpdated, useStore, useWorkModel, useWorkspace } from '@/store'
import type { HomeAnchor } from '@/store/home-anchor'
import { useShallow } from 'zustand/react/shallow'
import type { BuildStory, StoryChapter } from '@/live/work-data-source'
import { asksToKeepOrDismiss, createFocusAreaResolver, focusAreaPlaceWords } from '@/live/to-focus-model'
import { THIS_COMPUTER } from '@/live/to-work-model'
import { agentBoard, type AgentEntry } from '@/live/agent-board'
import { DURATION_WORD } from '@/live/running-time'
import { refreshLineState } from '@/live/refresh-line'
import { CARD_SIZE, LINE_ROWS_PER_PAGE, LIST_TITLE_MIN_PX, cardGridEntries, lineSections, requestSections, type CardGroup, type CardSize } from '@/live/card-groups'
import { datedHeading, fitLine, storyChapters, storyNumbers } from '@/live/build-story'
import { FocusOverview } from '@/components/focus-overview'
import '@/components/focus-overview.css'
import { GroupLabel, ListStatus, RequestGroup, RequestGroups, RequestRow, ShowMoreRows } from '@/components/request-rows'
import { RequestReadErrors } from '@/components/request-read-errors'
import { FOCUS_FROM_CODE_CLASS_NAME, PagingResetContext, usePagedRows } from '@/lib/paged-rows'
import { TEAMBRAIN_START_URL } from '../../../viewer/constants/promo'

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
  { value: 'working', label: 'Working', matches: isWorkingNow, dot: 'bg-working-foreground' },
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
        : byAttention(a, b))
}

/**
 * How many moving requests are named before "Show all N" / "and N more": page-01's mockup draws three rows under
 * "Moving now" (the plan's "three titles readable"), and the rest are counted, not drawn (progressive-disclosure).
 */
const MOVING_NAMED = 3

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
  const waiting = firstNeedingYou(requests)
  const moving = sortRequests(requests.filter((request) => request.state === 'working'), 'started')
  const needsYouId = useId()
  const movingId = useId()
  return (
    <Req ids={['R12.2', 'R12.3', 'R1.1']}>
      <div className="space-y-6">
        <section aria-labelledby={needsYouId} className="space-y-3">
          <CountedHeading id={needsYouId} dot="bg-attention-foreground" tone="text-attention-foreground" label="Needs you" count={waiting.length} />
          {waiting.length === 0 ? <p className="text-sm text-muted-foreground">{t('Nothing needs you right now.')}</p> : (
            // Cards in a row share its height, each footer on its card's bottom edge (D b5 M116, CardFooter mt-auto).
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
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
              {story.writtenAt && <span className="text-xs text-muted-foreground mono-number">{interpolate(t('written {date}'), { date: recordedTimeWords(story.writtenAtIso, story.writtenAt, 'time-or-day') })}</span>}
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
          <SheetDescription>{interpolate(t('From request-progress, reviewed from memory{writtenAt}.'), { writtenAt: story.writtenAt ? `, ${interpolate(t('written {date}'), { date: recordedTimeWords(story.writtenAtIso, story.writtenAt, 'time-or-day') })}` : '' })}</SheetDescription>
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
    // As tall as its grid row, so the card in it can be (D b5 M116: cards in a row end level, footers pinned).
    <div className="group/hover-cell relative h-full min-w-0">
      <span aria-hidden="true" className="pointer-events-none absolute -inset-2 block rounded-2xl bg-accent/70 opacity-0 transition-opacity duration-150 group-hover/hover-cell:opacity-100" />
      <div className="relative h-full">{children}</div>
    </div>
  )
}

/**
 * One board card, its size by state (live/card-groups.ts CARD_SIZE); a card that needs you carries its Reply (G2).
 * `pagedRow`: one of the sorted board's paged cards, which "Show 50 more" puts focus on (lib/paged-rows.ts).
 *
 * A live change moves nothing on the board (plan rule 8: at most two moving things per view, the change ticker
 * included; Phase 6 verify V2): a card takes its new place, state and value at once, and the changed one carries the
 * still "just updated" mark (request-card.tsx). A state flip on home moved up to 6 things a frame for 0.58 s here: every
 * card's glide to its new place, each new or re-placed card's fade-in and the section headings' glide. The ticker's
 * slide to the new change (components/live-motion.tsx) is what moves.
 */
function CardCell({ request, size, pagedRow = false, onOpen, onReply, onOpenFocus }: { request: Request; size: Exclude<CardSize, 'line'>; pagedRow?: boolean; onOpen: (request: Request) => void; onReply: (request: Request) => void; onOpenFocus: (focusAreaId: string) => void }) {
  return (
    <div {...(pagedRow ? { 'data-list-row': '', tabIndex: -1 } : {})} className={cn('min-w-0', pagedRow && cn('rounded-xl', FOCUS_FROM_CODE_CLASS_NAME))}>
      <HoverCell>
        <RequestCard request={request} size={size} onOpen={() => onOpen(request)} onOpenFocus={onOpenFocus}
          actions={needsYou(request) ? <ReplyActions request={request} primary={false} onOpen={onOpen} onReply={onReply} /> : undefined} />
      </HoverCell>
    </div>
  )
}

/**
 * The Cards view (c-work-cards-view). Attention-first with every request: what needs you as full cards with Reply,
 * what is working as medium cards, both in one grid under h3 headings (a card whose status changes takes its place in
 * the other section at once, CardCell), then Idle and Shipped folded to one line each (G4). Sorted another way or
 * filtered, the requests keep that order, each drawn at its state's size, 50 at a time through the boards' one paging
 * (lib/paged-rows.ts): a new filter, sort or area starts on the first page, and "Show 50 more" puts focus on the first
 * card it added. Cards in a row share its height, each footer on its card's bottom edge (D b5 M116; they ended at
 * heights up to 345px apart in one row on the owner's data at 768, 2026-11-17).
 *
 * On a focus area page (`focusPage`, page-03 and page-04's order), attention-first with every request: the page's main
 * card above the board already leads with the first request that needs you (`lead`, components/focus-main-card.tsx),
 * so the board leaves it out; any others that need you stay full cards, and Working is one-line rows under its heading,
 * then Idle and Shipped folded.
 */
function CardsView({ requests, grouped, focusPage = false, lead = null, onOpen, onReply, onOpenFocus }: {
  requests: Request[]; grouped: boolean; focusPage?: boolean; lead?: string | null
  onOpen: (request: Request) => void; onReply: (request: Request) => void; onOpenFocus: (focusAreaId: string) => void
}) {
  const paged = usePagedRows(requests.length, true)
  if (!grouped) {
    return (
      <div className="space-y-3">
        <div id={paged.listId} className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {requests.slice(0, paged.shown).map((request) => {
            const size = CARD_SIZE[request.state]
            return size === 'line'
              ? <div key={request.id} data-list-row="" className="col-span-full"><RequestLine request={request} onOpen={onOpen} /></div>
              : <CardCell key={request.id} request={request} size={size} pagedRow onOpen={onOpen} onReply={onReply} onOpenFocus={onOpenFocus} />
          })}
        </div>
        <ShowMoreRows left={paged.left} onShowMore={paged.showMore} />
      </div>
    )
  }
  const onBoard = lead ? requests.filter((request) => request.id !== lead) : requests
  // On a focus page only the full cards stay in the grid; Working joins the sections drawn as rows.
  const cardEntries = cardGridEntries(focusPage ? onBoard.filter((request) => CARD_SIZE[request.state] === 'full') : onBoard)
  const rowSections = focusPage ? requestSections(onBoard).filter(({ group }) => group.size !== 'full') : lineSections(onBoard)
  return (
    <div className="space-y-4">
      {cardEntries.length > 0 && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {cardEntries.map((entry) => entry.kind === 'card'
            ? <CardCell key={entry.key} request={entry.request} size={entry.size} onOpen={onOpen} onReply={onReply} onOpenFocus={onOpenFocus} />
            : (
              <div key={entry.key} className="col-span-full flex items-center gap-2.5 pt-2 first:pt-0">
                <span aria-hidden="true" className={cn('size-2 rounded-full', entry.group.dot)} />
                <h3 className="text-sm font-semibold tracking-tight">{t(entry.group.label)}</h3>
                <span className="text-sm text-muted-foreground mono-number">{entry.count}</span>
                <span className="h-px flex-1 bg-border/70" />
              </div>
            ))}
        </div>
      )}
      {rowSections.map(({ group, members }) => <RequestGroup key={group.id} group={group} members={members} renderRow={(request) => <RequestLine request={request} onOpen={onOpen} />} />)}
    </div>
  )
}

/**
 * The List table's columns (c-ui-table): fixed widths in rem, the Next step column a share of the table, and the title
 * the rest. One definition: the headings take their widths from it, and ListView draws the table only where its own
 * width leaves the title column at least LIST_TITLE_MIN_PX (live/card-groups.ts). The fixed columns take 40.5rem (689px
 * at the 17px desktop root), so a title gets 187.5px at a 1366px window and 247px from 1440, where the page stops
 * widening (measured on the owner's data, 2026-11-17), nothing scrolls sideways, and the column headings can stick
 * under the floating header (a scroll box would hold them back). Narrower, each request is a RequestRow with its title
 * on a line of its own and, from 768px, the table's other columns on a line under it. Only one is built.
 */
const LIST_COLUMN_REM = { agent: 4, status: 11, progress: 9, started: 8.75, running: 7.75 } as const
const LIST_NEXT_STEP_SHARE = 0.2
/** The table box's 1px edge on each side: the table is the box's width less these. */
const LIST_TABLE_EDGES_PX = 2
/** The title column's width in a List `listWidth` wide, at a root font size of `remPx` (px). */
const listTitleColumnPx = (listWidth: number, remPx: number) =>
  (listWidth - LIST_TABLE_EDGES_PX) * (1 - LIST_NEXT_STEP_SHARE) - Object.values(LIST_COLUMN_REM).reduce((sum, rem) => sum + rem, 0) * remPx
const columnWidth = (rem: number) => ({ width: `${rem}rem` })


/**
 * The column headings stay in view under the floating header while the page scrolls the table (c-split-flap F
 * fixed-element-offset: the header covered them): stuck right under the header's pill (index.css
 * --page-header-bottom), on the table's own fill, with the row line drawn on them.
 */
const STUCK_HEAD = 'sticky top-(--page-header-bottom) z-[2] bg-card shadow-[inset_0_-1px_0_var(--color-border)]'

/**
 * A column the List sorts by. Only Status, Progress and Started sort, and each looks it: the sorted one with its
 * direction and `aria-sort`, the others with both arrows (F 410); the other headings are plain words.
 */
function SortHead({ label, value, sort, onSort, numeric = false, widthRem }: { label: string; value: SortKey; sort: SortKey; onSort: (sort: SortKey) => void; numeric?: boolean; widthRem: number }) {
  const sorted = sort === value
  return (
    <TableHead numeric={numeric} aria-sort={sorted ? 'descending' : undefined} className={STUCK_HEAD} style={columnWidth(widthRem)}>
      <Button variant="ghost" size="sm" onClick={() => onSort(value)} className={cn('font-medium', numeric ? '-mr-3' : '-ml-3', sorted ? 'text-foreground' : 'text-muted-foreground')}>
        {label}{sorted ? <ArrowDownIcon aria-hidden="true" /> : <ArrowUpDownIcon aria-hidden="true" />}
      </Button>
    </TableHead>
  )
}

/**
 * When a request started, in the reader's clock and short ("Nov 15, 2:50 pm"), the full stamp on hover, focus and tap
 * (the shared LocalTime, G9, G10, rule 9); a start that is not recorded (no `startedAtIso`) says so in words.
 */
function StartedAt({ request }: { request: Request }) {
  return request.startedAtIso ? <LocalTime iso={request.startedAtIso} /> : <span>{t('Start not recorded')}</span>
}

/**
 * One table row (D b20): 48px, a Tab stop that Enter or a click opens (the primitive's onActivate; the focus area link
 * and the start time inside keep their own press), the agent's mark (kept: the mockup leaves it out), the title on one
 * line, the status, the next step ("—" when none, G3), and progress, start and running time in monospace at the right
 * (M 418). Four Tab stops: the row, the agent's mark and the start time (G10: tooltip triggers), and the area link. A
 * row whose record just changed shows the still "just updated" mark (components/request-rows.tsx ListStatus).
 */
function ListTableRow({ request, onOpen, onOpenFocus }: { request: Request; onOpen: (request: Request) => void; onOpenFocus: (focusAreaId: string) => void }) {
  const fresh = useFreshlyUpdated(request.id)
  const { focusAreas } = useWorkModel()
  return (
    <TableRow data-list-row="" data-request-opener={request.id} data-just-updated={fresh || undefined} onActivate={() => onOpen(request)} className={cn(fresh && 'just-updated-mark')}>
      <TableCell><AgentIcon agentId={request.agentId} showName={false} /></TableCell>
      <TableCell>
        {/* The title has the cell's room first (G18's one line). The area link gives up its room first, a hundred times
            faster than the title (flex-shrink 100 to 1), down to its floor: it took up to 40% of the cell and left the
            title 89-99px at 1366 and 124-158px at 1440, cut on every row (owner's data, 2026-11-17). Its floor, min-w-11
            (2.75rem, 46.75px at the 17px desktop root), is the chip's mark (0.875rem) and gap (0.375rem), and 1.5rem for the
            name, less the link's 1px edges: 23.5px for an area's name, 25.5px for "Not sorted yet". A cut line keeps its
            first letter (CSS Overflow 3 clips the first character rather than replace it) and draws the ellipsis after
            it, so the name needs a letter and a whole ellipsis at text-xs (Geist, 12.75px): the ellipsis is 7.28px, and a
            Chinese first letter, the widest of the UI's languages (13.02px; Korean 11.03px, a Latin "W" 12.06px), makes
            20.30px together (measured 2026-11-17). At min-w-10 (2.5rem, 19.25px for the name) a Chinese first letter was
            1px over; at min-w-8 (2rem, sized for an ellipsis alone) the name had 10.75px and showed one dot of its
            ellipsis, "V.", which did not say that it is cut (plan rule 5; Phase 6 fix 2). So a cut link shows its mark
            and that it is cut, and never runs into the next column. A cut area name stays whole in the link's name for
            screen readers, in its hover text, and on the page it opens. A request not sorted yet is cut the same way
            (the chip's one-line layout): its words were built to wrap, which this row does not do. */}
        <div className="flex min-w-0 items-center gap-2">
          <span data-row-title="" className={cn('min-w-0 truncate font-medium', !request.title && 'text-muted-foreground')}>{titleOf(request)}</span>
          <span data-row-area="" className="flex min-w-11 shrink-[100]" title={focusAreaPlaceWords(request.focusAreaId, focusAreas, t)}><FocusAreaChip focusAreaId={request.focusAreaId} onOpen={onOpenFocus} layout="line" /></span>
          {fresh && <span className="sr-only">{t('Just updated')}</span>}
        </div>
      </TableCell>
      <TableCell><ListStatus request={request} /></TableCell>
      <TableCell><NextMove next={request.next} whenMissing="dash" layout="line" /></TableCell>
      <TableCell numeric><ProgressMeter request={request} compact /></TableCell>
      <TableCell numeric className="text-xs text-muted-foreground"><StartedAt request={request} /></TableCell>
      <TableCell numeric className="text-muted-foreground"><span className="sr-only">{t(DURATION_WORD[request.state])} </span><RunningFor request={request} className="text-xs" /></TableCell>
    </TableRow>
  )
}

/**
 * A state group in the table (G4): its heading row, or for Idle and Shipped its fold row ("Idle · 118"), then its rows
 * 50 at a time. Each group is its own row group (tbody), so its fold controls exactly its rows. A folded group is that
 * one line: its "Show 50 more" shows only once it is open (it showed under the closed fold row).
 */
function TableGroup({ group, members, columns, renderRow }: { group: CardGroup; members: Request[]; columns: number; renderRow: (request: Request) => ReactNode }) {
  const folds = group.size === 'line'
  const paged = usePagedRows(members.length, !folds)
  const body = (
    <TableBody id={paged.listId} data-list-group={group.id}>
      <TableRow className="hover:bg-transparent">
        <TableHead scope="rowgroup" colSpan={columns} className={cn('h-auto py-1.5', folds ? 'px-2 first:pl-2 last:pr-2' : 'text-sm font-semibold text-foreground')}>
          {folds
            ? <CollapsibleFoldTrigger aria-controls={paged.listId} count={<span className="mono-number">{members.length}</span>}><GroupLabel group={group} /></CollapsibleFoldTrigger>
            : <span className="flex items-center gap-2"><GroupLabel group={group} /><span className="font-normal text-muted-foreground mono-number">{members.length}</span></span>}
        </TableHead>
      </TableRow>
      {members.slice(0, paged.shown).map(renderRow)}
      {paged.open && paged.left > 0 && (
        <TableRow className="hover:bg-transparent">
          <TableCell colSpan={columns}><ShowMoreRows left={paged.left} onShowMore={paged.showMore} /></TableCell>
        </TableRow>
      )}
    </TableBody>
  )
  return folds ? <Collapsible asChild open={paged.open} onOpenChange={paged.setOpen}>{body}</Collapsible> : body
}

/**
 * The table (c-ui-table): named for screen readers (F 415), fixed columns so a page of rows never shifts them, and its
 * headings stuck under the floating header. The box rounds its corners with overflow-clip, not hidden, so it does not
 * become a scroll box and the headings can stick; ListView draws it only where the columns fit, so nothing scrolls sideways.
 * Only without Team (live/card-groups.ts LIST_TITLE_MIN_PX): in team mode the List is rows, with who asked on each row.
 */
function ListTable({ requests, grouped, sort, onSort, onOpen, onOpenFocus }: { requests: Request[]; grouped: boolean; sort: SortKey; onSort: (sort: SortKey) => void; onOpen: (request: Request) => void; onOpenFocus: (focusAreaId: string) => void }) {
  const paged = usePagedRows(requests.length, true)
  const columns = 7
  const row = (request: Request) => <ListTableRow key={request.id} request={request} onOpen={onOpen} onOpenFocus={onOpenFocus} />
  return (
    <div className="space-y-1">
      <div className="overflow-clip rounded-xl border bg-card shadow-panel [&>[data-slot=table-container]]:overflow-visible">
        <Table aria-label={t('Requests')} className="table-fixed [&_td]:px-3 [&_th]:px-3">
          <TableHeader className="[&_tr]:border-b-0">
            <TableRow className="hover:bg-transparent">
              <TableHead className={STUCK_HEAD} style={columnWidth(LIST_COLUMN_REM.agent)}><span className="sr-only">{t('Agent')}</span></TableHead>
              <TableHead className={STUCK_HEAD} data-list-title-column="">{t('Request')}</TableHead>
              <SortHead label={t('Status')} value="attention" sort={sort} onSort={onSort} widthRem={LIST_COLUMN_REM.status} />
              <TableHead className={STUCK_HEAD} style={{ width: `${LIST_NEXT_STEP_SHARE * 100}%` }}>{t('Next step')}</TableHead>
              <SortHead label={t('Progress')} value="progress" sort={sort} onSort={onSort} numeric widthRem={LIST_COLUMN_REM.progress} />
              <SortHead label={t('Started')} value="started" sort={sort} onSort={onSort} numeric widthRem={LIST_COLUMN_REM.started} />
              <TableHead numeric className={STUCK_HEAD} style={columnWidth(LIST_COLUMN_REM.running)}>{t('Running')}</TableHead>
            </TableRow>
          </TableHeader>
          {grouped
            ? requestSections(requests).map(({ group, members }) => <TableGroup key={group.id} group={group} members={members} columns={columns} renderRow={row} />)
            : <TableBody id={paged.listId}>{requests.slice(0, paged.shown).map(row)}</TableBody>}
        </Table>
      </div>
      {!grouped && <TablePageFooter className="px-1" shownCount={paged.shown} totalCount={requests.length} pageSize={LINE_ROWS_PER_PAGE} onShowMore={paged.showMore} />}
    </div>
  )
}

/**
 * The List (c-work-list-view): 48px rows, the status as the state badge, "—" for a missing next step, 50 rows at a time
 * (G4: grouped attention-first, Idle and Shipped folded; sorted another way or filtered, one list with "Showing 50 of
 * 195 · Show 50 more"). Rows are Tab stops that Enter opens. The table where its title column keeps its floor, without Team
 * (live/card-groups.ts LIST_TITLE_MIN_PX); otherwise rows, which from 768px carry the table's other columns on a line
 * of their own (rule 2).
 */
function ListView({ requests, grouped, sort, onSort, onOpen, onOpenFocus }: { requests: Request[]; grouped: boolean; sort: SortKey; onSort: (sort: SortKey) => void; onOpen: (request: Request) => void; onOpenFocus: (focusAreaId: string) => void }) {
  const { team } = useWorkspace()
  const box = useRef<HTMLDivElement>(null)
  const measured = useWidthOf(box)
  // From the List's own width, not the window's: a classic 15px scrollbar (Chrome on Windows and Linux) takes 12px from
  // the title column, which left it 175.5px at a 1366px window under a window-width rule (PR #6210 CI); now the List
  // stays rows there, and is the table wherever its title column keeps LIST_TITLE_MIN_PX.
  const wide = !team && measured !== null && listTitleColumnPx(measured.width, measured.remPx) >= LIST_TITLE_MIN_PX
  return (
    <Req ids={['R4.2', 'R4.4', 'R2.1', 'R5.8', 'R11.1']}>
      <div ref={box} data-list-box={wide ? 'table' : 'rows'}>
        {wide ? <ListTable requests={requests} grouped={grouped} sort={sort} onSort={onSort} onOpen={onOpen} onOpenFocus={onOpenFocus} />
          : (
            <div className="rounded-xl border bg-card p-1.5 shadow-panel">
              <RequestGroups requests={requests} grouped={grouped} countAlways renderRow={(request) => <RequestRow request={request} onOpen={onOpen} facts={{ onOpenFocus }} />} />
            </div>
          )}
      </div>
    </Req>
  )
}

/** A subagent's recorded state in words. Finished only on a recorded stop; a quiet subagent stays quiet, never guessed done. */
const AGENT_STATUS_LABEL: Record<NonNullable<WorkAgent['status']>, string> = { working: 'Working', quiet: 'No recent step', finished: 'Finished' }
/** The mark beside each, G11's shapes: working's ring, a hollow ring while quiet, a check once finished. */
const AGENT_STATUS_MARK: Record<NonNullable<WorkAgent['status']>, LiveState> = { working: 'working', quiet: 'idle', finished: 'shipped' }
/** The words' colour for each, the colour of the state whose mark it borrows. */
const AGENT_STATUS_TONE: Record<NonNullable<WorkAgent['status']>, string> = { working: 'text-working-foreground', quiet: 'text-muted-foreground', finished: 'text-shipped-foreground' }

/**
 * "Mark finished" records a stop for a subagent no recorded stop covers. POST /api/work-view/agents/mark-finished
 * appends an agent-lifecycle work-state row, and no route removes one, so My Work cannot undo it: it asks first
 * (c-work-by-agent-view F confirmation-dialogs; it saved on one press). A failure says so in plain words, the worker's
 * message under Details (G17), and the dialog stays open to try again or cancel. Once saved, the button is gone (the
 * stop is recorded), so focus lands on the subagent's status, which now reads Finished (`onMarked`).
 */
function MarkFinishedDialog({ agent, open, onOpenChange, onMarked }: { agent: WorkAgent; open: boolean; onOpenChange: (open: boolean) => void; onMarked: () => void }) {
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const marked = useRef(false)
  const confirm = async () => {
    setSaving(true)
    setError(null)
    try {
      await useStore.getState().markAgentFinished(agent.id)
      marked.current = true
      onOpenChange(false)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setSaving(false)
    }
  }
  return (
    <Dialog open={open} onOpenChange={(next) => { if (saving) return; onOpenChange(next); if (!next) setError(null) }}>
      <DialogContent onCloseAutoFocus={(event) => { if (!marked.current) return; event.preventDefault(); marked.current = false; onMarked() }}>
        <DialogHeader>
          <DialogTitle>{t('Mark this subagent finished?')}</DialogTitle>
          <DialogDescription>{t('My Work records that it stopped now. This can’t be undone here; the subagent shows as working again only if it records new work.')}</DialogDescription>
        </DialogHeader>
        {error && (
          <div role="alert" className="space-y-2">
            <p className="text-sm text-destructive">{t('The subagent wasn’t marked finished.')}</p>
            <ErrorDetails cause={error} />
          </div>
        )}
        <DialogFooter showCloseButton>
          <Button busy={saving} busyLabel={t('Saving…')} onClick={() => void confirm()}>{t('Mark finished')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * A subagent's recorded state with its mark, and "Mark finished" only where no stop is recorded
 * (c-work-by-agent-view M; agent-view.mjs canMarkFinished). The confirm stays mounted after the stop is saved, so it can
 * close and put focus on the status, which shows the focus ring (G16). A stop's time is the reader's clock (the shared
 * LocalTime); an older worker sends it only as text (G19).
 */
function SubagentStatus({ agent }: { agent: WorkAgent }) {
  const statusRef = useRef<HTMLParagraphElement | null>(null)
  const [confirming, setConfirming] = useState(false)
  if (!agent.status) return null
  return (
    <div className="flex min-h-9 items-center justify-between gap-2 px-2.5 text-sm">
      <p ref={statusRef} tabIndex={-1} data-subagent-status="" className={cn('flex min-w-0 items-center gap-1.5 rounded-sm', FOCUS_FROM_CODE_CLASS_NAME, AGENT_STATUS_TONE[agent.status])}>
        <StateMark state={AGENT_STATUS_MARK[agent.status]} />
        <span>{t(AGENT_STATUS_LABEL[agent.status])}</span>
        {agent.status === 'finished' && (agent.finishedAtIso
          ? <LocalTime iso={agent.finishedAtIso} className="text-xs text-muted-foreground" />
          : agent.finishedAt && <RecordedTime iso={agent.finishedAtIso} words={agent.finishedAt} className="text-xs text-muted-foreground" />)}
      </p>
      {agent.canMarkFinished && <Button variant="outline" size="sm" className="shrink-0" onClick={() => setConfirming(true)}>{t('Mark finished')}</Button>}
      <MarkFinishedDialog agent={agent} open={confirming} onOpenChange={setConfirming} onMarked={() => statusRef.current?.focus()} />
    </div>
  )
}

/**
 * What a subagent was launched to do (Agent.launchDescription): its first line, on its row and its card, cut to one
 * line with its whole text in a tooltip on hover, focus and tap (rule 5, G10). Older workers send none, and a launch
 * may record none: such a subagent shows its state only.
 */
function SubagentTask({ agent }: { agent: WorkAgent }) {
  if (!agent.launchDescription) return null
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <p data-subagent-task="" className="min-w-0 truncate rounded-sm text-sm font-normal text-foreground/90">{agent.launchDescription}</p>
      </TooltipTrigger>
      <TooltipContent className="max-w-sm">{agent.launchDescription}</TooltipContent>
    </Tooltip>
  )
}

/** Subagents fold under their parent (c-ai-agent M), each with its task, state, Mark finished and its requests; 50 at a time. */
function SubagentsFold({ subagents, onOpen }: { subagents: AgentEntry['subagents']; onOpen: (request: Request) => void }) {
  const paged = usePagedRows(subagents.length, false)
  return (
    <Collapsible open={paged.open} onOpenChange={paged.setOpen} data-subagents="">
      <CollapsibleFoldTrigger count={<span className="mono-number">{subagents.length}</span>}>{t('Subagents')}</CollapsibleFoldTrigger>
      <CollapsibleContent className="pt-1">
        <ul id={paged.listId} className="ml-3 divide-y divide-border/70 border-l border-control-edge/55">
          {subagents.slice(0, paged.shown).map(({ agent, requests }) => (
            <li key={agent.id} data-list-row="" tabIndex={-1} data-subagent-row={agent.status ?? ''} data-subagent-id={agent.id} className={cn('rounded-sm py-1', FOCUS_FROM_CODE_CLASS_NAME)}>
              {agent.launchDescription && <div className="min-w-0 px-2.5 pt-1"><SubagentTask agent={agent} /></div>}
              <SubagentStatus agent={agent} />
              {requests.map((request) => <RequestRow key={request.id} request={request} onOpen={onOpen} showAgent={false} titleOnItsOwnLine />)}
            </li>
          ))}
        </ul>
        <ShowMoreRows left={paged.left} onShowMore={paged.showMore} />
      </CollapsibleContent>
    </Collapsible>
  )
}

/**
 * One agent: its mark, name and what it works in, wrapping instead of cut (two agents of one tool tell apart by it,
 * §13.2), how many requests it holds here, its requests as rows 50 at a time, each with its whole title on a line of
 * its own (HEAD's cards wrapped it; beside the status it was cut on nearly every row, 110–238px wide from 768 to
 * 1440px, measured on the owner's data and in sample mode, 2026-11-17), and its subagents folded under it. A
 * subagent whose parent is not recorded is a card of its own, labelled "Subagent", with its task first and its state.
 * Where another card would read the same (several sessions in one folder), a main agent's header adds the start of its
 * session, which the mapper sends only then (Agent.sessionShortId); a subagent's carries its task, which tells it apart.
 */
function AgentCard({ entry, onOpen }: { entry: AgentEntry; onOpen: (request: Request) => void }) {
  const { agent, requests, subagents, total } = entry
  const device = deviceById(agent.deviceId)
  const subagent = isSubagent(agent)
  const where = [deviceName(device, t), device.syncedMinutesAgo !== 0 ? interpolate(t('synced {minutes} min ago'), { minutes: device.syncedMinutesAgo }) : device.id === THIS_COMPUTER.id ? null : t('this machine')]
  const detail = subagent ? (agent.launchDescription ? <SubagentTask agent={agent} /> : undefined)
    : agent.sessionShortId ? <p className="text-xs text-muted-foreground mono-number">{interpolate(t('Session {id}'), { id: agent.sessionShortId })}</p> : undefined
  return (
    <Agent data-agent-card={agent.id} className="min-w-0">
      <AgentHeader name={agent.name} icon={<AgentMark tool={agent.tool} className="size-5" />}
        tag={subagent ? <Badge variant="outline" className="font-normal text-muted-foreground">{t('Subagent')}</Badge> : undefined}
        detail={detail}
        role={agentOwnRoleWords(agent, t)}
        model={where.filter(Boolean).join(' · ')}
        count={interpolate(total === 1 ? t('{count} request') : t('{count} requests'), { count: total })} />
      <AgentContent className="space-y-2 px-2 pb-2">
        {subagent && <SubagentStatus agent={agent} />}
        {total === 0 && <p className="px-2.5 pb-1 text-sm text-muted-foreground">{t('Nothing on it in this view.')}</p>}
        {requests.length > 0 && <RequestGroups requests={requests} grouped={false} renderRow={(request) => <RequestRow request={request} onOpen={onOpen} showAgent={false} titleOnItsOwnLine />} />}
        {subagents.length > 0 && <SubagentsFold subagents={subagents} onOpen={onOpen} />}
      </AgentContent>
    </Agent>
  )
}

/**
 * A fold for what By agent keeps out of the way (c-work-by-agent-view, page-02, G4): one dashed line that says what it
 * holds and "Show them"; opened, the things below it. Nothing folds by itself.
 */
function DashedFold({ id, label, children }: { id: string; label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  return (
    <Collapsible open={open} onOpenChange={setOpen} data-agent-fold={id}>
      <CollapsibleFoldTrigger className="border-dashed" count={open ? t('Hide them') : t('Show them')}>{label}</CollapsibleFoldTrigger>
      <CollapsibleContent className="pt-3">{children}</CollapsibleContent>
    </Collapsible>
  )
}

/** Agents with nothing in this view, opened: their cards, 50 at a time (G4); "Show 50 more" puts focus on the first new card. */
function IdleAgentCards({ entries, onOpen }: { entries: AgentEntry[]; onOpen: (request: Request) => void }) {
  const paged = usePagedRows(entries.length, true)
  return (
    <div className="space-y-2">
      <div id={paged.listId} className="min-w-0 gap-4 md:columns-2 xl:columns-3">
        {entries.slice(0, paged.shown).map((entry) => (
          <div key={entry.agent.id} data-list-row="" tabIndex={-1} className={cn('mb-4 break-inside-avoid rounded-xl', FOCUS_FROM_CODE_CLASS_NAME)}>
            <AgentCard entry={entry} onOpen={onOpen} />
          </div>
        ))}
      </div>
      <ShowMoreRows left={paged.left} onShowMore={paged.showMore} />
    </div>
  )
}

/**
 * One card per agent with work in this view: its mark, role and machine, so two agents of one tool are told apart (§4,
 * §13.2), busiest first (live/agent-board.ts). Then the requests no agent is recorded for, and the agents with nothing
 * here, each folded to one dashed line with "Show them" (c-work-by-agent-view: one 18,066px card held 188 requests, and
 * 42 of the first 60 cards were empty). The board's Sort is not shown here, so nothing here follows it: requests are
 * attention first, in state groups while the filter shows every request. Cards do not glide to a new place: with the
 * change ticker and the newest change's riffle, that would be a third moving thing (rule 8).
 */
function ByAgentView({ requests, grouped, onOpen }: { requests: Request[]; grouped: boolean; onOpen: (request: Request) => void }) {
  const { agents } = useWorkModel()
  const headingId = useId()
  const board = agentBoard(agents, sortRequests(requests, 'attention'))
  return (
    <Req ids={['R4.3', 'R13.2', 'R13.4']}>
      <div className="space-y-4">
        {board.withWork.length > 0 && (
          <section aria-labelledby={headingId} className="space-y-3">
            <h3 id={headingId} className="section-label flex items-center gap-1.5">{t('Agents with work')}<span aria-hidden="true">·</span><span className="mono-number">{board.withWork.length}</span></h3>
            {/* Masonry columns, so a short card never leaves a gap under a long one. */}
            <div className="min-w-0 gap-4 md:columns-2 xl:columns-3">
              {board.withWork.map((entry) => (
                <div key={entry.agent.id} className="mb-4 break-inside-avoid">
                  <AgentCard entry={entry} onOpen={onOpen} />
                </div>
              ))}
            </div>
          </section>
        )}
        {board.unrecorded.length > 0 && (
          <DashedFold id="no-agent" label={interpolate(board.unrecorded.length === 1 ? t('{count} request has no agent recorded') : t('{count} requests have no agent recorded'), { count: board.unrecorded.length })}>
            <RequestGroups requests={board.unrecorded} grouped={grouped} renderRow={(request) => <RequestLine request={request} onOpen={onOpen} />} />
          </DashedFold>
        )}
        {board.idle.length > 0 && (
          <DashedFold id="idle-agents" label={interpolate(board.idleAgents === 1 ? t('{count} agent has nothing in this view') : t('{count} agents have nothing in this view'), { count: board.idleAgents })}>
            <IdleAgentCards entries={board.idle} onOpen={onOpen} />
          </DashedFold>
        )}
      </div>
    </Req>
  )
}

/**
 * How many columns the Team board has from 768px (md:grid-cols-3): the review found one person using one of the three
 * (c-work-team-board), so the others are dashed places for teammates.
 */
const TEAM_COLUMNS = 3

/**
 * TeamBrain on the same GUI: one column per person, with collisions called out (§9). Each column follows G4: what needs
 * you and what is working as rows with their next step, Idle and Shipped folded to one line each, 50 rows at a time.
 * Each row shows its whole title on a line of its own and prints its agent's tool name beside the mark, as HEAD's Team
 * cards did (rule 2: nothing removed; a column is 202px wide at 768px, too narrow to share the title's line).
 * With only you on the board, one line says so, what the layout is for and how a teammate joins (the words of
 * docs/public/usage/teambrain.mdx), and the board's other columns are dashed places for teammates (c-work-team-board).
 */
function TeamBoard({ requests, grouped, onOpen }: { requests: Request[]; grouped: boolean; onOpen: (request: Request) => void }) {
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
        {people.length === 1 && (
          <div data-team-note="" className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-control-edge/55 bg-card/60 px-4 py-2.5 text-sm">
            <UsersIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
            <p className="min-w-0 flex-1">{t('You are the only person here. Each person gets a column, and team owners can invite people from the cloud workspace.')}</p>
            <Button asChild variant="outline" size="sm"><a href={TEAMBRAIN_START_URL} target="_blank" rel="noreferrer">{t('Start team plan')}<ExternalLinkIcon aria-hidden="true" /></a></Button>
          </div>
        )}
        <div className="grid items-start gap-4 md:grid-cols-3">
          {people.map((person) => {
            const asked = requests.filter((request) => request.askedBy === person)
            return (
              <section key={person} aria-label={person} data-team-column={person} className="min-w-0 space-y-2 rounded-xl border bg-card/60 p-2 shadow-panel">
                <div className="flex flex-wrap items-center gap-2 px-2 pt-1">
                  <h3 className="section-label">{person}</h3>
                  <span className="text-xs text-muted-foreground mono-number">{asked.length}</span>
                  <NeedsYouPill count={asked.filter(needsYou).length} />
                </div>
                {asked.length > 0
                  ? <RequestGroups requests={asked} grouped={grouped} heading="h4" renderRow={(request) => <RequestRow request={request} onOpen={onOpen} showAgentName titleOnItsOwnLine />} />
                  : <p className="px-2 pb-2 text-sm text-muted-foreground">{t('Nothing here')}</p>}
              </section>
            )
          })}
          {Array.from({ length: Math.max(0, TEAM_COLUMNS - people.length) }, (_, place) => (
            <div key={place} data-team-place="" className="hidden min-h-40 items-start gap-2 rounded-xl border border-dashed border-control-edge p-4 text-sm text-muted-foreground md:flex">
              <PlusIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />{t('When a teammate joins, their requests show here.')}
            </div>
          ))}
        </div>
      </div>
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
        {/* Sort orders the List, the Cards and each Team column (c-work-team-board F consistency); By agent orders by agent. */}
        {view !== 'agents' && (
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
  const { sourceKind, requests: allRequests, requestReadErrors: allReadErrors, unlinkedWorkCount, sourceHealth, buildStory, lastRuns, refresh, focusAreas, otherAsks } = useWorkModel()
  const area = focusAreaId && focusAreaId !== OTHER_FOCUS_AREA_ID ? focusAreas.find((entry) => entry.id === focusAreaId) ?? null : null
  const requests = useMemo(() => {
    if (!focusAreaId) return allRequests
    const resolveArea = createFocusAreaResolver(focusAreas)
    return allRequests.filter((request) => resolveArea(request.focusAreaId) === focusAreaId)
  }, [allRequests, focusAreas, focusAreaId])
  // A request that could not be read has no placement to file it under, so its card shows only under every request.
  const requestReadErrors = focusAreaId ? [] : allReadErrors
  // This page's saves: a failure made on another area's page, a dialog or a drawer is never offered here (Q-M1).
  const focusChanges = useFocusChanges(focusAreaId === null ? 'home' : `focus:${focusAreaId}`)
  const sample = sourceKind === 'sample'
  // How the person likes to see My Work is saved across visits (store/create-store.ts).
  const { listView: view, filter, sort } = useStore(useShallow((state) => ({ listView: state.view.listView, filter: state.view.filter, sort: state.view.sort })))
  const focusArtwork = useStore((state) => state.view.focusArtwork)
  const homeAnchorRequest = useStore((state) => state.view.homeAnchorRequest)
  const { setListView: setView, setFilter, setSort, goToHome } = useStore.getState()
  const [storyOpen, setStoryOpen] = useState(false)
  // Where focus goes once the last unreadable request is dismissed: the board's heading (components/request-read-errors.tsx).
  const boardHeading = useRef<HTMLHeadingElement | null>(null)
  const focusBoardHeading = useCallback(() => boardHeading.current?.focus(), [])
  const matches = FILTERS.find((entry) => entry.value === filter)!.matches
  const visible = useMemo(() => sortRequests(requests.filter(matches), sort), [requests, matches, sort])
  // Attention-first with every request, the board groups by state (G4); sorted another way or filtered, it is one list.
  // By agent shows no Sort, so it groups whenever the filter shows every request (ByAgentView orders attention first).
  const grouped = sort === 'attention' && filter === 'all'
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
      {area ? <FocusHeader key={area.id} area={area} requests={requests} changes={focusChanges} onOpen={onOpen} />
        : focusAreaId === OTHER_FOCUS_AREA_ID && <OtherHeader requests={requests} onOpen={onOpen} />}
      {/* `/#all-requests`: the rail's and the bottom bar's My Work land here (page-02 deep-linking). It is the view's
          heading where the request drawer puts focus when the row that opened it is gone (request-drawer.tsx). */}
      {!focusAreaId && <h2 ref={boardHeading} id={'all-requests' satisfies HomeAnchor} tabIndex={-1} data-view-heading="" className={cn('section-label rounded-sm', FOCUS_FROM_CODE_CLASS_NAME)}>{t('All requests')}</h2>}
      {/* page-03's order: the header, then what needs you as the main card with its reply card, then the asks nobody
          has started, then the board. The header's Keep, on a suggested area, is then the screen's one orange (G1). */}
      {focusAreaId && <FocusMainCard requests={open} primary={!(area && asksToKeepOrDismiss(area))} onOpen={onOpen} onReply={onReply} onShowAll={() => showOnBoard('needs-you')} />}
      {focusAreaId && <NotStartedAsks asks={area ? area.asks : focusAreaId === OTHER_FOCUS_AREA_ID ? otherAsks : []} />}
      {/* It counts the working requests this page's Working filter counts: the page's own (isWorkingNow). */}
      <ChangeTicker requests={requests} onOpen={(requestId) => { const request = allRequests.find((entry) => entry.id === requestId); if (request) onOpen(request) }} />

      <WorkToolbar view={view} filter={filter} sort={sort} requests={requests} team={team} refreshLine={refreshLine} refreshFailed={!sample && refreshLineState(refresh) === 'failed'}
        onView={setView} onFilter={setFilter} onSort={setSort} />
      {/* Requests that could not be read, once, at the top of the board in every layout (only under every request). */}
      <RequestReadErrors readErrors={requestReadErrors} onAllDismissed={focusBoardHeading} />

      {requests.length === 0 && requestReadErrors.length === 0 ? (
        <Req ids={['R12.1']}>
          {/* An empty area is a compact box around its one next step (D b10 M211, F209: it was 1171×233px for two lines
              and no button): All requests, where a request's own page moves it here. */}
          <Empty className={cn('border bg-card/60', focusAreaId && 'mx-auto w-full max-w-md')}>
            <EmptyHeader>
              <EmptyMedia variant="icon"><InboxIcon /></EmptyMedia>
              <EmptyTitle>{focusAreaId ? t("No requests in this area yet.") : t("No requests recorded yet.")}</EmptyTitle>
              <EmptyDescription>{focusAreaId ? t("A refresh places new requests here, or move one here from its page.") : t("Ask an agent for something and it appears here.")}</EmptyDescription>
            </EmptyHeader>
            {focusAreaId && <EmptyContent><Button variant="outline" onClick={() => goToHome('all-requests')}>{t('Find a request to move here')}<ArrowRightIcon aria-hidden="true" /></Button></EmptyContent>}
          </Empty>
        </Req>
      ) : (
        // Every paged list starts on its first page again when the filter, sort or area changes (usePagedRows).
        <PagingResetContext.Provider value={JSON.stringify([filter, sort, focusAreaId])}>
          <div data-board-view={view} className="space-y-4">
            {/* Nothing matches: said under the read-error card too (it was left blank there), and By agent still folds
                its agents with their count (G4: folded, never gone). */}
            {visible.length === 0 && (
              <Req ids={['R12.1']}>
                <Empty className="border bg-card/60">
                  <EmptyHeader>
                    <EmptyMedia variant="icon"><InboxIcon /></EmptyMedia>
                    <EmptyTitle>{t("Nothing here")}</EmptyTitle>
                    <EmptyDescription>{t("No requests match. New work shows up as soon as an agent writes it.")}</EmptyDescription>
                  </EmptyHeader>
                </Empty>
              </Req>
            )}
            {view === 'agents' ? <ByAgentView requests={visible} grouped={filter === 'all'} onOpen={onOpen} />
              : visible.length === 0 ? null
                : view === 'cards' ? <CardsView requests={visible} grouped={grouped} focusPage={!!focusAreaId} lead={focusAreaId ? firstNeedingYou(open)[0]?.id ?? null : null} onOpen={onOpen} onReply={onReply} onOpenFocus={onOpenFocus} />
                  : view === 'list' ? <ListView requests={visible} grouped={grouped} sort={sort} onSort={setSort} onOpen={onOpen} onOpenFocus={onOpenFocus} />
                    : <TeamBoard requests={visible} grouped={grouped} onOpen={onOpen} />}
          </div>
        </PagingResetContext.Provider>
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
