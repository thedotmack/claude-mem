// My Work's home page (design pass Phase 6; Codex D01 and D03, Claude D02 and D03): it answers "what needs me" from
// recorded state only. The line under the title says how many requests are marked as waiting on the owner (the review
// records it, Phase 1). The lead card shows the first of them or, when none waits, the working request reviewed most
// recently (live/home-lead.ts); beside it, the others that wait and the other working requests, a few of each, with the
// way to all of them on Requests. Then the first three focus areas in the owner's order, and quiet links to every
// request and to the build story. Every request lives on Requests (pages/requests.tsx), every area on Focus areas
// (pages/focus-areas.tsx); nothing on this page saves.
import { useId, useMemo, useState, type ReactNode } from 'react'
import { ArrowRightIcon, ArrowUpRightIcon, ChevronRightIcon, HistoryIcon, InboxIcon, ListChecksIcon } from 'lucide-react'
import { Button, buttonVariants } from '@/components/ui/button'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { RecordedTime, SourceReadAlert, StateMark, type Translate } from '@/components/bits'
import { StorySheet } from '@/components/build-story-sheet'
import { focusArtworkFor } from '@/components/focus-artwork'
import { focusViewHeading } from '@/components/app-shell'
import { RequestListRow } from '@/components/request-rows'
import { RequestReadErrors } from '@/components/request-read-errors'
import { todayWords } from '@/lib/display-time'
import { interpolate, useI18n } from '@/lib/i18n'
import { placeLinkPress, useFocusHref, usePageHref, useRequestHref, useRequestsHref } from '@/lib/place-link'
import { sentenceWith } from '@/lib/sentence-with'
import { cn } from '@/lib/utils'
import { Req } from '@/spec/req'
import { hasOwnTitle, requestTitle, type Request } from '@/data'
import type { CardGroupId } from '@/live/card-groups'
import { focusOverview, type FocusOverviewRow } from '@/live/focus-overview'
import { HOME_LEAD_KINDS, homeWork, type HomeLeadKind } from '@/live/home-lead'
import { nextStepShown } from '@/live/to-work-model'
import { nextStepWords } from '@/live/next-step-words'
import { focusAreaPlaceWords, resolveFocusAreaId } from '@/live/to-focus-model'
import { useStore, useWorkModel } from '@/store'

/**
 * Rows each list beside the lead card names before its "See all" link, which opens the rest on Requests: three, as
 * the home page's "Moving now" named three titles before counting the rest (page-01, progressive-disclosure). Codex's
 * home mockup names every other working request there, two of its three; the owner's other 37 waiting requests
 * (Nov 28), at 80px a row (measured at 1440), would make that column about 2,960px tall. The rest are one link away,
 * counted on the phone's link and on the Requests tab it opens.
 */
const ROWS_BESIDE_LEAD = 3

/** Focus areas the home page shows, in the owner's order, before "See all": the first three (Codex D03, plan Phase 6). */
const HOME_FOCUS_AREAS = 3

/** Of those, the ones shown two across between 768 and 1024px: the first two, as Codex's narrow layout drops the third. */
const HOME_FOCUS_AREAS_NARROW = 2

/** The lead card's label: why its request leads, and the area it sits in when a review placed it. */
const LEAD_LABEL: Record<HomeLeadKind, (t: Translate, area: string | null) => string> = {
  waiting: (t, area) => area === null ? t('Waiting on you') : interpolate(t('Waiting on you in {area}'), { area }),
  working: (t, area) => area === null ? t('Working') : interpolate(t('Working in {area}'), { area }),
}

/**
 * Each list beside the lead card: its heading, its "See all" link (the Requests tab that holds every one of them), the
 * same link counting what that tab holds once the list names fewer rows than it has (`seeAllCounted`: past
 * ROWS_BESIDE_LEAD, so always four or more), and the one link that stands for the list on a phone, with how many it
 * holds besides the lead card (`more`: the lead card is one of the same kind, so these are more of them).
 */
