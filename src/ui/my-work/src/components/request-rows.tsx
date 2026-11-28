// Requests as rows in their state groups (decision G4): the old board's List below the table's width, the Team columns,
// and the Cards board's folded Idle and Shipped (By agent draws Requests' own rows, pages/requests.tsx RequestListRow).
// Self-contained, so either board layout can mount them (plan rule 12).
import type { ReactNode } from 'react'
import { AgentIcon, FocusAreaChip, LocalTime, NextMove, ProgressMeter, STATE_LABEL, STATE_SURFACE, StateBadge } from '@/components/bits'
import { RunningFor } from '@/components/live-motion'
import { SplitFlapText } from '@/components/split-flap'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleFoldTrigger } from '@/components/ui/collapsible'
import { TablePageFooter } from '@/components/ui/table'
import { interpolate, useI18n } from '@/lib/i18n'
import { usePagedRows } from '@/lib/paged-rows'
import { usePrefersReducedMotion } from '@/lib/use-media'
import { cn } from '@/lib/utils'
import { LINE_ROWS_PER_PAGE, requestSections, type CardGroup } from '@/live/card-groups'
import { DURATION_WORD } from '@/live/running-time'
import { requestTitle, type Request } from '@/data'
import { useFreshlyUpdated, useStore, useWorkspace } from '@/store'

/** "Show 50 more · 68 left": the next page of one-line rows (G4, live/card-groups.ts LINE_ROWS_PER_PAGE). */
export function ShowMoreRows({ left, onShowMore }: { left: number; onShowMore: () => void }) {
  const { t } = useI18n()
  if (left === 0) return null
  return (
    <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={onShowMore}>
      {interpolate(t('Show {count} more · {left} left'), { count: Math.min(LINE_ROWS_PER_PAGE, left), left })}
    </Button>
  )
}

/** A group's dot and name, as its heading or its fold row shows it. */
export function GroupLabel({ group }: { group: CardGroup }) {
  const { t } = useI18n()
  return <span className="inline-flex items-center gap-2"><span aria-hidden="true" className={cn('size-2 rounded-full', group.dot)} />{t(group.label)}</span>
}

/**
 * One state group of rows (G4). Idle and Shipped are one fold row, "Idle · 118" with its chevron (the shared fold row,
 * G5), until opened; Needs you and Working are open under a heading with their count. Opened, a group draws its rows 50
 * at a time ("Show 50 more · 68 left"). Nothing folds by itself.
 */
export function RequestGroup({ group, members, renderRow, heading: Heading = 'h3' }: { group: CardGroup; members: Request[]; renderRow: (request: Request) => ReactNode; heading?: 'h3' | 'h4' }) {
  const folds = group.size === 'line'
  const paged = usePagedRows(members.length, !folds)
  const rows = (
    <>
      <ul id={paged.listId} className="divide-y divide-border/70">
        {members.slice(0, paged.shown).map((request) => <li key={request.id} data-list-row="">{renderRow(request)}</li>)}
      </ul>
      <ShowMoreRows left={paged.left} onShowMore={paged.showMore} />
    </>
  )
  if (!folds) {
    return (
      <section aria-labelledby={`${paged.listId}-heading`} data-request-group={group.id} className="space-y-1">
        <Heading id={`${paged.listId}-heading`} className="flex items-center gap-2 px-1 pt-1 text-sm font-semibold tracking-tight">
          <GroupLabel group={group} /><span className="font-normal text-muted-foreground mono-number">{members.length}</span>
        </Heading>
        {rows}
      </section>
    )
  }
  return (
    <Collapsible open={paged.open} onOpenChange={paged.setOpen} data-line-section={group.id}>
      <Heading>
        <CollapsibleFoldTrigger count={<span className="mono-number">{members.length}</span>}><GroupLabel group={group} /></CollapsibleFoldTrigger>
      </Heading>
      <CollapsibleContent className="space-y-1 pt-1">{rows}</CollapsibleContent>
    </Collapsible>
  )
}

/**
 * Requests in their state groups (G4) when the board is attention-first with every request; sorted another way or
 * filtered, one list in that order, 50 rows at a time, with "Showing 50 of 197" (TablePageFooter: always where
 * `countAlways`, as the List, elsewhere once a page is not enough). `renderRow` draws one request.
 */
