import { useId, useMemo, useState, type ReactNode } from 'react'
import { ArrowRightIcon, ChevronRightIcon } from 'lucide-react'
import { FocusArtwork } from '@/components/focus-artwork'
import { Collapsible, CollapsibleContent, CollapsibleFoldTrigger, CollapsibleTrigger } from '@/components/ui/collapsible'
import { needsYou, type Request } from '@/data'
import { formatPromptDay } from '@/lib/prompt-time'
import { displayTime } from '@/lib/display-time'
import { interpolate, useI18n } from '@/lib/i18n'
import { focusOverview, type FocusOverviewRow } from '@/live/focus-overview'
import type { RevealSets, SetupExtraction, SetupRecentPrompt, SetupScanAgent } from '../setup-data'
import { promptStamp, recordedNextStepText } from '../setup-reveal'
import { joinNames } from '../format'
import { PageHeading, SetupActions, SetupButton, ToolMark, type SetupBack } from './shared'

// The rows below repeat My Work's overview selection (components/focus-overview.tsx:24-32: first areas, show all,
// suggested, search) so setup can draw rows instead of its scaled-down board. That file belongs to another track and
// is not edited here, so its numbers are copied, each named with its source and its reason. Change both together.

/**
 * Kept areas before "Show all <n> focus areas". Source: focus-overview.tsx:28 (`overview.areas.slice(0, 4)`), so setup
 * and My Work's home open on the same areas. Reason (content-priority): at 1440×900 a row is 100px with 10px between
 * (measured 2026-11-16, sample data), and with four rows the bottom row ends at 856px of 900; a fifth would push
 * Continue off the first screen.
 */
const FOCUS_OVERVIEW_FIRST_AREAS = 4
/**
 * A search box past this many areas. Source: focus-overview.tsx:46 (`> 8`). Reason (search-accessible): eight rows take
 * 870px at 1440 (same measurement), the most that fit one 900px screen; past that, finding an area by eye takes
 * scrolling.
 */
const FOCUS_OVERVIEW_SEARCH_PAST = 8
/**
 * Requests named in an area's folded work, and in the "still being sorted" list, before "<n> more in My Work". Source:
 * focus-overview.tsx:74 (`active.slice(0, 3)`), the same three My Work's card names. Reason (progressive-disclosure):
 * the fold previews the work and counts the rest, which My Work lists in full.
 */
const FOCUS_OVERVIEW_REQUESTS_NAMED = 3

/** A few requests by title, with the rest counted (FOCUS_OVERVIEW_REQUESTS_NAMED). */
function NamedRequests({ requests, ...props }: { requests: Request[]; id?: string; 'aria-labelledby'?: string; className?: string }) {
  const { t } = useI18n()
  return (
    <ul {...props}>
      {requests.slice(0, FOCUS_OVERVIEW_REQUESTS_NAMED).map((request) => <li key={request.id}>{request.title ?? t('New request')}</li>)}
      {requests.length > FOCUS_OVERVIEW_REQUESTS_NAMED && <li className="reveal-more-count">{interpolate(t('{count} more in My Work'), { count: requests.length - FOCUS_OVERVIEW_REQUESTS_NAMED })}</li>}
    </ul>
  )
}