const BESIDE_LEAD: Record<HomeLeadKind, {
  tab: CardGroupId; heading: (t: Translate) => string; seeAll: (t: Translate) => string; seeAllCounted: (t: Translate, count: number) => string
  phoneLink: (t: Translate, count: number, more: boolean) => string
}> = {
  waiting: {
    tab: 'needs-you',
    heading: (t) => t('Also waiting on you'),
    seeAll: (t) => t('See all requests waiting on you'),
    seeAllCounted: (t, count) => interpolate(t('See all {count} requests waiting on you'), { count }),
    phoneLink: (t, count) => interpolate(t('{count} more waiting on you'), { count }),
  },
  working: {
    tab: 'working',
    heading: (t) => t('Also working'),
    seeAll: (t) => t('See all working requests'),
    seeAllCounted: (t, count) => interpolate(t('See all {count} working requests'), { count }),
    phoneLink: (t, count, more) => interpolate(more
      ? t(count === 1 ? '{count} more working request' : '{count} more working requests')
      : t(count === 1 ? '{count} working request' : '{count} working requests'), { count }),
  },
}

/** A quiet link's look (Codex's `.textbtn`) over the app's link button, an icon before or after its words. */
const QUIET_LINK_CLASS_NAME = 'h-auto gap-1.5 px-1 text-sm md:not-pointer-coarse:min-h-9'

/** A quiet link to another place. */
function QuietLink({ href, onPress, children, className }: { href: string; onPress: () => void; children: ReactNode; className?: string }) {
  return <a href={href} onClick={placeLinkPress(onPress)} className={cn(buttonVariants({ variant: 'link', size: 'sm' }), QUIET_LINK_CLASS_NAME, className)}>{children}</a>
}

/** Today's date at the right of the home page's title (Codex's `.eyedate`), in the reader's language. */
export function HomeDate() {
  useI18n()
  const today = todayWords()
  return <time dateTime={today.iso} data-home-date="" className="shrink-0 font-terminal text-xs text-muted-foreground md:text-caption">{today.short}</time>
}

/** The line under the title: how many requests are marked as waiting on the owner, from recorded state only. */
function waitingWords(t: Translate, count: number): string {
  if (count === 0) return t('No request is marked as waiting on you.')
  return interpolate(t(count === 1 ? '{count} request is waiting on you.' : '{count} requests are waiting on you.'), { count })
}

/** "79% · Latest review at 5:48 am" on the working lead card, with its bar, or that no review has measured it. */
function ReviewedProgress({ request }: { request: Request }) {
  const { t } = useI18n()
  const { percent, reviewedAt, reviewedAtIso } = request.progress
  if (percent === null) return <span className="text-sm text-goal-foreground max-md:text-caption">{t('Not reviewed yet')}</span>
  return (
    <span data-lead-progress="" className="flex items-center gap-2 text-sm text-goal-foreground tabular max-md:text-caption">
      <span aria-hidden="true" className="inline-block h-1.25 w-9 overflow-hidden rounded-full bg-goal-foreground/27 md:w-14">
        <span className="block h-full rounded-full bg-working-foreground" style={{ width: `${percent}%` }} />
      </span>
      <span>{sentenceWith(interpolate(t('{percent}% · Latest review at {time}'), { percent }), 'time', <RecordedTime iso={reviewedAtIso} words={reviewedAt} />)}</span>
    </span>
  )
}

/**
 * The request that deserves a look (Codex D01, `.leadcard`): why it leads and its area, its plain name, the recorded
 * sentence (what the owner has to do, or what the working request is), then "Open request", the page's one primary
 * button, a link to the request's address that opens it over the page. A working lead says how far its latest review
 * put it and when.
 */
