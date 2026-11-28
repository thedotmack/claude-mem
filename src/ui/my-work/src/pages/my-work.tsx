import { displayRecordedDate, recordedTimeWords } from '@/lib/display-time'
import { t, useI18n, interpolate } from '@/lib/i18n'
import { useCallback, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { ArrowRightIcon, ArrowUpDownIcon, ImageIcon, InboxIcon, PlugIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleFoldTrigger } from '@/components/ui/collapsible'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { SourceReadAlert } from '@/components/bits'
import { sentenceWith } from '@/lib/sentence-with'
import { TracingBeam } from '@/components/aceternity/tracing-beam'
import { FocusChangeBar, useFocusChanges } from '@/components/focus-changes'
import { FocusHeader, NotStartedAsks, OtherHeader } from '@/components/focus-header'
import { FocusMainCard, ReplyActions } from '@/components/focus-main-card'
import { ChangeTicker } from '@/components/live-motion'
import { RequestCard } from '@/components/request-card'
import { RequestLine } from '@/components/request-line'
import { cn } from '@/lib/utils'
import { Req } from '@/spec/req'
import { firstNeedingYou, isWorkingNow, needsYou, OTHER_FOCUS_AREA_ID, type Request } from '@/data'
import { type WorkFilter, type WorkListView, type WorkSort, useStore, useWorkModel, useWorkspace } from '@/store'
import { useShallow } from 'zustand/react/shallow'
import type { BuildStory, StoryChapter } from '@/live/work-data-source'
import { asksToKeepOrDismiss, createFocusAreaResolver } from '@/live/to-focus-model'
import { CARD_SIZE, cardGridEntries, lineSections, requestSections, type CardSize } from '@/live/card-groups'
import { datedHeading, fitLine, storyChapters, storyNumbers } from '@/live/build-story'
import { FocusOverview } from '@/components/focus-overview'
import '@/components/focus-overview.css'
import { RequestGroup, ShowMoreRows } from '@/components/request-rows'
import { RequestReadErrors } from '@/components/request-read-errors'
import { FOCUS_FROM_CODE_CLASS_NAME, PagingResetContext, usePagedRows } from '@/lib/paged-rows'
import { ByAgentView, ListView, SORTS, TeamBoard, sortRequests } from '@/pages/requests'

type View = WorkListView
const VIEWS: { value: View; label: string }[] = [
  { value: 'cards', label: 'Cards' },
  { value: 'list', label: 'List' },
  { value: 'agents', label: 'By agent' },
  { value: 'team', label: 'Team' },
]
type Filter = WorkFilter
type SortKey = WorkSort
// The old board's filter chips (WorkToolbar), until design pass Phase 6 takes the board from Home (Requests has its
// status tabs and its closed choice instead). Closed requests (every item dropped) show only under Closed, and that
// filter appears only when there are some (or it is selected).
// Each dot is still (rule 8: a pulsing Working dot here and in two other places put too many moving things on home).
const FILTERS: { value: Filter; label: string; matches: (request: Request) => boolean; dot?: string }[] = [
  { value: 'all', label: 'All', matches: (request) => !request.closed },
  { value: 'needs-you', label: 'Needs you', matches: (request) => !request.closed && needsYou(request), dot: 'bg-attention-foreground' },
  { value: 'working', label: 'Working', matches: isWorkingNow, dot: 'bg-working-foreground' },
  { value: 'shipped', label: 'Shipped', matches: (request) => !request.closed && request.state === 'shipped', dot: 'bg-shipped-foreground' },
  { value: 'closed', label: 'Closed', matches: (request) => !!request.closed },
]

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
 * The row above the requests (c-work-filters): the view as one joined control and the filters as chips, each with a
 * small visible label; Sort with its word and its choice. Chosen items show the primitive's chosen look (fill, edge,
 * weight, check; no orange) and counts are monospace. On a phone it is two 44px rows: the view, then the filter chips
 * (they scroll sideways inside their row) with Sort. It wraps instead of widening the page at any width (the page
 * measured 807–824px at a 768–820px window). The refresh line that ended it is gone (design pass Phase 4): the review's
 * state is on Machine and sync, with one failure line under the page's title.
 */