/** No logged-in agent yet: the prompts themselves, counted per agent and quoted as typed. The cards follow in My Work. */
function PromptsOnly({ agents, recentPrompts }: { agents: SetupScanAgent[]; recentPrompts: SetupRecentPrompt[] }) {
  const { t } = useI18n()
  return (
    <div className="reveal-sets">
      <section className="reveal-set is-landed" aria-labelledby="reveal-prompts">
        <h2 id="reveal-prompts">{t('Conversations')}</h2>
        <ol>
          {agents.map((agent) => (
            <li key={agent.id} className="reveal-card">
              <ToolMark id={agent.id} name={agent.label} />
              <div>
                <p className="title">{agent.label}</p>
                <p className="meta tabular">{interpolate(t('{count} messages'), { count: agent.prompts.toLocaleString('en-US') })}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>
      {recentPrompts.length > 0 && (
        <section className="reveal-set is-landed" aria-labelledby="reveal-latest">
          <h2 id="reveal-latest">{t('Latest')}</h2>
          <ol>
            {recentPrompts.map((prompt) => (
              <li key={`${prompt.agent}-${prompt.at}`} className="reveal-card">
                <span className="lead-icon" aria-hidden="true">“</span>
                <div>
                  <p className="quote">“{prompt.text}”</p>
                  <p className="meta">{displayTime(formatPromptDay(promptStamp(prompt.at)))}</p>
                </div>
              </li>
            ))}
          </ol>
        </section>
      )}
    </div>
  )
}

/**
 * One focus area as a row (E4): a small version of its picture, the name, one line, the counts, and its work folded.
 * "Explore this focus" stays as a quiet action under the line; in setup it opens the same work as the fold, as it did
 * on My Work's board here before (there is no area page to open during setup).
 */
function AreaRow({ row, workLoading, incomplete }: { row: FocusOverviewRow; workLoading: boolean; incomplete: boolean }) {
  const { t } = useI18n()
  const headingId = useId()
  const { area, requests: work, needsYou: waiting, working: moving } = row
  const active = work.filter((request) => !request.closed)
  const next = active.find(needsYou) ?? active.find((request) => request.state === 'working')
  const nextText = next ? recordedNextStepText(next, t) : null
  return (
    <li className="reveal-area">
      <Collapsible>
        <div className="reveal-area-row">
          <span className="reveal-thumb" aria-hidden="true"><FocusArtwork area={area} /></span>
          <div className="reveal-area-text">
            <h3 id={headingId}>{area.name}</h3>
            <p>{area.goal ?? area.about ?? t('A recurring thread in your work.')}</p>
            <CollapsibleTrigger asChild>
              <SetupButton look="text" className="reveal-explore" aria-describedby={headingId}>{t('Explore this focus')}<ArrowRightIcon aria-hidden="true" /></SetupButton>
            </CollapsibleTrigger>
          </div>
          <div className="reveal-chips">
            {area.status === 'suggested' && <span className="reveal-chip">{t('Suggested focus')}</span>}
            {waiting > 0 && <span className="reveal-chip is-attention">{interpolate(waiting === 1 ? t('{count} needs you') : t('{count} need you'), { count: waiting })}</span>}
            {moving > 0 && <span className="reveal-chip is-working">{interpolate(t('{count} working'), { count: moving })}</span>}
            {/* Requests already linked to this area count even while others are still being connected or could not be read. */}
            {workLoading && active.length === 0 ? <span className="reveal-chip">{t('Connecting work…')}</span> : <span className="reveal-chip">{interpolate(active.length === 1 ? t('{count} request') : t('{count} requests'), { count: active.length })}</span>}
            {incomplete && <span className="reveal-chip">{t('Some work could not be read')}</span>}
          </div>
          <CollapsibleFoldTrigger className="reveal-evidence-trigger" aria-describedby={headingId}>{t('Work & evidence')}</CollapsibleFoldTrigger>
        </div>
        <CollapsibleContent className="reveal-evidence">
          {area.quotes[0] && <blockquote>“{area.quotes[0].quote}”<cite>{displayTime(formatPromptDay(area.quotes[0].at))}</cite></blockquote>}
          {!area.quotes.length && area.evidence && <p>{area.evidence}</p>}
          {area.timesAsked !== null && <p>{interpolate(t('Mentioned {count} times in the reviewed prompts'), { count: area.timesAsked })}</p>}
          {nextText && <p className="reveal-next">{nextText}</p>}
          {active.length > 0 ? <NamedRequests requests={active} />
            : <p>{incomplete ? t('Some requests could not be read. The work shown may be incomplete.') : workLoading ? t('Work is still being connected to this area.') : t('No linked requests yet. Focus areas can appear before their work is sorted.')}</p>}
          {area.asks.length > 0 && <p>{interpolate(area.asks.length === 1 ? t('{count} recorded ask · not linked to a request yet') : t('{count} recorded asks · not linked to requests yet'), { count: area.asks.length })}</p>}
        </CollapsibleContent>
      </Collapsible>
    </li>
  )
}

/**
 * The same saved areas as My Work, as rows (E4). Reading them never starts inference. Built here rather than through
 * My Work's overview, so this screen can drop the scaled-down board without changing the home page.
 */
function FocusAreaRows({ reveal, loading, workLoading, incomplete, emptyMessage, more }: {
  reveal: RevealSets; loading: boolean; workLoading: boolean; incomplete: boolean; emptyMessage?: string
  /** The last link on the line under the rows ("What else came through"). */
  more?: ReactNode
}) {
  const { t } = useI18n()
  const sortingIds = useId()
  const [showAll, setShowAll] = useState(false)
  const [showSuggestions, setShowSuggestions] = useState(false)
  const [showSorting, setShowSorting] = useState(false)
  const [query, setQuery] = useState('')
  const overview = useMemo(() => focusOverview(reveal.focusAreas ?? [], reveal.requests ?? []), [reveal.focusAreas, reveal.requests])
  // Copied selection (focus-overview.tsx:26-32): kept areas first, suggested ones on request, both searched.
  const searching = query.trim().length > 0
  const matches = ({ area }: FocusOverviewRow) => `${area.name} ${area.goal ?? ''} ${area.about ?? ''}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())
  const kept = searching ? overview.areas.filter(matches) : showAll ? overview.areas : overview.areas.slice(0, FOCUS_OVERVIEW_FIRST_AREAS)
  const suggested = searching ? overview.suggested.filter(matches) : overview.suggested
  const visible = overview.areas.length && !showSuggestions && !searching ? kept : [...kept, ...suggested]
  const sorting = overview.sorting.filter((request) => !request.closed)
  return (
    <section className="reveal-areas" aria-labelledby="reveal-areas-heading" aria-busy={loading}>
      <h2 id="reveal-areas-heading">{t('Your focus areas')}{overview.areas.length > 0 && <span className="tabular"> · {overview.areas.length}</span>}</h2>
      {overview.areas.length + overview.suggested.length > FOCUS_OVERVIEW_SEARCH_PAST && (
        <label className="reveal-search"><span className="sr-only">{t('Find a focus area')}</span><input type="search" placeholder={t('Find a focus area…')} value={query} onChange={(event) => setQuery(event.target.value)} /></label>
      )}
      {loading && visible.length === 0 ? <div className="reveal-areas-empty" role="status"><p>{t('Finding the threads in your work…')}</p></div>
        : visible.length === 0 ? <p className="reveal-areas-empty">{searching ? t('No focus areas match your search.') : emptyMessage ?? t('No focus areas found in this scan. You can continue setup and review your work later.')}</p>
          : <ol className="reveal-area-list">{visible.map((row) => <AreaRow key={row.area.id} row={row} workLoading={workLoading} incomplete={incomplete} />)}</ol>}
      <div className="reveal-links">
        {!searching && overview.areas.length > FOCUS_OVERVIEW_FIRST_AREAS && <SetupButton look="text" aria-expanded={showAll} onClick={() => setShowAll(!showAll)}>{showAll ? t('Show priority areas') : interpolate(t('Show all {count} focus areas'), { count: overview.areas.length })}</SetupButton>}
        {overview.areas.length > 0 && overview.suggested.length > 0 && <SetupButton look="text" aria-expanded={showSuggestions} onClick={() => setShowSuggestions(!showSuggestions)}>{interpolate(showSuggestions ? t('Hide {count} suggested areas') : t('Explore {count} suggested areas'), { count: overview.suggested.length })}</SetupButton>}
        {/* A link like the others on this line: it opens the requests not in a focus area yet, below the line. */}
        {sorting.length > 0 && (
          <SetupButton look="text" id={`${sortingIds}-trigger`} className="reveal-sorting" aria-expanded={showSorting} aria-controls={`${sortingIds}-list`} onClick={() => setShowSorting(!showSorting)}>
            <span className="tabular">{interpolate(t('{count} still being sorted'), { count: sorting.length })}</span>
          </SetupButton>
        )}
        {more}
      </div>
      {showSorting && sorting.length > 0 && <NamedRequests id={`${sortingIds}-list`} aria-labelledby={`${sortingIds}-trigger`} className="reveal-sorting-list" requests={sorting} />}
    </section>
  )
}

/** The first payoff is the same saved focus areas as My Work. Areas and their work land independently. */
export function RevealScreen({ agents, reveal, extraction, uploadedAgents, recentPrompts, hostedNotice, skipped = false, back, onContinue, onStartTrial, busy }: {
  agents: SetupScanAgent[]; reveal: RevealSets; extraction: SetupExtraction | null; uploadedAgents: string[] | null; recentPrompts: SetupRecentPrompt[]; hostedNotice?: string | null
  /** The person skipped the scan after it stopped. */
  skipped?: boolean
  back?: SetupBack | null
  onContinue: () => void
  onStartTrial?: () => void
  busy?: boolean
}) {
  const { t, locale } = useI18n()
  // The results came only from the tools the person chose to upload.
  const withPrompts = agents.filter((agent) => agent.prompts > 0 && (!uploadedAgents || uploadedAgents.includes(agent.id)))
  const promptCount = withPrompts.reduce((sum, agent) => sum + agent.prompts, 0)
  // The person kept everything local and no earlier run left results: say that instead of promising knowledge that
  // was never built. This reads the recorded answer, because an upload can also come back with nothing to show.
  const hasResults = !!(reveal.focusAreas?.length || reveal.goals?.length || reveal.work?.length || reveal.rules?.length)
  const promptsOnly = extraction?.state === 'waiting-for-agent' && !hasResults
  const finished = extraction?.state === 'ok' || extraction?.state === 'failed'
  const keptLocal = uploadedAgents?.length === 0 && agents.some((agent) => agent.prompts > 0) && !hasResults
  const firstArea = reveal.focusAreas?.find(area => area.name.trim())?.name
  const continueRow = onStartTrial ? (
    <div className="reveal-trial">
      <p>{firstArea ? interpolate(t('Pick up {area} in another agent or on another device.'), { area: firstArea })
        : hasResults || promptCount > 0 ? t('Pick up this work in another agent or on another device.')
        : t('Pick up your next session in another agent or on another device.')}</p>
      <small>{t('$0 today. Then $12/month after 30 days. Card required.')}</small>
      <SetupActions back={back}>
        <SetupButton busy={busy} onClick={onStartTrial}>{t('Try Cloud Sync free for 30 days')} <ArrowRightIcon aria-hidden="true" /></SetupButton>
        <SetupButton look="text" disabled={busy} onClick={onContinue}>{t('Annual or local setup')}</SetupButton>
      </SetupActions>
    </div>
  ) : (
    <SetupActions back={back} className="is-bar">
      <SetupButton onClick={onContinue}>{t('Continue')} <ArrowRightIcon aria-hidden="true" /></SetupButton>
    </SetupActions>
  )
  if (keptLocal || ((hostedNotice || skipped) && !hasResults)) {
    return (
      <section aria-labelledby="reveal-title">
        <PageHeading id="reveal-title" title={t('Start with your next session')}
          lead={hostedNotice ? t(hostedNotice) : t('Your agents can build memory as you work.')} />
        {continueRow}
      </section>
    )
  }
  const agentNames = withPrompts.map((agent) => agent.label)
  const agentsJoined = locale === 'zh-CN'
    ? (agentNames.length < 2 ? agentNames.join('') : `${agentNames.slice(0, -1).join('、')} 和 ${agentNames[agentNames.length - 1]}`)
    : locale === 'ko' || locale === 'fr' ? new Intl.ListFormat(locale, { type: 'conjunction' }).format(agentNames)
    : joinNames(agentNames)

  const leadText = promptCount > 0
    ? interpolate(t('{count} messages from {agents}'), {
        count: promptCount.toLocaleString(locale === 'fr' ? locale : 'en-US'),
        agents: agentsJoined,
      })
    : undefined

  return (
    <section aria-labelledby="reveal-title">
      <PageHeading id="reveal-title" title={t('Your recent work')}
        lead={hostedNotice ? undefined : leadText} />
      {hostedNotice && <p className="scan-status" role="status">{t(hostedNotice)}</p>}
      {onStartTrial && continueRow}
      {extraction?.state === 'failed' && <p className="reveal-notice" role="status">{t('Couldn’t finish connecting your work. You can continue with what’s here.')}</p>}
      {promptsOnly && <p className="reveal-notice" role="status">{t('Your conversations are saved. Focus areas need an available agent; you can continue setup now.')}</p>}
      {promptsOnly ? <PromptsOnly agents={withPrompts} recentPrompts={recentPrompts} /> : (
        // One line of links under the rows (E4); "What else came through" opens its fold below that line.
        <Collapsible className="reveal-more">
          <FocusAreaRows reveal={reveal} loading={reveal.focusAreas == null && !finished}
            workLoading={reveal.work === null && !finished} incomplete={(reveal.requestReadErrorCount ?? 0) > 0}
            emptyMessage={!finished ? undefined : extraction?.state === 'failed' ? t('No focus areas were saved before this stopped. Continue setup to use your saved conversations.') : t('No focus areas found in this scan. You can continue setup and review your work later.')}
            more={<CollapsibleTrigger asChild>
              <SetupButton look="text" className="reveal-more-trigger"><ChevronRightIcon aria-hidden="true" />{t('What else came through')}</SetupButton>
            </CollapsibleTrigger>} />
          {/* Kept in the page while folded (hidden), as the closed <details> kept it. */}
          <CollapsibleContent forceMount className="reveal-more-body">
            <p>{t('A selection of requests and preferences from your conversations.')}</p>
            {(reveal.requestReadErrorCount ?? 0) > 0 && <p role="status">{t('Some requests could not be read. The work shown may be incomplete.')}</p>}
            {reveal.work?.map((work) => <p key={work.id}>{work.title}</p>)}
            {reveal.rules?.map((rule) => <blockquote key={rule.id}>{rule.text}<p>“{rule.quote}” · {displayTime(formatPromptDay(rule.quotedAt))}</p></blockquote>)}
            {!reveal.focusAreas?.length && reveal.goals?.map((goal) => <p key={goal.id}>{goal.title}</p>)}
          </CollapsibleContent>
        </Collapsible>
      )}
      {!onStartTrial && continueRow}
    </section>
  )
}