function LeadCard({ kind, request }: { kind: HomeLeadKind; request: Request }) {
  const { t } = useI18n()
  const { focusAreas } = useWorkModel()
  const openRequestDrawer = useStore((state) => state.openRequestDrawer)
  const hrefOf = useRequestHref()
  const area = resolveFocusAreaId(request.focusAreaId, focusAreas) === null ? null : focusAreaPlaceWords(request.focusAreaId, focusAreas, t)
  const next = nextStepShown(request.next)
  // Waiting: the owner's move as the review recorded it; working: what the request is.
  const sentence = kind === 'waiting' ? (next.kind === 'step' ? nextStepWords(next, t) : request.summary) : request.summary
  const named = hasOwnTitle(request)
  const headingId = useId()
  return (
    <Req ids={['R12.2', 'R1.1']}>
      <section data-lead-card={kind} aria-labelledby={headingId}
        className="flex flex-col justify-between rounded-xl border border-goal-border bg-goal px-4.5 py-4.5 text-goal-heading md:min-h-61.5 md:rounded-2xl md:px-8 md:py-6.5">
        <div>
          <p className="flex items-center gap-2.5 text-sm font-medium text-goal-foreground">
            <StateMark state={request.state} />
            {LEAD_LABEL[kind](t, area)}
          </p>
          <h2 id={headingId} className={cn('mt-2.5 mb-2 max-w-lead-title text-lead-title-phone [overflow-wrap:anywhere] md:mt-3 md:mb-2.5 md:text-lead-title', !named && 'text-goal-foreground')}>{requestTitle(request, t)}</h2>
          {sentence && <p data-lead-sentence="" className="max-w-lead-text text-goal-foreground">{sentence}</p>}
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-x-4.5 gap-y-2.5 md:mt-5.5">
          <Button asChild>
            <a href={hrefOf(request.id)} data-request-opener={request.id} onClick={placeLinkPress(() => openRequestDrawer(request))}>{t('Open request')}<ArrowRightIcon aria-hidden="true" /></a>
          </Button>
          {kind === 'working' && <ReviewedProgress request={request} />}
        </div>
      </section>
    </Req>
  )
}

/**
 * One list beside the lead card (Codex's `.also`): from 768px its heading, its first rows as Requests' rows without
 * their state (the heading names it), and "See all", which counts what it opens once the rows named are fewer than the
 * list holds (plan rule 3: a cap that is hit says so); on a phone one link that says how many it holds and opens them on
 * Requests (Codex's phone mockup), the heading then for screen readers only. The heading names the section.
 */
function BesideLead({ kind, requests, more }: { kind: HomeLeadKind; requests: Request[]; more: boolean }) {
  const { t } = useI18n()
  const openRequestDrawer = useStore((state) => state.openRequestDrawer)
  const hrefOf = useRequestHref()
  const headingId = useId()
  const words = BESIDE_LEAD[kind]
  const tabHref = useRequestsHref({ status: words.tab })
  const showTab = () => useStore.getState().showRequests({ status: words.tab })
  // The tab holds every request of this kind: these, and the lead card's when it is one of them.
  const onTab = requests.length + (more ? 1 : 0)
  return (
    <section data-beside-lead={kind} aria-labelledby={headingId}>
      <h2 id={headingId} className="text-aside-title max-md:sr-only md:mb-2">{words.heading(t)}</h2>
      <div className="hidden md:block">
        <ul className="divide-y divide-input">
          {requests.slice(0, ROWS_BESIDE_LEAD).map((request) => (
            <li key={request.id}><RequestListRow request={request} href={hrefOf(request.id)} onOpen={openRequestDrawer} showState={false} /></li>
          ))}
        </ul>
        <QuietLink href={tabHref} onPress={showTab} className="mt-2">
          {requests.length > ROWS_BESIDE_LEAD ? words.seeAllCounted(t, onTab) : words.seeAll(t)}<ArrowRightIcon aria-hidden="true" />
        </QuietLink>
      </div>
      <QuietLink href={tabHref} onPress={showTab} className="md:hidden">{words.phoneLink(t, requests.length, more)}<ChevronRightIcon aria-hidden="true" /></QuietLink>
    </section>
  )
}

/**
 * One of the owner's first focus areas (Codex's `.feature-card`): a link to the area's page with its picture (unless
 * the person turned the artwork off on Workspace), its name, its goal and how many open requests it holds. On a phone
 * a row: a small picture, the name and the count.
 */
