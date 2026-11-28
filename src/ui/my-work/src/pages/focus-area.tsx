// A focus area's page (`?focus=<id>`, and Other's): its header, what needs you as the main card with its reply card, the
// asks nobody has started, the change ticker, then the old board of its requests (Cards, List, By agent, Team) and the
// build story's recap. Split out of the home page as it was (design pass Phase 6); Phase 8 redesigns it into sub focus
// cards, and with that takes the board, the ticker and the recap from it.
import { recordedTimeWords, displayRecordedDate } from '@/lib/display-time'
import { t, useI18n, interpolate } from '@/lib/i18n'
import { useMemo, useState, type ReactNode } from 'react'
import { ArrowRightIcon, ArrowUpDownIcon, ImageIcon, InboxIcon, PlugIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { SourceReadAlert } from '@/components/bits'
import { StoryNumbers, StorySheet } from '@/components/build-story-sheet'
import { sentenceWith } from '@/lib/sentence-with'
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
import { CARD_SIZE, cardGridEntries, requestSections, type CardSize } from '@/live/card-groups'
import { datedHeading, fitLine, storyChapters } from '@/live/build-story'
import '@/components/focus-overview.css'
import { RequestGroup, ShowMoreRows } from '@/components/request-rows'
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
// The area board's filter chips (WorkToolbar), until design pass Phase 8 takes the board from the area's page (Requests
// has its status tabs and its closed choice instead). Closed requests (every item dropped) show only under Closed, and
// that filter appears only when there are some (or it is selected).
// Each dot is still (rule 8: a pulsing Working dot here and in two other places put too many moving things on a page).
const FILTERS: { value: Filter; label: string; matches: (request: Request) => boolean; dot?: string }[] = [
  { value: 'all', label: 'All', matches: (request) => !request.closed },
  { value: 'needs-you', label: 'Needs you', matches: (request) => !request.closed && needsYou(request), dot: 'bg-attention-foreground' },
  { value: 'working', label: 'Working', matches: isWorkingNow, dot: 'bg-working-foreground' },
  { value: 'shipped', label: 'Shipped', matches: (request) => !request.closed && request.state === 'shipped', dot: 'bg-shipped-foreground' },
  { value: 'closed', label: 'Closed', matches: (request) => !!request.closed },
]

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
 * still "just updated" mark (request-card.tsx). A state flip moved up to 6 things a frame for 0.58 s here: every card's
 * glide to its new place, each new or re-placed card's fade-in and the section headings' glide. The ticker's slide to
 * the new change (components/live-motion.tsx) is what moves.
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
 * The Cards view (c-work-cards-view), page-03 and page-04's order. Attention-first with every request: the page's main
 * card above the board already leads with the first request that needs you (`lead`, components/focus-main-card.tsx),
 * so the board leaves it out; any others that need you stay full cards, and Working, Idle and Shipped are one-line
 * rows under their headings, Idle and Shipped folded (G4). Sorted another way or filtered, the requests keep that
 * order, each drawn at its state's size, 50 at a time through the boards' one paging (lib/paged-rows.ts): a new
 * filter, sort or area starts on the first page, and "Show 50 more" puts focus on the first card it added. Cards in a
 * row share its height, each footer on its card's bottom edge (D b5 M116; they ended at heights up to 345px apart in
 * one row on the owner's data at 768, 2026-11-17).
 */
function CardsView({ requests, grouped, lead, onOpen, onReply, onOpenFocus }: {
  requests: Request[]; grouped: boolean; lead: string | null
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
  // Only the full cards stay in the grid; Working joins the sections drawn as rows.
  const cardEntries = cardGridEntries(onBoard.filter((request) => CARD_SIZE[request.state] === 'full'))
  const rowSections = requestSections(onBoard).filter(({ group }) => group.size !== 'full')
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
 * state is on Machine and sync, with one failure line in the area's header.
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
 * A focus area's page (or Other's): its header comes first and only the requests in it show (requests not sorted yet
 * show only on Requests). `onReply` opens a request's drawer with its reply box focused (G2); without it, Reply opens
 * the drawer.
 */
export function FocusAreaPage({ focusAreaId, onOpen, onReply = onOpen, onOpenFocus, onOpenRules }: { focusAreaId: string; onOpen: (request: Request) => void; onReply?: (request: Request) => void; onOpenFocus: (focusAreaId: string) => void; onOpenRules: () => void }) {
  useI18n()
  const { team } = useWorkspace()
  const { requests: allRequests, sourceHealth, buildStory, focusAreas, otherAsks } = useWorkModel()
  const area = focusAreaId !== OTHER_FOCUS_AREA_ID ? focusAreas.find((entry) => entry.id === focusAreaId) ?? null : null
  const requests = useMemo(() => {
    const resolveArea = createFocusAreaResolver(focusAreas)
    return allRequests.filter((request) => resolveArea(request.focusAreaId) === focusAreaId)
  }, [allRequests, focusAreas, focusAreaId])
  // This page's saves: a failure made on another area's page, a dialog or a drawer is never offered here (Q-M1).
  const focusChanges = useFocusChanges(`focus:${focusAreaId}`)
  // How the person likes to see My Work is saved across visits (store/create-store.ts).
  const { listView: view, filter, sort } = useStore(useShallow((state) => ({ listView: state.view.listView, filter: state.view.filter, sort: state.view.sort })))
  const { setListView: setView, setFilter, setSort, goToPage } = useStore.getState()
  const [storyOpen, setStoryOpen] = useState(false)
  const matches = FILTERS.find((entry) => entry.value === filter)!.matches
  const visible = useMemo(() => sortRequests(requests.filter(matches), sort), [requests, matches, sort])
  // Attention-first with every request, the board groups by state (G4); sorted another way or filtered, it is one list.
  const grouped = sort === 'attention' && filter === 'all'
  const open = requests.filter((request) => !request.closed)

  return (
    <div className="space-y-4 md:space-y-5">
      {!sourceHealth.connected && <SourceReadAlert error={sourceHealth.error} />}
      <FocusChangeBar changes={focusChanges} />
      {/* Every request in the area, closed ones too: the combined progress counts each reviewed request (D1's rule). */}
      {area ? <FocusHeader key={area.id} area={area} requests={requests} changes={focusChanges} onOpen={onOpen} />
        : focusAreaId === OTHER_FOCUS_AREA_ID && <OtherHeader requests={requests} onOpen={onOpen} />}
      {/* page-03's order: the header, then what needs you as the main card with its reply card, then the asks nobody
          has started, then the board. The header's Keep, on a suggested area, is then the screen's one orange (G1). */}
      <FocusMainCard requests={open} primary={!(area && asksToKeepOrDismiss(area))} onOpen={onOpen} onReply={onReply} onShowAll={() => setFilter('needs-you')} />
      <NotStartedAsks asks={area ? area.asks : focusAreaId === OTHER_FOCUS_AREA_ID ? otherAsks : []} />
      {/* It counts the working requests this page's Working filter counts: the page's own (isWorkingNow). */}
      <ChangeTicker requests={requests} onOpen={(requestId) => { const request = allRequests.find((entry) => entry.id === requestId); if (request) onOpen(request) }} />

      <WorkToolbar view={view} filter={filter} sort={sort} requests={requests} team={team} onView={setView} onFilter={setFilter} onSort={setSort} />

      {requests.length === 0 ? (
        <Req ids={['R12.1']}>
          {/* An empty area is a compact box around its one next step (D b10 M211, F209: it was 1171×233px for two lines
              and no button): Requests, where a request's own page moves it here. */}
          <Empty className="mx-auto w-full max-w-md border bg-card/60">
            <EmptyHeader>
              <EmptyMedia variant="icon"><InboxIcon /></EmptyMedia>
              <EmptyTitle>{t("No requests in this area yet.")}</EmptyTitle>
              <EmptyDescription>{t("A refresh places new requests here, or move one here from its page.")}</EmptyDescription>
            </EmptyHeader>
            <EmptyContent><Button variant="outline" onClick={() => goToPage('requests')}>{t('Find a request to move here')}<ArrowRightIcon aria-hidden="true" /></Button></EmptyContent>
          </Empty>
        </Req>
      ) : (
        // Every paged list starts on its first page again when the filter, sort or area changes (usePagedRows).
        <PagingResetContext.Provider value={JSON.stringify([filter, sort, focusAreaId])}>
          <div data-board-view={view} className="space-y-4">
            {/* Nothing matches: said, and By agent still folds its agents with their count (G4: folded, never gone). */}
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
                : view === 'cards' ? <CardsView requests={visible} grouped={grouped} lead={firstNeedingYou(open)[0]?.id ?? null} onOpen={onOpen} onReply={onReply} onOpenFocus={onOpenFocus} />
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
