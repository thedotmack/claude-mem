import { useId, useMemo, useState } from 'react'
import { ArrowRightIcon, ChevronDownIcon, ChevronRightIcon } from 'lucide-react'
import { Button, buttonVariants } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleFoldTrigger, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Skeleton } from '@/components/ui/skeleton'
import { useI18n, interpolate } from '@/lib/i18n'
import { formatPromptDay } from '@/lib/prompt-time'
import { displayTime } from '@/lib/display-time'
import { placeLinkPress, usePageHref } from '@/lib/place-link'
import { cn } from '@/lib/utils'
import { useStore } from '@/store'
import { needsYou, type FocusArea, type Request } from '@/data'
import { focusOverview, needsOwnerFirst, type FocusOverviewRow } from '@/live/focus-overview'
import { nextStepShown } from '@/live/to-work-model'
import { nextStepWords } from '@/live/next-step-words'
import { FocusArtwork } from './focus-artwork'
import type { FocusArtwork as ArtworkDensity } from '@/store/store-types'

/**
 * Kept areas shown before "Show all <n> focus areas": two rows of two compact rows at desktop, so the board stays one
 * block between what needs you and every request (content-priority, page-01).
 */
export const FOCUS_OVERVIEW_FIRST_AREAS = 4
/** Requests named in an area's folded work before the rest are counted; the area page lists them all (progressive-disclosure). */
export const FOCUS_OVERVIEW_REQUESTS_NAMED = 3

/**
 * Pictures loaded at once instead of as they scroll near: the board's first row, two areas a row once the board itself
 * is 900px wide (the container query in focus-overview.css), which is on the first screen; every other picture loads
 * lazily (FocusArtwork `priority`).
 */
const EAGER_ARTWORKS = 2

/** While the areas are still being found: the shape of two compact rows, not a lone block (D b18 M 373). */
function BoardSkeleton() {
  return (
    <div className="focus-area-grid artwork-compact">
      {Array.from({ length: 2 }, (_, index) => (
        <div key={index} className="flex items-center gap-3 rounded-xl border border-border p-2">
          <Skeleton className="size-14 shrink-0 rounded-lg" />
          <div className="min-w-0 flex-1 space-y-2"><Skeleton className="h-4 w-1/2" /><Skeleton className="h-3 w-3/4" /></div>
        </div>
      ))}
    </div>
  )
}

/**
 * One area (c-focus-overview, c-focus-artwork). The whole card opens the area: its name is the one button, stretched
 * over the card (one Tab stop; it was 27 equal "Open focus area" buttons). Compact and Off are one 72px row with the
 * counts at the right ("1 needs you" first, so it reads before the picture's caption); Full keeps the picture, filling
 * its box, its caption under it as normal small text, the next step and "Work & evidence", the shared fold row (G5)
 * that shows the area's work in place. An area that needs you has a brighter edge. In setup, with no area page to
 * open, the name folds the area's work open instead.
 */