function FocusAreaCard({ row, artwork, className }: { row: FocusOverviewRow; artwork: boolean; className?: string }) {
  const { t } = useI18n()
  const href = useFocusHref(row.area.id)
  const open = row.requests.filter((request) => !request.closed).length
  return (
    <a href={href} data-home-area={row.area.id} onClick={placeLinkPress(() => useStore.getState().goToFocus(row.area.id))}
      className={cn('relative flex items-center gap-3 overflow-hidden rounded-xl border border-border bg-card px-3.25 py-2.75 shadow-panel outline-none transition-colors hover:border-control-edge focus-visible:ring-3 focus-visible:ring-ring/50 md:flex-col md:items-stretch md:gap-0 md:rounded-2xl md:p-0', className)}>
      {artwork && (
        <span aria-hidden="true" className="block h-14.5 w-16 shrink-0 overflow-hidden rounded-md bg-muted md:h-22 md:w-auto md:rounded-none">
          <img src={focusArtworkFor(row.area)} alt="" width={1000} height={667} loading="lazy" decoding="async" className="size-full object-cover" onError={(event) => { event.currentTarget.hidden = true }} />
        </span>
      )}
      <span className="block min-w-0 flex-1 pr-5 md:grid md:gap-1.75 md:px-5 md:pt-4.25 md:pb-3.75">
        <span className="block text-card-title-phone [overflow-wrap:anywhere] md:text-card-title">{row.area.name}</span>
        {row.area.goal && <span className="hidden text-muted-foreground md:block">{row.area.goal}</span>}
        <span className="mt-1 flex items-center justify-between text-caption text-muted-foreground md:mt-1.25">
          <span className="tabular">{interpolate(t(open === 1 ? '{count} request' : '{count} requests'), { count: open })}</span>
          <ArrowUpRightIcon aria-hidden="true" className="size-4.25 text-accent-foreground max-md:absolute max-md:top-1/2 max-md:right-3.25 max-md:-translate-y-1/2 dark:text-primary" />
        </span>
      </span>
    </a>
  )
}

/**
 * "Your focus areas" (Codex D03): the first three kept areas in the owner's order (live/focus-overview.ts, the order the
 * Focus areas page keeps), three across from 1024px and two between 768 and 1024px (the third waits on Focus areas
 * there, as Codex's narrow layout drops it), and "See all {count}" to Focus areas whenever a card is left out: past the
 * first three at every width, and the third between 768 and 1024px (plan rule 3).
 */
function YourFocusAreas() {
  const { t } = useI18n()
  const { focusAreas, requests } = useWorkModel()
  const artwork = useStore((state) => state.view.focusArtwork) !== 'off'
  const overview = useMemo(() => focusOverview(focusAreas, requests), [focusAreas, requests])
  const focusHref = usePageHref('focus')
  if (overview.areas.length === 0) return null
  return (
    <section data-home-areas="" aria-labelledby="home-focus-areas" className="space-y-3.75 pt-3.5">
      <div className="flex items-center justify-between gap-4">
        <h2 id="home-focus-areas" className="text-section-title-phone md:text-section-title">{t('Your focus areas')}</h2>
        {overview.areas.length > HOME_FOCUS_AREAS_NARROW && (
          <QuietLink href={focusHref} onPress={() => useStore.getState().goToPage('focus')}
            className={cn('shrink-0', overview.areas.length <= HOME_FOCUS_AREAS && 'hidden md:max-lg:inline-flex')}>
            {interpolate(t('See all {count}'), { count: overview.areas.length })}<ArrowRightIcon aria-hidden="true" />
          </QuietLink>
        )}
      </div>
      <div className="grid gap-2.25 md:grid-cols-2 md:gap-3 lg:grid-cols-3 lg:gap-4">
        {overview.areas.slice(0, HOME_FOCUS_AREAS).map((row, index) => (
          <FocusAreaCard key={row.area.id} row={row} artwork={artwork} className={index >= HOME_FOCUS_AREAS_NARROW ? 'md:max-lg:hidden' : undefined} />
        ))}
      </div>
    </section>
  )
}

