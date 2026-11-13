import { useId, useMemo, useState } from 'react'
import { ArrowRightIcon, ChevronDownIcon } from 'lucide-react'
import { useI18n, interpolate } from '@/lib/i18n'
import { formatPromptDay } from '@/lib/prompt-time'
import type { FocusArea, Request } from '@/data'
import { focusOverview } from '@/live/focus-overview'
import { FocusIcon } from './focus-icon'

/** The same saved areas in setup and My Work. Reading this view never starts inference. */
export function FocusOverview({ areas, requests, shows, loading = false, workLoading = false, incomplete = false, emptyMessage, discovering = false, onOpenArea, onOpenRequest }: {
  areas: readonly FocusArea[]; requests: readonly Request[]; loading?: boolean; discovering?: boolean
  workLoading?: boolean; incomplete?: boolean; emptyMessage?: string
  /** The page's filter: which requests the cards count and list. Without one, everything that is not closed. */
  shows?: (request: Request) => boolean
  onOpenArea?: (id: string) => void; onOpenRequest?: (request: Request) => void
}) {
  const { t } = useI18n()
  const id = useId()
  const [expanded, setExpanded] = useState<string | null>(null)
  const [showSuggestions, setShowSuggestions] = useState(false)
  const [showAll, setShowAll] = useState(false)
  const [query, setQuery] = useState('')
  const overview = useMemo(() => focusOverview(areas, requests, shows), [areas, requests, shows])
  // Suggestions stay visible after setup. Opening one reaches its existing Keep / Dismiss controls.
  const searching = query.trim().length > 0
  const matches = ({ area }: (typeof overview.areas)[number]) => `${area.name} ${area.goal ?? ''} ${area.about ?? ''}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())
  const kept = searching ? overview.areas.filter(matches) : showAll ? overview.areas : overview.areas.slice(0, 4)
  const suggested = searching ? overview.suggested.filter(matches) : overview.suggested
  const visible = overview.areas.length && !showSuggestions && !searching ? kept : [...kept, ...suggested]
  const otherCount = overview.other.length
  const sortingCount = overview.sorting.length
  return (
    <section className="focus-overview" aria-labelledby={`${id}-heading`} aria-busy={loading}>
      <header className="focus-overview-heading">
        <div><p className="section-label">{t(discovering ? 'Found in your conversations' : 'The bigger picture')}</p>
          <h2 id={`${id}-heading`}>{t('Your focus areas')}</h2>
          <p>{t(discovering ? 'The things you keep coming back to, with the work behind them.' : 'What you’re working toward, across your agents and conversations.')}</p>
        </div>
      </header>
      {overview.areas.length + overview.suggested.length > 8 && <label className="focus-area-search"><span className="sr-only">{t('Find a focus area')}</span><input type="search" placeholder={t('Find a focus area…')} value={query} onChange={(event) => setQuery(event.target.value)} /></label>}
      {loading && visible.length === 0 ? <div className="focus-area-loading" role="status"><p>{t('Finding the threads in your work…')}</p><div aria-hidden="true" className="focus-area-skeleton" /></div>
        : visible.length === 0 ? <p className="focus-area-empty">{searching ? t('No focus areas match your search.') : emptyMessage ?? t(discovering ? 'No focus areas found in this scan. You can continue setup and review your work later.' : 'No focus areas yet. Keep working and check back after a refresh.')}</p>
          : <div className="focus-area-grid">{visible.map(({ area, shown: active, next, iconSrc, needsYou: waiting, working: moving }, index) => {
            const open = expanded === area.id
            return <article key={area.id} className="focus-area-card">
              <div className="focus-area-body">
                {/* The focus's own icon when it has one. With none there is no picture and the name starts the card. */}
                <div className="focus-area-title">
                  {iconSrc && <FocusIcon area={area} className="focus-area-icon" />}
                  <div>
                    <p className="focus-area-eyebrow">{String(index + 1).padStart(2, '0')} · {t(area.status === 'suggested' ? 'Suggested focus' : 'Focus area')}</p>
                    <h3>{area.name}</h3>
                  </div>
                </div>
                <p className="focus-area-goal">{area.goal ?? area.about ?? t('A recurring thread in your work.')}</p>
                <div className="focus-area-signals">
                  {waiting > 0 && <span className="focus-signal-attention">{interpolate(t(waiting === 1 ? '{count} needs you' : '{count} need you'), { count: waiting })}</span>}
                  {moving > 0 && <span className="focus-signal-working">{interpolate(t('{count} working'), { count: moving })}</span>}
                  {/* Requests already linked to this area count even while others are still being connected or could not be read. */}
                  {workLoading && active.length === 0 ? <span>{t('Connecting work…')}</span> : <span>{interpolate(t(active.length === 1 ? '{count} request' : '{count} requests'), { count: active.length })}</span>}
                  {incomplete && <span>{t('Some work could not be read')}</span>}
                </div>
                {next && <p className="focus-area-next">{onOpenRequest ? <button type="button" onClick={() => onOpenRequest(next)}>{next.next.text}<ArrowRightIcon aria-hidden="true" /></button> : next.next.text}</p>}
                <div className="focus-area-actions"><button type="button" className="focus-area-open" aria-expanded={onOpenArea ? undefined : open} aria-controls={onOpenArea ? undefined : `${id}-${area.id}`} aria-label={interpolate(t(onOpenArea ? 'Open {name} focus area' : 'Explore {name} focus area'), { name: area.name })} onClick={() => onOpenArea ? onOpenArea(area.id) : setExpanded(open ? null : area.id)}>{t(onOpenArea ? 'Open focus area' : 'Explore this focus')}<ArrowRightIcon aria-hidden="true" /></button>
                <button type="button" className="focus-area-evidence-toggle" aria-expanded={open} aria-controls={`${id}-${area.id}`} onClick={() => setExpanded(open ? null : area.id)}>{t('Work & evidence')}<ChevronDownIcon aria-hidden="true" /></button>
                </div>
                {open && <div id={`${id}-${area.id}`} className="focus-area-evidence">
                  {area.quotes[0] && <blockquote>“{area.quotes[0].quote}”<cite>{formatPromptDay(area.quotes[0].at)}</cite></blockquote>}
                  {!area.quotes.length && area.evidence && <p>{area.evidence}</p>}
                  {area.timesAsked !== null && <p>{interpolate(t('Mentioned {count} times in the reviewed prompts'), { count: area.timesAsked })}</p>}
                  {active.length > 0 ? <ul>{active.slice(0, 3).map((request) => <li key={request.id}>{onOpenRequest ? <button type="button" onClick={() => onOpenRequest(request)}>{request.title ?? t('New request')}<ArrowRightIcon aria-hidden="true" /></button> : request.title ?? t('New request')}</li>)}</ul> : <p>{t(incomplete ? 'Some requests could not be read. The work shown may be incomplete.' : workLoading ? 'Work is still being connected to this area.' : 'No linked requests yet. Focus areas can appear before their work is sorted.')}</p>}
                  {area.asks.length > 0 && <p>{interpolate(t(area.asks.length === 1 ? '{count} recorded ask · not linked to a request yet' : '{count} recorded asks · not linked to requests yet'), { count: area.asks.length })}</p>}
                </div>}
              </div>
            </article>
          })}</div>}
      <div className="focus-overview-footer">
        {!searching && overview.areas.length > 4 && <button type="button" aria-expanded={showAll} onClick={() => setShowAll(!showAll)}>{showAll ? t('Show priority areas') : interpolate(t('Show all {count} focus areas'), { count: overview.areas.length })}<ChevronDownIcon aria-hidden="true" /></button>}
        {overview.areas.length > 0 && overview.suggested.length > 0 && <button type="button" aria-expanded={showSuggestions} onClick={() => setShowSuggestions(!showSuggestions)}>{interpolate(t(showSuggestions ? 'Hide {count} suggested areas' : 'Explore {count} suggested areas'), { count: overview.suggested.length })}<ChevronDownIcon aria-hidden="true" /></button>}
        {otherCount > 0 && onOpenArea && <button type="button" onClick={() => onOpenArea('other')}>{interpolate(t('{count} in Other'), { count: otherCount })}<ArrowRightIcon aria-hidden="true" /></button>}
        {sortingCount > 0 && <span>{interpolate(t('{count} still being sorted'), { count: sortingCount })}</span>}
      </div>
    </section>
  )
}