export function RequestGroups({ requests, grouped, renderRow, countAlways = false, heading = 'h3' }: { requests: Request[]; grouped: boolean; renderRow: (request: Request) => ReactNode; countAlways?: boolean; heading?: 'h3' | 'h4' }) {
  const paged = usePagedRows(requests.length, true)
  if (grouped) {
    return <div className="space-y-3">{requestSections(requests).map(({ group, members }) => <RequestGroup key={group.id} group={group} members={members} renderRow={renderRow} heading={heading} />)}</div>
  }
  return (
    <div>
      <ul id={paged.listId} className="divide-y divide-border/70">
        {requests.slice(0, paged.shown).map((request) => <li key={request.id} data-list-row="">{renderRow(request)}</li>)}
      </ul>
      {(countAlways || paged.left > 0) && <TablePageFooter className="px-2" shownCount={paged.shown} totalCount={requests.length} pageSize={LINE_ROWS_PER_PAGE} onShowMore={paged.showMore} />}
    </div>
  )
}

/**
 * A request's status on the List (c-work-list-view, c-split-flap): at rest the state badge the cards use (D b26 #4),
 * its mark and word. When the screen sees a status change, the departures-board tiles riffle into the new word inside
 * the same badge, then the word rests again: only the newest change does, only while its request is "just updated"
 * (the store's FRESHLY_UPDATED_FOR_MS), never on the first draw (a first model has no changes), and never under reduced
 * motion, read as it is now (a setting changed while the page is open counts), where the badge simply changes its word.
 * So one live model that changes several requests moves two things in the List and Team: the change ticker and this
 * riffle (rule 8). Every other changed row, the riffling one too, shows the still "just updated" mark
 * (index.css .just-updated-mark), never a glow. A screen reader hears the word either way.
 */
export function ListStatus({ request }: { request: Request }) {
  const { t } = useI18n()
  const reduceMotion = usePrefersReducedMotion()
  const flipping = useStore((state) => {
    const newest = state.work.recentChanges[0]
    return state.work.freshlyUpdatedIds.has(request.id) && newest?.requestId === request.id && newest.kind === 'state' && newest.to === request.state
  })
  if (!flipping || reduceMotion) return <StateBadge state={request.state} />
  return (
    <StateBadge state={request.state}>
      <SplitFlapText text={t(STATE_LABEL[request.state])} tileClassName={STATE_SURFACE[request.state]} />
    </StateBadge>
  )
}

/**
 * The facts the List's table shows beside a row's title, status and next step (pages/requests.tsx ListTable), for the
 * List's rows from 768px up to the table's width, on a line of its own that wraps (rule 2: HEAD's table showed them
 * there): the focus area, who asked (team mode), progress, the start in the reader's clock (the shared LocalTime: the
 * full time on hover, focus and tap) and how long it has run. The area link and the time sit above the row's stretched
 * button, as the agent's mark does, so each keeps its own press; the rest of the line opens the request. Below 768px
 * the row is the phone's row again (agent, title, status, next step).
 */
function RowFacts({ request, onOpenFocus }: { request: Request; onOpenFocus: (focusAreaId: string) => void }) {
  const { t } = useI18n()
  const { team } = useWorkspace()
  return (
    <div data-row-facts="" className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1 pl-[38px] text-xs text-muted-foreground max-md:hidden">
      <span className="relative z-[1] flex min-w-0 max-w-full"><FocusAreaChip focusAreaId={request.focusAreaId} onOpen={onOpenFocus} /></span>
      {team && <span>{interpolate(t('asked by {askedBy}'), { askedBy: request.askedBy })}</span>}
      <ProgressMeter request={request} compact />
      <span className="inline-flex items-center gap-1">
        {t('Started')}
        {request.startedAtIso ? <span className="relative z-[1]"><LocalTime iso={request.startedAtIso} /></span> : <span>{t('Start not recorded')}</span>}
      </span>
      <span className="inline-flex items-center gap-1">{t(DURATION_WORD[request.state])}<RunningFor request={request} className="text-xs" /></span>
    </div>
  )
}

/**
 * The row's own button, stretched over the whole row by its ::after (the row is the positioned box), with its focus
 * ring drawn there, so a press anywhere on the row opens the request; the agent's mark sits above it (z-[1]).
 */
const ROW_TARGET_CLASS_NAME = 'after:absolute after:inset-0 after:rounded-lg focus-visible:border-transparent focus-visible:ring-0 focus-visible:after:ring-3 focus-visible:after:ring-ring/50'