function WorkToolbar({ view, filter, sort, requests, team, onView, onFilter, onSort }: {
  view: View; filter: Filter; sort: SortKey; requests: Request[]; team: boolean
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
  const { requests: allRequests, requestReadErrors: allReadErrors, sourceHealth, buildStory, focusAreas, otherAsks } = useWorkModel()
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
  // How the person likes to see My Work is saved across visits (store/create-store.ts).
  const { listView: view, filter, sort } = useStore(useShallow((state) => ({ listView: state.view.listView, filter: state.view.filter, sort: state.view.sort })))
  const focusArtwork = useStore((state) => state.view.focusArtwork)
  // Focus areas opens this page at its focus area board with every area shown, until it has a page of its own. Each
  // press of it is a new scroll ask, so each one opens the whole board again, after the person folded it.
  const allAreasAsked = useStore((state) => state.view.section === 'focus' ? state.view.scrollAsk?.sequence ?? 1 : 0)
  const { setListView: setView, setFilter, setSort, goToPage, showRequests } = useStore.getState()
  const [storyOpen, setStoryOpen] = useState(false)
  // Where focus goes once the last unreadable request is dismissed: the board's heading (components/request-read-errors.tsx).
  const boardHeading = useRef<HTMLHeadingElement | null>(null)
  const focusBoardHeading = useCallback(() => boardHeading.current?.focus(), [])
  const matches = FILTERS.find((entry) => entry.value === filter)!.matches
  const visible = useMemo(() => sortRequests(requests.filter(matches), sort), [requests, matches, sort])
  // Attention-first with every request, the board groups by state (G4); sorted another way or filtered, it is one list.
  const grouped = sort === 'attention' && filter === 'all'
  const open = requests.filter((request) => !request.closed)

  return (
    <div className="space-y-4 md:space-y-5">
      {!sourceHealth.connected && <SourceReadAlert error={sourceHealth.error} />}
      <FocusChangeBar changes={focusChanges} />
      {!focusAreaId && <NeedsYouFirst requests={open} onOpen={onOpen} onReply={onReply} onOpenFocus={onOpenFocus} onShowWorking={() => showRequests({ status: 'working' })} />}
      {/* `?view=focus` (the bar's Focus areas) opens this page here, with every area shown. */}
      {!focusAreaId && <FocusOverview anchorId="focus-areas" expandAllOn={allAreasAsked} areas={focusAreas} requests={allRequests} incomplete={allReadErrors.length > 0} onOpenArea={onOpenFocus} onOpenRequest={onOpen} artwork={focusArtwork} />}
      {/* Every request in the area, closed ones too: the combined progress counts each reviewed request (D1's rule). */}
      {area ? <FocusHeader key={area.id} area={area} requests={requests} changes={focusChanges} onOpen={onOpen} />
        : focusAreaId === OTHER_FOCUS_AREA_ID && <OtherHeader requests={requests} onOpen={onOpen} />}
      {/* The old board's heading, until Home loses the board (design pass Phase 6; every request is on Requests now). It
          is the view's heading where the request drawer puts focus when the row that opened it is gone (request-drawer.tsx). */}
      {!focusAreaId && <h2 ref={boardHeading} id="all-requests" tabIndex={-1} data-view-heading="" className={cn('section-label rounded-sm', FOCUS_FROM_CODE_CLASS_NAME)}>{t('All requests')}</h2>}
      {/* page-03's order: the header, then what needs you as the main card with its reply card, then the asks nobody
          has started, then the board. The header's Keep, on a suggested area, is then the screen's one orange (G1). */}
      {focusAreaId && <FocusMainCard requests={open} primary={!(area && asksToKeepOrDismiss(area))} onOpen={onOpen} onReply={onReply} onShowAll={() => setFilter('needs-you')} />}
      {focusAreaId && <NotStartedAsks asks={area ? area.asks : focusAreaId === OTHER_FOCUS_AREA_ID ? otherAsks : []} />}
      {/* It counts the working requests this page's Working filter counts: the page's own (isWorkingNow). */}
      <ChangeTicker requests={requests} onOpen={(requestId) => { const request = allRequests.find((entry) => entry.id === requestId); if (request) onOpen(request) }} />

      <WorkToolbar view={view} filter={filter} sort={sort} requests={requests} team={team} onView={setView} onFilter={setFilter} onSort={setSort} />
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
            {focusAreaId && <EmptyContent><Button variant="outline" onClick={() => goToPage('requests')}>{t('Find a request to move here')}<ArrowRightIcon aria-hidden="true" /></Button></EmptyContent>}
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
            {view === 'agents' ? <ByAgentView requests={visible} onOpen={onOpen} />
              : visible.length === 0 ? null
                : view === 'cards' ? <CardsView requests={visible} grouped={grouped} focusPage={!!focusAreaId} lead={focusAreaId ? firstNeedingYou(open)[0]?.id ?? null : null} onOpen={onOpen} onReply={onReply} onOpenFocus={onOpenFocus} />
                  : view === 'list' ? <ListView requests={visible} grouped={grouped} sort={sort} onSort={setSort} onOpen={onOpen} onOpenFocus={onOpenFocus} />
                    : <TeamBoard requests={visible} grouped={grouped} onOpen={onOpen} />}
          </div>
        </PagingResetContext.Provider>
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
