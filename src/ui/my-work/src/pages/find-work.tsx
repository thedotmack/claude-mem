// Find work (`?view=find&q=`; design pass Phase 4, Codex D02 and Claude D14): one box that finds a focus area, a request
// or a rule in use by its words, from every page (the bar's Find work, or Cmd K / Ctrl K). It searches the work this
// page already loaded, in the browser (live/find-work.ts): no request per keystroke, and never memory, whose own search
// is the last row, one link away with the same words. Results are grouped by what they open, each group with its count;
// the arrow keys move through every result and Enter opens the one marked (the installed command list, cmdk).
import { useMemo, useState, type ReactNode } from 'react'
import { ChevronRightIcon, LibraryIcon } from 'lucide-react'
import { Command, CommandGroup, CommandInput, CommandItem, CommandList, CommandShortcut } from '@/components/ui/command'
import { FIND_WORK_INPUT_ATTRIBUTE } from '@/components/app-bar'
import { StateWords, type Translate } from '@/components/bits'
import { FocusArtwork } from '@/components/focus-artwork'
import { interpolate, useI18n } from '@/lib/i18n'
import { PagingResetContext, usePagedRows } from '@/lib/paged-rows'
import { ruleLineWords, ruleScopeWords } from '@/lib/rule-words'
import { cn } from '@/lib/utils'
import { Req } from '@/spec/req'
import { requestTitle } from '@/data'
import { ruleElementId } from '@/data-rules'
import { LINE_ROWS_PER_PAGE } from '@/live/card-groups'
import { findWork, FIND_RESULT_GROUPS, type FindResultGroup, type FindResults } from '@/live/find-work'
import { focusAreaPlaceWords } from '@/live/to-focus-model'
import { useStore, useWorkModel } from '@/store'
import { memoryFindAddress } from '../../../app-places'

/** Each group's heading, in the order FIND_RESULT_GROUPS gives. */
const GROUP_HEADING: Record<FindResultGroup, (t: Translate) => string> = {
  areas: (t) => t('Focus areas'),
  requests: (t) => t('Requests'),
  rules: (t) => t('Rules'),
}

/** A group's heading and how many it found, on one line (Codex's `.sectionline`). */
function GroupHeading({ group, count }: { group: FindResultGroup; count: number }) {
  const { t } = useI18n()
  return (
    <span className="flex items-baseline justify-between gap-4">
      <span className="text-section-title-phone text-foreground md:text-section-title">{GROUP_HEADING[group](t)}</span>
      <span className="shrink-0 text-sm font-medium text-muted-foreground tabular">{interpolate(t(count === 1 ? '{count} match' : '{count} matches'), { count })}</span>
    </span>
  )
}

/** One result's row: its words, a quiet line under them, and what sits at its end, then the arrow. */
function ResultRow({ title, meta, end }: { title: string; meta?: string; end?: ReactNode }) {
  return (
    <>
      <span className="min-w-0 flex-1">
        <span className="block text-row-title [overflow-wrap:anywhere]">{title}</span>
        {meta && <span className="mt-1 block text-sm text-muted-foreground">{meta}</span>}
      </span>
      <CommandShortcut className="flex items-center gap-3 tracking-normal">{end}<ChevronRightIcon aria-hidden="true" className="size-4.5 text-muted-foreground" /></CommandShortcut>
    </>
  )
}

/** A request result's value in the list (the list marks a result by its value). */
const requestValue = (requestId: string) => `request:${requestId}`

/** Codex's list row: a full-width line under a hairline, marked (arrow keys, pointer) with the field fill. */
const ROW_CLASS_NAME = 'min-h-16 gap-4 rounded-sm border-b border-border px-1 py-4 last:border-b-0 md:px-1'
/** The results' groups, as Codex draws them: the areas as two columns of cards, the requests and rules as rows. */
const GROUP_CLASS_NAME = 'mt-8 p-0 first:mt-6 **:[[cmdk-group-heading]]:mb-4 **:[[cmdk-group-heading]]:p-0 **:[[cmdk-group-heading]]:text-base'

/**
 * The groups of results and, last, Memory's search: every one an option of the one list the arrow keys move through.
 * `mark`: marks a result (the list's mark is the page's, FindWork), so "Show more" hands the mark to the first request
 * it added: the arrow keys and Enter carry on from there (G4), not from the button now below the new rows.
 */