/**
 * One request on a List row below the table's width and in a Team column: the whole row opens it
 * (its button, stretched over the row), its title, its status, and its next step on one line ("—" when none is
 * recorded, G3). The agent's mark sits above the stretched button, so its tooltip stays reachable without a control
 * inside a control: with the mark, a row is two Tab stops, the mark (G10: a tooltip trigger is a Tab stop) and the
 * row. `facts` adds the List's facts line from 768px (RowFacts), whose area link and time are a Tab stop each.
 * 44px tall on touch through the Button's own rule (plan rule 6). A row whose record just changed shows the still
 * "just updated" mark (ListStatus says why it does not glow).
 *
 * Two layouts of the same parts, in the order they are seen (and read, and reached by Tab):
 * - the List's (c-work-list-view): the mark, then the title cut to one line beside the status, the next step under
 *   them;
 * - `titleOnItsOwnLine` (Team columns): the whole title on a line of its own as wide as the row,
 *   wrapping, as HEAD's Team and By agent cards showed it (rule 2); under it the status, then the next step beside it
 *   or, when they do not fit side by side, under it; then the mark (with the tool's name in Team). Nothing shares the
 *   title's line, so a narrow column cannot squeeze it: in a 202px Team column at 768px the mark, the name and the
 *   status beside it left the title 0px and stacked the status letter by letter (measured on the owner's data and in
 *   sample mode, 2026-11-17).
 */
export function RequestRow({ request, onOpen, showAgentName = false, titleOnItsOwnLine = false, facts }: {
  request: Request; onOpen: (request: Request) => void
  /**
   * The tool's name printed beside the agent's mark (Team columns: HEAD's Team cards printed it, rule 2). A name past
   * the mark's room ends in an ellipsis with the whole identity in the mark's tooltip, as everywhere AgentIcon prints it.
   */
  showAgentName?: boolean
  /** The whole title on a line of its own, wrapping (Team columns); left out, the List's one line. */
  titleOnItsOwnLine?: boolean
  /** The List's rows (pages/requests.tsx ListView): the facts line, whose area link opens that area. */
  facts?: { onOpenFocus: (focusAreaId: string) => void }
}) {
  const { t } = useI18n()
  const fresh = useFreshlyUpdated(request.id)
  const title = requestTitle(request, t)
  const titleTone = !request.title && 'text-muted-foreground'
  const rowClassName = cn('relative min-w-0 rounded-lg px-2.5 py-2 hover:bg-surface', titleOnItsOwnLine ? 'space-y-1.5' : 'space-y-1', fresh && 'just-updated-mark')
  const freshWords = fresh && <span className="sr-only">{t('Just updated')}</span>
  if (titleOnItsOwnLine) {
    return (
      <div data-request-row={request.state} data-just-updated={fresh || undefined} className={rowClassName}>
        {/* Borderless, so the title is exactly as wide as the row's content (the bare button keeps a 1px clear edge). */}
        <Button variant="bare" data-row-target="" data-request-opener={request.id} onClick={() => onOpen(request)} className={cn('flex w-full flex-col items-stretch gap-1.5 border-0 text-sm', ROW_TARGET_CLASS_NAME)}>
          <span data-row-title="" className={cn('font-medium wrap-break-word', titleTone)}>{title}</span>
          <span className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
            <ListStatus request={request} />
            {/* The step whole, wrapping as the title does (HEAD's By agent cards showed it whole; rule 2). */}
            <NextMove next={request.next} whenMissing="dash" layout="lines" className="basis-full" />
          </span>
          {freshWords}
        </Button>
        <span className="relative z-[1] flex w-fit max-w-full"><AgentIcon agentId={request.agentId} showName={showAgentName} /></span>
      </div>
    )
  }
  return (
    <div data-request-row={request.state} data-just-updated={fresh || undefined} className={rowClassName}>
      <div className="flex min-w-0 items-start gap-2.5">
        <span className="relative z-[1]"><AgentIcon agentId={request.agentId} showName={showAgentName} /></span>
        <Button variant="bare" data-row-target="" data-request-opener={request.id} onClick={() => onOpen(request)} className={cn('min-w-0 flex-1 flex-col items-stretch gap-1 text-sm', ROW_TARGET_CLASS_NAME)}>
          <span className="flex min-w-0 items-center gap-2">
            <span data-row-title="" className={cn('min-w-0 flex-1 truncate font-medium', titleTone)}>{title}</span>
            <ListStatus request={request} />
          </span>
          <NextMove next={request.next} whenMissing="dash" layout="line" />
          {freshWords}
        </Button>
      </div>
      {facts && <RowFacts request={request} onOpenFocus={facts.onOpenFocus} />}
    </div>
  )
}