function AreaCard({ row, index, artwork, incomplete, workLoading, onOpenArea, onOpenRequest }: {
  row: FocusOverviewRow; index: number; artwork: ArtworkDensity; incomplete: boolean; workLoading: boolean
  onOpenArea?: (id: string) => void; onOpenRequest?: (request: Request) => void
}) {
  const { t } = useI18n()
  const id = useId()
  const [open, setOpen] = useState(false)
  const { area, requests: work, needsYou: waiting, working: moving } = row
  const active = work.filter((request) => !request.closed)
  const next = active.find(needsYou) ?? active.find((request) => request.state === 'working')
  // A missing step is left out (decision G3): the mapper's value or an older worker's filler.
  const nextStep = next ? nextStepShown(next.next) : null
  const full = artwork === 'full'
  const name = (
    <Button variant="bare" className="focus-area-target focus-visible:border-transparent focus-visible:ring-0"
      aria-label={interpolate(onOpenArea ? t('Open {name} focus area') : t('Explore {name} focus area'), { name: area.name })}
      aria-describedby={`${id}-goal ${id}-signals`} onClick={onOpenArea ? () => onOpenArea(area.id) : undefined}>
      {area.name}
    </Button>
  )
  return (
    <article className={cn('focus-area-card', waiting > 0 && 'needs-owner')}>
      {artwork !== 'off' && <FocusArtwork area={area} priority={index < EAGER_ARTWORKS} />}
      <Collapsible open={open} onOpenChange={setOpen} asChild>
        <div className="focus-area-body">
          {full && <p className="focus-area-eyebrow">{String(index + 1).padStart(2, '0')} · {area.status === 'suggested' ? t('Suggested focus') : t('Focus area')}</p>}
          <h3>{onOpenArea ? name : <CollapsibleTrigger asChild>{name}</CollapsibleTrigger>}</h3>
          <p id={`${id}-goal`} className="focus-area-goal">{area.goal ?? area.about ?? t('A recurring thread in your work.')}</p>
          <div id={`${id}-signals`} className="focus-area-signals">
            {waiting > 0 && <span className="focus-signal-attention">{interpolate(waiting === 1 ? t('{count} needs you') : t('{count} need you'), { count: waiting })}</span>}
            {moving > 0 && <span className="focus-signal-working">{interpolate(t('{count} working'), { count: moving })}</span>}
            {/* Requests already linked to this area count even while others are still being connected or could not be read. */}
            {workLoading && active.length === 0 ? <span>{t('Connecting work…')}</span> : <span>{interpolate(active.length === 1 ? t('{count} request') : t('{count} requests'), { count: active.length })}</span>}
            {incomplete && <span>{t('Some work could not be read')}</span>}
          </div>
          {full && nextStep?.kind === 'step' && (
            <p className="focus-area-next">
              {onOpenRequest ? <Button variant="bare" className="focus-area-above" onClick={() => onOpenRequest(next!)}>{nextStepWords(nextStep, t)}<ArrowRightIcon aria-hidden="true" /></Button> : nextStepWords(nextStep, t)}
            </p>
          )}
          {full && onOpenArea && (
            <div className="focus-area-actions focus-area-above">
              <CollapsibleFoldTrigger className="text-xs">{t('Work & evidence')}</CollapsibleFoldTrigger>
            </div>
          )}
          <CollapsibleContent className="focus-area-evidence focus-area-above">
            {area.quotes[0] && <blockquote>“{area.quotes[0].quote}”<cite>{displayTime(formatPromptDay(area.quotes[0].at))}</cite></blockquote>}
            {!area.quotes.length && area.evidence && <p>{area.evidence}</p>}
            {area.timesAsked !== null && <p>{interpolate(t('Mentioned {count} times in the reviewed prompts'), { count: area.timesAsked })}</p>}
            {active.length > 0 ? (
              <ul>{active.slice(0, FOCUS_OVERVIEW_REQUESTS_NAMED).map((request) => (
                <li key={request.id}>{onOpenRequest
                  ? <Button variant="bare" onClick={() => onOpenRequest(request)}>{request.title ?? t('New request')}<ArrowRightIcon aria-hidden="true" /></Button>
                  : request.title ?? t('New request')}</li>
              ))}</ul>
            ) : <p>{incomplete ? t('Some requests could not be read. The work shown may be incomplete.') : workLoading ? t('Work is still being connected to this area.') : t('No linked requests yet. Focus areas can appear before their work is sorted.')}</p>}
            {area.asks.length > 0 && <p>{interpolate(area.asks.length === 1 ? t('{count} recorded ask · not linked to a request yet') : t('{count} recorded asks · not linked to requests yet'), { count: area.asks.length })}</p>}
          </CollapsibleContent>
        </div>
      </Collapsible>
      {onOpenArea && <ChevronRightIcon aria-hidden="true" className="focus-area-chevron" />}
    </article>
  )
}

/**
 * Past focus, the areas marked done: a quiet link on the board's header until the design pass gives Focus areas its
 * tabs (Phase 7 makes Past focus one of them and deletes this link). Without it nothing in the app led there.
 */
function PastFocusLink() {
  const { t } = useI18n()
  const href = usePageHref('past-focus')
  return (
    <a href={href} onClick={placeLinkPress(() => useStore.getState().goToPage('past-focus'))} className={cn(buttonVariants({ variant: 'link', size: 'sm' }), 'px-0')}>
      {t('Past focus')}<ArrowRightIcon aria-hidden="true" />
    </a>
  )
}

/**
 * My Work's saved areas on the home page board. Reading this view never starts inference. Finding an area by its words
 * is Find work's (the bar, Cmd K), and the artwork choice is Workspace's (design pass Phase 4).
 */