function Results({ words, results, mark }: { words: string; results: FindResults; mark: (value: string) => void }) {
  const { t } = useI18n()
  const { focusAreas, ruleScopes } = useWorkModel()
  const artwork = useStore((state) => state.view.focusArtwork)
  const { goToFocus, goToPage, openRequestDrawer } = useStore.getState()
  const requests = usePagedRows(results.requests.length, true)
  return (
    <>
      {results.areas.length > 0 && (
        <CommandGroup heading={<GroupHeading group="areas" count={results.areas.length} />} className={cn(GROUP_CLASS_NAME, '**:[[cmdk-group-items]]:grid **:[[cmdk-group-items]]:gap-3 md:**:[[cmdk-group-items]]:grid-cols-2')}>
          {results.areas.map(({ area, requests: placed }) => (
            <CommandItem key={area.id} value={`area:${area.id}`} onSelect={() => goToFocus(area.id)} data-find-result="areas"
              className="min-h-20 gap-4 rounded-xl border border-border bg-card p-4 shadow-panel md:min-h-24">
              {artwork !== 'off' && <span className="artwork-compact flex shrink-0"><FocusArtwork area={area} /></span>}
              <ResultRow title={area.name} meta={interpolate(t(placed.length === 1 ? '{count} request' : '{count} requests'), { count: placed.length })} />
            </CommandItem>
          ))}
        </CommandGroup>
      )}
      {results.requests.length > 0 && (
        <CommandGroup heading={<GroupHeading group="requests" count={results.requests.length} />} className={cn(GROUP_CLASS_NAME, '**:[[cmdk-group-items]]:border-t **:[[cmdk-group-items]]:border-border')}>
          {results.requests.slice(0, requests.shown).map((request) => (
            <CommandItem key={request.id} value={requestValue(request.id)} onSelect={() => openRequestDrawer(request)} data-find-result="requests" className={ROW_CLASS_NAME}>
              <ResultRow title={requestTitle(request, t)} meta={focusAreaPlaceWords(request.focusAreaId, focusAreas, t)} end={<StateWords state={request.state} />} />
            </CommandItem>
          ))}
          {/* Long lists 50 at a time (live/card-groups.ts LINE_ROWS_PER_PAGE), the next page one arrow press away. */}
          {requests.left > 0 && (
            <CommandItem value="requests:more" onSelect={() => { const firstAdded = results.requests[requests.shown]; requests.showMore(); mark(requestValue(firstAdded.id)) }} className={cn(ROW_CLASS_NAME, 'text-muted-foreground')}>
              {interpolate(t('Show {count} more · {left} left'), { count: Math.min(LINE_ROWS_PER_PAGE, requests.left), left: requests.left })}
            </CommandItem>
          )}
        </CommandGroup>
      )}
      {results.rules.length > 0 && (
        <CommandGroup heading={<GroupHeading group="rules" count={results.rules.length} />} className={cn(GROUP_CLASS_NAME, '**:[[cmdk-group-items]]:border-t **:[[cmdk-group-items]]:border-border')}>
          {results.rules.map((rule) => {
            const scope = ruleScopes.find((entry) => entry.id === rule.scopeId)
            return (
              <CommandItem key={rule.id} value={`rule:${rule.id}`} onSelect={() => goToPage('rules', { elementId: ruleElementId(rule.id) })} data-find-result="rules" className={ROW_CLASS_NAME}>
                <ResultRow title={ruleLineWords(rule, t)} meta={scope ? ruleScopeWords(scope, t) : undefined} />
              </CommandItem>
            )
          })}
        </CommandGroup>
      )}
      {/* Memory has its own search of the memories it loaded; the same words open it there (Codex: a quiet link last). */}
      <CommandGroup className="mt-8 border-t border-border p-0 pt-2">
        <CommandItem value="memory" onSelect={() => window.location.assign(memoryFindAddress(words.trim()))} data-find-result="memory"
          className="w-fit gap-2 px-1.5 font-medium text-accent-foreground data-selected:text-accent-foreground">
          <LibraryIcon aria-hidden="true" className="size-4.5" />{t('Search loaded memories')}
        </CommandItem>
      </CommandGroup>
    </>
  )
}

export function FindWork() {
  const { t } = useI18n()
  const { focusAreas, requests, rules } = useWorkModel()
  const words = useStore((state) => state.view.findQuery) ?? ''
  const setFindQuery = useStore((state) => state.setFindQuery)
  const results = useMemo(() => findWork(words, { focusAreas, requests, rules }), [words, focusAreas, requests, rules])
  const searching = words.trim().length > 0
  const found = FIND_RESULT_GROUPS.reduce((total, group) => total + results[group].length, 0)
  // The marked result. cmdk marks the first result as the words change (so Enter opens it); "Show more" marks the first
  // request it added.
  const [marked, setMarked] = useState('')
  const nothingFound = interpolate(t('Nothing in your loaded work matches “{words}”.'), { words: words.trim() })
  // What a screen reader hears as the words change: how many results, or that nothing matches. One region, mounted
  // with the page, so each change is read (a region inserted already filled is often skipped).
  const heard = !searching ? '' : found === 0 ? nothingFound : interpolate(t(found === 1 ? '{count} result' : '{count} results'), { count: found })
  return (
    <Req ids={['R12.1']}>
      {/* The page's own column (no popover fill or scroll box: the list is the page). */}
      <Command shouldFilter={false} label={t('Find work')} value={marked} onValueChange={setMarked} className="h-auto overflow-visible rounded-none! bg-transparent p-0 text-foreground">
        <CommandInput value={words} onValueChange={setFindQuery} autoFocus placeholder={t('Find work')} {...{ [FIND_WORK_INPUT_ATTRIBUTE]: '' }} className="text-base" />
        {/* What the page says outside the list of results: how to start, or that nothing loaded matches. */}
        {!searching ? <p className="mt-6 text-muted-foreground">{t('Type to find a focus area by its name or goal, a request by its title or summary, or a rule in use.')}</p>
          : found === 0 && <p aria-hidden="true" className="mt-6 text-muted-foreground">{nothingFound}</p>}
        {searching && (
          <CommandList className="max-h-none overflow-visible">
            {/* Every list under it starts on its first page again when the words change (usePagedRows). */}
            <PagingResetContext.Provider value={words}><Results words={words} results={results} mark={setMarked} /></PagingResetContext.Provider>
          </CommandList>
        )}
        <p role="status" data-find-heard="" className="sr-only">{heard}</p>
      </Command>
    </Req>
  )
}