/**
 * My Work's home page. When the worker answered but could not read the saved work, that comes first, with Try again,
 * and with nothing read at all nothing is said under it (as on Requests); requests that could not be read are named
 * once under the first line, which may then be missing them.
 */
export function MyWork() {
  const { t } = useI18n()
  const { requests, requestReadErrors, sourceHealth, buildStory } = useWorkModel()
  const { waiting, working, lead } = useMemo(() => homeWork(requests), [requests])
  const [storyOpen, setStoryOpen] = useState(false)
  const allHref = usePageHref('requests')
  const { goToPage } = useStore.getState()
  // Beside the lead card, the others of each kind, waiting first (HOME_LEAD_KINDS' order).
  const others: Record<HomeLeadKind, Request[]> = { waiting: waiting.filter((request) => request !== lead?.request), working: working.filter((request) => request !== lead?.request) }
  const beside = HOME_LEAD_KINDS.filter((kind) => others[kind].length > 0)
  const open = requests.filter((request) => !request.closed).length
  const noneRecorded = requests.length === 0 && requestReadErrors.length === 0
  return (
    <div className="space-y-4 md:space-y-5">
      {!sourceHealth.connected && <SourceReadAlert error={sourceHealth.error} />}
      {(sourceHealth.connected || !noneRecorded) && (
        <Req ids={['R12.3']}>
          <p data-home-first-line="" className="text-base text-muted-foreground md:text-lg">{waitingWords(t, waiting.length)}</p>
        </Req>
      )}
      {/* Requests that could not be read, once, before what the page leads with. */}
      <RequestReadErrors readErrors={requestReadErrors} onAllDismissed={() => focusViewHeading()} />
      {lead && (
        <div className={cn('grid items-start gap-3', beside.length > 0 && 'md:grid-cols-home-narrow md:gap-5.25 lg:grid-cols-home lg:gap-8')}>
          <LeadCard kind={lead.kind} request={lead.request} />
          {beside.length > 0 && (
            <div className="space-y-1 md:space-y-6 md:px-0.75 md:pt-2.5">
              {beside.map((kind) => <BesideLead key={kind} kind={kind} requests={others[kind]} more={lead.kind === kind} />)}
            </div>
          )}
        </div>
      )}
      {noneRecorded && sourceHealth.connected && (
        <Req ids={['R12.1']}>
          <Empty className="border bg-card/60">
            <EmptyHeader>
              <EmptyMedia variant="icon"><InboxIcon /></EmptyMedia>
              <EmptyTitle>{t('No requests recorded yet.')}</EmptyTitle>
              <EmptyDescription>{t('Ask an agent for something and it appears here.')}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        </Req>
      )}
      <YourFocusAreas />
      {(open > 0 || buildStory) && (
        <nav aria-label={t('More of your work')} className="flex flex-wrap items-center gap-x-6 gap-y-2 mt-4.5 border-t border-border pt-1.75 md:mt-6.5">
          {open > 0 && (
            <QuietLink href={allHref} onPress={() => goToPage('requests')}>
              <ListChecksIcon aria-hidden="true" />{open === 1 ? t('All requests') : interpolate(t('All {count} requests'), { count: open })}
            </QuietLink>
          )}
          {/* The build story's sheet, until the story has a page of its own (design pass Phase 7). */}
          {buildStory && <Button variant="link" size="sm" className={QUIET_LINK_CLASS_NAME} onClick={() => setStoryOpen(true)}><HistoryIcon aria-hidden="true" />{t('Build story')}</Button>}
        </nav>
      )}
      {buildStory && <StorySheet open={storyOpen} story={buildStory} requests={requests} onClose={() => setStoryOpen(false)} onOpenRules={() => { setStoryOpen(false); goToPage('rules') }} />}
    </div>
  )
}