export function FocusOverview({ areas, requests, loading = false, workLoading = false, incomplete = false, emptyMessage, discovering = false, onOpenArea, onOpenRequest, artwork = 'full', anchorId, expandAllOn = 0 }: {
  areas: readonly FocusArea[]; requests: readonly Request[]; loading?: boolean; discovering?: boolean
  workLoading?: boolean; incomplete?: boolean; emptyMessage?: string
  onOpenArea?: (id: string) => void; onOpenRequest?: (request: Request) => void
  /** Display density only, chosen on Workspace (store view.focusArtwork). The setup screen has no store, so it shows full artwork. */
  artwork?: ArtworkDensity
  /** The board's place on the page (My Work: `focus-areas`, where the bar's Focus areas scrolls). */
  anchorId?: string
  /** Each new value shows every area (each press of the bar's Focus areas); 0 leaves the choice to the person. */
  expandAllOn?: number
}) {
  const { t } = useI18n()
  const id = useId()
  const [showSuggestions, setShowSuggestions] = useState(false)
  const [showAll, setShowAll] = useState(expandAllOn > 0)
  // A later press of the bar's Focus areas (while it opens this board) opens it again after the person folded it back:
  // it promises every area. Set while rendering: React's way to follow a prop without an extra paint.
  const [expandedFor, setExpandedFor] = useState(expandAllOn)
  if (expandAllOn !== expandedFor) {
    setExpandedFor(expandAllOn)
    if (expandAllOn > 0) setShowAll(true)
  }
  const overview = useMemo(() => focusOverview(areas, requests), [areas, requests])
  // Areas that need the owner come first, each part in the saved order (live/focus-overview.ts needsOwnerFirst).
  const ordered = useMemo(() => needsOwnerFirst(overview.areas), [overview.areas])
  // Suggestions stay visible after setup. Opening one reaches its existing Keep / Dismiss controls.
  const kept = showAll ? ordered : ordered.slice(0, FOCUS_OVERVIEW_FIRST_AREAS)
  const visible = overview.areas.length && !showSuggestions ? kept : [...kept, ...overview.suggested]
  const otherCount = overview.other.filter((request) => !request.closed).length
  const sortingCount = overview.sorting.filter((request) => !request.closed).length
  return (
    <section id={anchorId} className="focus-overview" aria-labelledby={`${id}-heading`} aria-busy={loading}>
      <header className="focus-overview-heading">
        <div><p className="section-label">{discovering ? t('Found in your conversations') : t('The bigger picture')}</p>
          <h2 id={`${id}-heading`}>{t('Your focus areas')}</h2>
          <p>{discovering ? t('The things you keep coming back to, with the work behind them.') : t('What you’re working toward, across your agents and conversations.')}</p>
        </div>
        {onOpenArea && <div className="focus-overview-controls"><PastFocusLink /></div>}
      </header>
      {loading && visible.length === 0 ? (
        <div className="focus-area-loading" role="status"><p>{t('Finding the threads in your work…')}</p><BoardSkeleton /></div>
      ) : visible.length === 0 ? (
        <div className="focus-area-empty">
          <p>{emptyMessage ?? (discovering ? t('No focus areas found in this scan. You can continue setup and review your work later.') : t('No focus areas yet. Keep working and check back after a refresh.'))}</p>
        </div>
      ) : (
        <div className={`focus-area-grid artwork-${artwork}`}>
          {visible.map((row, index) => <AreaCard key={row.area.id} row={row} index={index} artwork={artwork} incomplete={incomplete} workLoading={workLoading} onOpenArea={onOpenArea} onOpenRequest={onOpenRequest} />)}
        </div>
      )}
      <div className="focus-overview-footer">
        {overview.areas.length > FOCUS_OVERVIEW_FIRST_AREAS && <Button variant="link" size="sm" className="px-0" aria-expanded={showAll} onClick={() => setShowAll(!showAll)}>{showAll ? t('Show priority areas') : interpolate(t('Show all {count} focus areas'), { count: overview.areas.length })}<ChevronDownIcon aria-hidden="true" className={cn(showAll && 'rotate-180')} /></Button>}
        {overview.areas.length > 0 && overview.suggested.length > 0 && <Button variant="link" size="sm" className="px-0" aria-expanded={showSuggestions} onClick={() => setShowSuggestions(!showSuggestions)}>{interpolate(showSuggestions ? t('Hide {count} suggested areas') : t('Explore {count} suggested areas'), { count: overview.suggested.length })}<ChevronDownIcon aria-hidden="true" className={cn(showSuggestions && 'rotate-180')} /></Button>}
        {otherCount > 0 && onOpenArea && <Button variant="link" size="sm" className="px-0" onClick={() => onOpenArea('other')}>{interpolate(t('{count} in Other'), { count: otherCount })}<ArrowRightIcon aria-hidden="true" /></Button>}
        {sortingCount > 0 && <span>{interpolate(t('{count} still being sorted'), { count: sortingCount })}</span>}
      </div>
    </section>
  )
}
