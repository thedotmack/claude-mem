// Requests (`?view=requests`; design pass Phase 5, Codex D06, Claude D04 and D05): the place to browse every request, so
// Home can stay short. The page says how many requests there are; a find box (titles and summaries, in the browser),
// Filter and sort (an area, the closed requests, the boards' sorts) and By agent; status tabs from the boards' one list
// of groups (live/card-groups.ts CARD_GROUPS), each with its count; then one line per request, its plain name, its focus
// area under it and its state at the right, the whole row the link to it, 50 at a time. The tab, the area, the closed
// choice and the words are in the address (`?status=`, `?area=`, `?closed=1`, `?q=`; store/slices/view-slice.ts), so
// Back brings them back. By agent (`?by=agent`) puts the same requests under each agent (live/agent-board.ts), the
// requests no agent is recorded for in a group of their own and the agents with nothing here folded. With Team view
// on, the list is the Team board's columns. The List's table, By agent and the Team board also draw the old board on
// Home and on a focus area's page (pages/my-work.tsx) until the design pass takes it from there (phases 6 and 8); the
// table has no other use.
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { ArrowDownIcon, ArrowUpDownIcon, ChevronRightIcon, ExternalLinkIcon, InboxIcon, ListIcon, ListFilterIcon, PlusIcon, SearchIcon, TriangleAlertIcon, UsersIcon } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleFoldTrigger, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle, EmptyDescription } from '@/components/ui/empty'
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group'
import { Label } from '@/components/ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Table, TableBody, TableCell, TableHead, TableHeader, TablePageFooter, TableRow } from '@/components/ui/table'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { AgentIcon, FocusAreaChip, LocalTime, NeedsYouPill, NextMove, ProgressMeter, RecordedTime, SourceReadAlert, StateMark, StateWords, type Translate } from '@/components/bits'
import { AgentMark } from '@/components/brand'
import { ErrorDetails } from '@/components/error-details'
import { RunningFor } from '@/components/live-motion'
import { PANEL_SURFACE_CLASS_NAME, PANEL_TITLE_CLASS_NAME } from '@/components/panel'
import { GroupLabel, ListStatus, RequestGroups, RequestRow, ShowMoreRows } from '@/components/request-rows'
import { RequestReadErrors } from '@/components/request-read-errors'
import { agentOwnRoleWords, deviceName } from '@/lib/agent-words'
import { interpolate, t, useI18n } from '@/lib/i18n'
import { FOCUS_FROM_CODE_CLASS_NAME, PagingResetContext, usePagedRows } from '@/lib/paged-rows'
import { placeLinkPress, useRequestHref, useRequestsHref } from '@/lib/place-link'
import type { RequestsTab } from '@/lib/requests-heading'
import { useWidthOf } from '@/lib/use-media'
import { cn } from '@/lib/utils'
import { Req } from '@/spec/req'
import { byAttention, isSubagent, needsYou, requestTitle, startedTimestamp, type Agent as WorkAgent, type LiveState, type Request } from '@/data'
import { agentBoard, countAgentsWithSubagents, type AgentEntry } from '@/live/agent-board'
import { CARD_GROUPS, LINE_ROWS_PER_PAGE, LIST_TITLE_MIN_PX, requestSections, type CardGroup, type CardGroupId } from '@/live/card-groups'
import { matchesWords } from '@/live/find-work'
import { NOT_SORTED_AREA, requestsAreaChoices, requestsAreaOf, type RequestsArea } from '@/live/requests-areas'
import { DURATION_WORD } from '@/live/running-time'
import { focusAreaPlaceWords } from '@/live/to-focus-model'
import { THIS_COMPUTER, UNRECORDED_AGENT } from '@/live/to-work-model'
import { type WorkSort, deviceById, useFreshlyUpdated, useStore, useWorkModel, useWorkspace } from '@/store'
import type { RequestsGrouping } from '@/store/slices/view-slice'
import { TEAMBRAIN_START_URL } from '../../../viewer/constants/promo'

type SortKey = WorkSort

// ---------- The boards' sorts (Requests, and the old board on Home and an area's page) ----------

export const SORTS: { value: SortKey; label: string }[] = [
  { value: 'attention', label: 'Needs you first' },
  { value: 'started', label: 'Newest' },
  { value: 'progress', label: 'Most progress' },
]
const titleOf = (request: Request) => requestTitle(request, t)

/** Attention first by default (your move, then to check, then working, idle, shipped); newest first within a state. */
export function sortRequests(requests: Request[], sort: SortKey) {
  const newest = (a: Request, b: Request) => startedTimestamp(b) - startedTimestamp(a)
  return [...requests].sort((a, b) =>
    sort === 'progress' ? (b.progress.percent ?? -1) - (a.progress.percent ?? -1) || newest(a, b)
      : sort === 'started' ? newest(a, b)
        : byAttention(a, b))
}

// ---------- The List's table (the old board on Home and an area's page) ----------

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
export function ListView({ requests, grouped, sort, onSort, onOpen, onOpenFocus }: { requests: Request[]; grouped: boolean; sort: SortKey; onSort: (sort: SortKey) => void; onOpen: (request: Request) => void; onOpenFocus: (focusAreaId: string) => void }) {
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

// ---------- Subagents ----------

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

/**
 * Subagents fold under their parent (c-ai-agent M), each with its task, state, Mark finished and its requests as rows
 * like Requests' own (RequestListRow); 50 at a time.
 */
function SubagentsFold({ subagents, onOpen }: { subagents: AgentEntry['subagents']; onOpen: (request: Request) => void }) {
  const paged = usePagedRows(subagents.length, false)
  const hrefOf = useRequestHref()
  return (
    <Collapsible open={paged.open} onOpenChange={paged.setOpen} data-subagents="">
      <CollapsibleFoldTrigger count={<span className="mono-number">{subagents.length}</span>}>{t('Subagents')}</CollapsibleFoldTrigger>
      <CollapsibleContent className="pt-1">
        <ul id={paged.listId} className="ml-3 divide-y divide-border/70 border-l border-control-edge/55">
          {subagents.slice(0, paged.shown).map(({ agent, requests }) => (
            <li key={agent.id} data-list-row="" tabIndex={-1} data-subagent-row={agent.status ?? ''} data-subagent-id={agent.id} className={cn('rounded-sm py-1', FOCUS_FROM_CODE_CLASS_NAME)}>
              {agent.launchDescription && <div className="min-w-0 px-2.5 pt-1"><SubagentTask agent={agent} /></div>}
              <SubagentStatus agent={agent} />
              {requests.map((request) => <RequestListRow key={request.id} request={request} href={hrefOf(request.id)} onOpen={onOpen} />)}
            </li>
          ))}
        </ul>
        <ShowMoreRows left={paged.left} onShowMore={paged.showMore} />
      </CollapsibleContent>
    </Collapsible>
  )
}

// ---------- By agent ----------

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

/** One group of By agent: an agent with its requests (and its subagents), or the requests no agent is recorded for. */
type AgentGroupEntry = { kind: 'agent'; entry: AgentEntry } | { kind: 'unrecorded'; requests: Request[] }

const groupId = (group: AgentGroupEntry) => group.kind === 'agent' ? group.entry.agent.id : UNRECORDED_AGENT.id

/**
 * What tells an agent apart, on one line under its name (§13.2, R13.4): what it works in, the machine it ran on (and
 * how fresh that machine's copy is), and, where another agent would read the same (several sessions in one folder),
 * the start of its session, which the mapper sends only then (Agent.sessionShortId). A subagent shows its task instead
 * (SubagentTask, in its group).
 */
function agentWhereWords(agent: WorkAgent, t: Translate): string {
  const device = deviceById(agent.deviceId)
  const machine = [deviceName(device, t), device.syncedMinutesAgo !== 0 ? interpolate(t('synced {minutes} min ago'), { minutes: device.syncedMinutesAgo }) : device.id === THIS_COMPUTER.id ? null : t('this machine')]
  const session = !isSubagent(agent) && agent.sessionShortId ? interpolate(t('Session {id}'), { id: agent.sessionShortId }) : null
  return [agentOwnRoleWords(agent, t), ...machine, session].filter(Boolean).join(' · ')
}

/**
 * One agent's group (Codex's by-agent page): a header that opens it in place, with the agent's mark, its name (a
 * subagent with no recorded parent labelled so), what tells it apart and how many requests it holds here; opened, its
 * requests as Requests' rows, 50 at a time, without the agent repeated on each, and its subagents folded under it. The
 * requests no agent is recorded for are a group of their own, "Agent not recorded" (its mark's tile dashed, as the
 * agent icon's is). `panel`: the first group, open, on a panel of its own with its name as a heading and no mark
 * (Codex's panel); the others are rows under "Other agents".
 */
function AgentGroup({ group, panel = false, onOpen }: { group: AgentGroupEntry; panel?: boolean; onOpen: (request: Request) => void }) {
  const { t } = useI18n()
  const [open, setOpen] = useState(panel)
  const agent = group.kind === 'agent' ? group.entry.agent : UNRECORDED_AGENT
  const requests = group.kind === 'agent' ? group.entry.requests : group.requests
  const total = group.kind === 'agent' ? group.entry.total : group.requests.length
  const subagent = isSubagent(agent)
  const name = group.kind === 'agent' ? agent.name : t(UNRECORDED_AGENT.name)
  const where = group.kind === 'agent' ? agentWhereWords(agent, t) : null
  const header = (
    <CollapsibleTrigger asChild>
      <Button variant="bare" data-agent-header="" className="group/agent flex min-h-16 w-full items-center gap-3 rounded-sm px-1 py-3 hover-enabled:bg-muted md:gap-4">
        {!panel && (
          <span aria-hidden="true" className={cn('grid size-10 shrink-0 place-items-center rounded-xl bg-muted text-muted-foreground', group.kind === 'unrecorded' && 'border border-dashed border-control-edge')}>
            <AgentMark tool={agent.tool} className="size-5" />
          </span>
        )}
        <span className="min-w-0 flex-1">
          <span className={cn('flex flex-wrap items-center gap-x-2 gap-y-1', panel ? PANEL_TITLE_CLASS_NAME : 'text-row-title')}>
            <span data-agent-name="">{name}</span>
            {subagent && <Badge variant="outline" className="font-normal text-muted-foreground">{t('Subagent')}</Badge>}
          </span>
          {where && <span data-agent-where="" className="mt-1 block text-sm text-muted-foreground [overflow-wrap:anywhere]">{where}</span>}
        </span>
        <span className="shrink-0 text-sm text-muted-foreground tabular">{interpolate(total === 1 ? t('{count} request') : t('{count} requests'), { count: total })}</span>
        <ChevronRightIcon aria-hidden="true" className="size-4.5 shrink-0 text-muted-foreground motion-safe:transition-transform group-data-[state=open]/agent:rotate-90" />
      </Button>
    </CollapsibleTrigger>
  )
  return (
    <Collapsible open={open} onOpenChange={setOpen} data-agent-group={groupId(group)}
      className={cn(panel && cn(PANEL_SURFACE_CLASS_NAME, 'px-3.5 py-2 md:px-6 md:py-3'))}>
      {panel ? <h2>{header}</h2> : header}
      <CollapsibleContent className={cn('space-y-2 pb-3', panel ? 'pt-2' : 'md:pl-14')}>
        {group.kind === 'agent' && subagent && (
          <>
            {agent.launchDescription && <div className="min-w-0 px-1"><SubagentTask agent={agent} /></div>}
            <SubagentStatus agent={agent} />
          </>
        )}
        {total === 0 && <p className="px-1 text-sm text-muted-foreground">{t('Nothing on it in this view.')}</p>}
        {requests.length > 0 && <RequestListRows requests={requests} onOpen={onOpen} />}
        {group.kind === 'agent' && group.entry.subagents.length > 0 && <SubagentsFold subagents={group.entry.subagents} onOpen={onOpen} />}
      </CollapsibleContent>
    </Collapsible>
  )
}

/** Groups as rows under one hairline each, 50 at a time; "Show 50 more" puts focus on the first header it added. */
function AgentGroupRows({ groups, onOpen }: { groups: AgentGroupEntry[]; onOpen: (request: Request) => void }) {
  return <PagedList items={groups} keyOf={groupId} renderItem={(group) => <AgentGroup group={group} onOpen={onOpen} />} />
}

/**
 * By agent (Codex D06's by-agent page, c-work-by-agent-view): the agents with requests here, busiest first
 * (live/agent-board.ts: the most urgent request, then how many, then the model's order). The first is open on its own
 * panel; the others are rows under "Other agents" that open in place, the requests no agent is recorded for first among
 * them as "Agent not recorded" (a group like any agent's, so none is dropped). Then the agents with nothing here,
 * folded to one dashed line that says how many. `words`: only the agents whose name, what tells them apart or task
 * holds them (a subagent's match keeps its parent), and "Agent not recorded" by its own name. Requests in a group are
 * attention first; the board's Sort is not followed here. Nothing glides when a live change moves an agent (rule 8).
 * `empty`: what it says when there is no agent and no request to show at all (Requests' By agent; Home's board says
 * that itself).
 */
export function ByAgentView({ requests, words = '', empty, onOpen }: { requests: Request[]; words?: string; empty?: ReactNode; onOpen: (request: Request) => void }) {
  const { t } = useI18n()
  const { agents } = useWorkModel()
  const headingId = useId()
  const board = agentBoard(agents, [...requests].sort(byAttention))
  const searching = words.trim() !== ''
  const agentMatches = (agent: WorkAgent) => matchesWords(words, agent.name, agentWhereWords(agent, t), agent.launchDescription)
  const entryShown = (entry: AgentEntry) => !searching || agentMatches(entry.agent) || entry.subagents.some((subagent) => agentMatches(subagent.agent))
  const withWork: AgentGroupEntry[] = board.withWork.filter(entryShown).map((entry) => ({ kind: 'agent', entry }))
  const unrecorded: AgentGroupEntry[] = board.unrecorded.length > 0 && (!searching || matchesWords(words, t(UNRECORDED_AGENT.name))) ? [{ kind: 'unrecorded', requests: board.unrecorded }] : []
  const [lead, ...others] = withWork.length > 0 ? [withWork[0], ...unrecorded, ...withWork.slice(1)] : unrecorded
  const idle = board.idle.filter(entryShown)
  const idleAgents = countAgentsWithSubagents(idle)
  return (
    <Req ids={['R4.3', 'R13.2', 'R13.4']}>
      <div className="space-y-8">
        {lead && <AgentGroup key={groupId(lead)} group={lead} panel onOpen={onOpen} />}
        {others.length > 0 && (
          <section aria-labelledby={headingId} className="space-y-3">
            <h2 id={headingId} className="text-section-title-phone md:text-section-title">{t('Other agents')}</h2>
            <AgentGroupRows groups={others} onOpen={onOpen} />
          </section>
        )}
        {idle.length > 0 && (
          <DashedFold id="idle-agents" label={interpolate(idleAgents === 1 ? t('{count} agent has nothing in this view') : t('{count} agents have nothing in this view'), { count: idleAgents })}>
            <AgentGroupRows groups={idle.map((entry) => ({ kind: 'agent', entry }))} onOpen={onOpen} />
          </DashedFold>
        )}
        {!lead && idle.length === 0 && (searching
          ? <p className="text-muted-foreground">{interpolate(t('No agent or session matches “{words}”.'), { words: words.trim() })}</p>
          : empty)}
      </div>
    </Req>
  )
}

// ---------- Team view ----------

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
export function TeamBoard({ requests, grouped, onOpen }: { requests: Request[]; grouped: boolean; onOpen: (request: Request) => void }) {
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

// ---------- Requests' rows ----------

/**
 * One request on Requests (Codex's `.listrow`): its plain name (requestTitle: a request still being named says so,
 * never its prompt), its focus area under it ("Not sorted yet" until a review places it), its state's mark and word at
 * the right, then the arrow. The whole row is a link to the request (`?request=`: a new tab, a copied link), and a
 * plain press opens it over the page. At least 64px tall, so every row is a whole touch target on a phone. No timer, no
 * progress and no agent: By agent names the agent once, over its rows.
 */
function RequestListRow({ request, href, onOpen }: { request: Request; href: string; onOpen: (request: Request) => void }) {
  const { t } = useI18n()
  const { focusAreas } = useWorkModel()
  const named = !!(request.title ?? request.resolvesTo?.title)
  return (
    <Req ids={['R2.1']}>
      <a href={href} data-request-opener={request.id} data-requests-row={request.state} onClick={placeLinkPress(() => onOpen(request))}
        className="flex min-h-16 w-full items-center gap-3 rounded-sm px-1 py-4 outline-none transition-colors hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 md:gap-4">
        <span className="min-w-0 flex-1">
          <span data-row-title="" className={cn('block text-row-title [overflow-wrap:anywhere]', !named && 'text-muted-foreground')}>{requestTitle(request, t)}</span>
          <span data-row-area="" className="mt-1 block text-sm text-muted-foreground">{focusAreaPlaceWords(request.focusAreaId, focusAreas, t)}</span>
        </span>
        <StateWords state={request.state} />
        <ChevronRightIcon aria-hidden="true" className="size-4.5 shrink-0 text-muted-foreground" />
      </a>
    </Req>
  )
}

/**
 * Things as rows under one hairline each, 50 at a time (live/card-groups.ts LINE_ROWS_PER_PAGE); "Show 50 more" puts
 * focus on the first row it added (lib/paged-rows.ts). Requests' rows, and By agent's groups.
 */
function PagedList<Item>({ items, keyOf, renderItem }: { items: Item[]; keyOf: (item: Item) => string; renderItem: (item: Item) => ReactNode }) {
  const paged = usePagedRows(items.length, true)
  return (
    <div className="space-y-2">
      <ul id={paged.listId} className="divide-y divide-border border-t border-border">
        {items.slice(0, paged.shown).map((item) => <li key={keyOf(item)} data-list-row="">{renderItem(item)}</li>)}
      </ul>
      {paged.left > 0 && <div className="border-t border-border pt-2"><ShowMoreRows left={paged.left} onShowMore={paged.showMore} /></div>}
    </div>
  )
}

/** Requests as rows, 50 at a time. */
function RequestListRows({ requests, onOpen }: { requests: Request[]; onOpen: (request: Request) => void }) {
  const hrefOf = useRequestHref()
  return <PagedList items={requests} keyOf={(request) => request.id} renderItem={(request) => <RequestListRow request={request} href={hrefOf(request.id)} onOpen={onOpen} />} />
}

// ---------- The page ----------

/** The page's line under its title (Codex's `.leadtext`). */
function LeadLine({ children }: { children: ReactNode }) {
  return <p data-requests-lead="" className="text-base text-muted-foreground md:text-lg">{children}</p>
}

/** A find box (Codex's `.searchbox`): its mark, then the words; its label is its placeholder, read by screen readers. */
function FindBox({ label, words, onWords, className }: { label: string; words: string; onWords: (words: string) => void; className?: string }) {
  return (
    <InputGroup className={cn('bg-card', className)}>
      <InputGroupInput type="search" value={words} onChange={(event) => onWords(event.target.value)} placeholder={label} aria-label={label} className="text-base md:text-base" />
      <InputGroupAddon><SearchIcon aria-hidden="true" className="size-4.5" /></InputGroupAddon>
    </InputGroup>
  )
}

/**
 * One status tab: a link to its address (Back brings the last tab back; the area, the closed choice and the words go
 * with it), its words and its count. The one shown is `aria-current="true"`: the bar's Requests is the current page.
 */
function StatusTab({ status, label, count, current }: { status: CardGroupId | null; label: string; count: number; current: boolean }) {
  const href = useRequestsHref({ status })
  return (
    <a href={href} aria-current={current ? 'true' : undefined} data-status-tab={status ?? 'all'} onClick={placeLinkPress(() => useStore.getState().showRequests({ status }))}
      className="-mb-px inline-flex min-h-11 items-center gap-2 rounded-sm border-b-2 border-transparent px-0.5 py-1.5 text-place whitespace-nowrap text-muted-foreground outline-none transition-colors hover:text-place-active-foreground focus-visible:ring-3 focus-visible:ring-ring/50 aria-[current=true]:border-place-active-foreground aria-[current=true]:text-place-active-foreground">
      {label}
      <span className="rounded-md bg-muted px-1.5 py-0.5 text-xs text-muted-foreground tabular">{count}</span>
    </a>
  )
}

/**
 * The status tabs (Codex's `.tabs`): All, then each group of the boards' one list (CARD_GROUPS), each with how many
 * requests it holds in this view (the area and closed choices applied, not the words in the find box). The one shown
 * is marked by its words' colour and the line under it.
 */
function StatusTabs({ countOf, current }: { countOf: (tab: RequestsTab) => number; current: CardGroupId | null }) {
  const { t } = useI18n()
  return (
    <nav aria-label={t('Status')} className="flex flex-wrap items-stretch gap-x-5 border-b border-border">
      <StatusTab status={null} label={t('All')} count={countOf('all')} current={current === null} />
      {CARD_GROUPS.map((group) => <StatusTab key={group.id} status={group.id} label={t(group.label)} count={countOf(group.id)} current={current === group.id} />)}
    </nav>
  )
}

/** The Select's value for every area (null in the store, none in the address); an area's value is its RequestsArea. */
const EVERY_AREA = 'every'

/**
 * Filter and sort (Codex's button): which focus area (every one, or one the requests sit in, named as the rows name
 * it), the closed requests instead of the open ones (only when there are some, as the board's Closed filter was), and
 * the boards' sorts. The button counts the choices that hide requests, in words for a screen reader. An area and the
 * closed choice are history entries (Back takes the last one back); the sort is the saved display preference.
 */
function FilterAndSort({ areas, area, closedExist, closed }: {
  areas: { value: RequestsArea; label: string }[]; area: RequestsArea | null; closedExist: boolean; closed: boolean
}) {
  const { t } = useI18n()
  const id = useId()
  const sort = useStore((state) => state.view.sort)
  const setSort = useStore((state) => state.setSort)
  const hiding = (area !== null ? 1 : 0) + (closed ? 1 : 0)
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" data-filter-and-sort="">
          <ListFilterIcon aria-hidden="true" />{t('Filter and sort')}
          {hiding > 0 && (
            <>
              <span aria-hidden="true" data-filter-count="" className="rounded-md bg-muted px-1.5 py-0.5 text-xs text-muted-foreground tabular">{hiding}</span>
              <span className="sr-only">{interpolate(t(hiding === 1 ? '{count} choice hides requests' : '{count} choices hide requests'), { count: hiding })}</span>
            </>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 gap-4">
        <div className="grid gap-1.5">
          <Label htmlFor={`${id}-area`}>{t('Focus area')}</Label>
          <Select value={area ?? EVERY_AREA} onValueChange={(choice) => useStore.getState().showRequests({ area: choice === EVERY_AREA ? null : choice })}>
            <SelectTrigger id={`${id}-area`} className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value={EVERY_AREA}>{t('Every focus area')}</SelectItem>
              {areas.map((choice) => <SelectItem key={choice.value} value={choice.value}>{choice.label}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        {(closedExist || closed) && (
          <div className="flex items-center justify-between gap-3">
            <Label htmlFor={`${id}-closed`}>{t('Closed requests only')}</Label>
            <Switch id={`${id}-closed`} checked={closed} onCheckedChange={(next) => useStore.getState().showRequests({ closed: next })} />
          </div>
        )}
        <Req ids={['R4.2']}>
          <div className="grid gap-1.5">
            <Label htmlFor={`${id}-sort`}>{t('Sort')}</Label>
            <Select value={sort} onValueChange={(next) => setSort(next as SortKey)}>
              <SelectTrigger id={`${id}-sort`} className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>{SORTS.map(({ value, label }) => <SelectItem key={value} value={value}>{t(label)}</SelectItem>)}</SelectContent>
            </Select>
          </div>
        </Req>
      </PopoverContent>
    </Popover>
  )
}

/**
 * Requests' h1 (App.tsx gives it `data-view-heading`): where focus goes once the last unreadable request is dismissed,
 * and when the list and By agent change places.
 */
const focusViewHeading = (options?: FocusOptions) => document.querySelector<HTMLElement>('[data-view-heading]')?.focus(options)

/** Whether a request sits under a status tab: All holds every one, a group's tab the states of its group. */
const underTab = (tab: RequestsTab) => (request: Request) => tab === 'all' || CARD_GROUPS.some((group) => group.id === tab && group.states.includes(request.state))

/**
 * What the list or By agent says when it has nothing to show (R12.1): that no request is recorded yet, unless the
 * worker could not read the saved work (the alert over the page says so, and nothing more is said under it); that the
 * words match nothing; or that nothing is in this view.
 */
function RequestsEmpty({ words = null }: { words?: string | null }) {
  const { t } = useI18n()
  const { requests, requestReadErrors, sourceHealth } = useWorkModel()
  const noneRecorded = requests.length === 0 && requestReadErrors.length === 0
  if (noneRecorded && !sourceHealth.connected) return null
  return (
    <Req ids={['R12.1']}>
      <Empty className="border bg-card/60">
        <EmptyHeader>
          <EmptyMedia variant="icon"><InboxIcon /></EmptyMedia>
          {noneRecorded
            ? <><EmptyTitle>{t('No requests recorded yet.')}</EmptyTitle><EmptyDescription>{t('Ask an agent for something and it appears here.')}</EmptyDescription></>
            : words !== null
              ? <EmptyTitle>{interpolate(t('No request here matches “{words}”.'), { words })}</EmptyTitle>
              : <><EmptyTitle>{t('Nothing here')}</EmptyTitle><EmptyDescription>{t('No requests match. New work shows up as soon as an agent writes it.')}</EmptyDescription></>}
        </EmptyHeader>
      </Empty>
    </Req>
  )
}

/**
 * The list (Codex's `requests`, `requests-working`, `requests-idle`): how many requests the tab holds, the find box,
 * Filter and sort and By agent, the status tabs, the requests that could not be read, then the rows (with Team view
 * on, the Team board's columns). The tab, the area, the closed choice and the words are the address's
 * (store/slices/view-slice.ts), so they stay while a request is open over the page, and Back brings them back.
 */
function RequestsList() {
  const { t } = useI18n()
  const { requests, requestReadErrors, focusAreas } = useWorkModel()
  const status = useStore((state) => state.view.requestsStatus)
  const area = useStore((state) => state.view.requestsArea)
  const closed = useStore((state) => state.view.requestsClosed)
  const words = useStore((state) => state.view.requestsWords) ?? ''
  const sort = useStore((state) => state.view.sort)
  const { team } = useWorkspace()
  const openRequestDrawer = useStore((state) => state.openRequestDrawer)
  const byAgentHref = useRequestsHref({ by: 'agent' })
  const areaOf = useMemo(() => requestsAreaOf(focusAreas), [focusAreas])
  // The places the requests sit in, each named as its rows name it.
  const areas = useMemo(() => requestsAreaChoices(requests, focusAreas)
    .map((choice) => ({ value: choice, label: focusAreaPlaceWords(choice === NOT_SORTED_AREA ? undefined : choice, focusAreas, t) })), [requests, focusAreas, t])
  const inView = useMemo(() => requests.filter((request) => !!request.closed === closed && (area === null || areaOf(request) === area)), [requests, closed, area, areaOf])
  const countOf = (tab: RequestsTab) => inView.filter(underTab(tab)).length
  const searching = words.trim() !== ''
  const shown = useMemo(() => {
    const inTab = inView.filter(underTab(status ?? 'all'))
    return sortRequests(searching ? inTab.filter((request) => matchesWords(words, request.title ?? request.resolvesTo?.title, request.summary)) : inTab, sort)
  }, [inView, status, searching, words, sort])
  const count = countOf(status ?? 'all')
  const lead = status === null && area === null && !closed
    ? interpolate(t(count === 1 ? '{count} request across your workspace.' : '{count} requests across your workspace.'), { count })
    : interpolate(t(count === 1 ? '{count} request.' : '{count} requests.'), { count })
  // What a screen reader hears as the words change: how many rows match. One region, mounted with the page.
  const heard = !searching ? '' : interpolate(t(shown.length === 1 ? '{count} result' : '{count} results'), { count: shown.length })
  return (
    <div className="space-y-5 md:space-y-6">
      <LeadLine>{lead}</LeadLine>
      <div className="flex flex-wrap items-center gap-2.5">
        <FindBox label={t('Find a request')} words={words} onWords={(next) => useStore.getState().setRequestsWords(next)} className="basis-full md:basis-0 md:flex-1" />
        <FilterAndSort areas={areas} area={area} closedExist={requests.some((request) => request.closed)} closed={closed} />
        <Req ids={['R4.3']}>
          <Button asChild variant="outline">
            <a href={byAgentHref} onClick={placeLinkPress(() => useStore.getState().showRequests({ by: 'agent' }))}><UsersIcon aria-hidden="true" />{t('By agent')}</a>
          </Button>
        </Req>
      </div>
      <StatusTabs countOf={countOf} current={status} />
      {/* Requests that could not be read, once, at the top of the list. */}
      <RequestReadErrors readErrors={requestReadErrors} onAllDismissed={() => focusViewHeading()} />
      {/* Every paged list starts on its first page again when the tab, the words, a choice or the sort changes. */}
      <PagingResetContext.Provider value={JSON.stringify([status, words, area, closed, sort])}>
        <div data-board-view={team ? 'team' : 'list'}>
          {shown.length === 0 ? <RequestsEmpty words={searching ? words.trim() : null} />
            : team ? <TeamBoard requests={shown} grouped={status === null && sort === 'attention' && !searching} onOpen={openRequestDrawer} />
              : <RequestListRows requests={shown} onOpen={openRequestDrawer} />}
        </div>
      </PagingResetContext.Provider>
      <p role="status" data-requests-heard="" className="sr-only">{heard}</p>
    </div>
  )
}

/**
 * By agent (Codex's `by-agent`; the crumb back to Requests is App.tsx's): what to do here, a find box for an agent or
 * session and the way back to the list, the requests that could not be read, then the open requests under their
 * agents (ByAgentView), or what the page says when there is nothing to show.
 */
function RequestsByAgent() {
  const { t } = useI18n()
  const { requests, requestReadErrors } = useWorkModel()
  const openRequestDrawer = useStore((state) => state.openRequestDrawer)
  const listHref = useRequestsHref({})
  const [words, setWords] = useState('')
  const open = useMemo(() => requests.filter((request) => !request.closed), [requests])
  return (
    <div className="space-y-5 md:space-y-6">
      <LeadLine>{t('Open an agent to see its requests.')}</LeadLine>
      <div className="flex flex-wrap items-center gap-2.5">
        <FindBox label={t('Find an agent or session')} words={words} onWords={setWords} className="basis-full md:basis-0 md:flex-1" />
        <Button asChild variant="outline">
          <a href={listHref} onClick={placeLinkPress(() => useStore.getState().showRequests({}))}><ListIcon aria-hidden="true" />{t('Request list')}</a>
        </Button>
      </div>
      {/* Requests that could not be read, once, above the agents. */}
      <RequestReadErrors readErrors={requestReadErrors} onAllDismissed={() => focusViewHeading()} />
      <PagingResetContext.Provider value={words}>
        <div data-board-view="agents"><ByAgentView requests={open} words={words} empty={<RequestsEmpty />} onOpen={openRequestDrawer} /></div>
      </PagingResetContext.Provider>
    </div>
  )
}

/**
 * The list and By agent take each other's place (By agent, Request list, the crumb, Back), and the control pressed
 * goes with the layout it sat in, so focus would fall to the page body (WCAG 2.4.3). The view's heading takes it
 * instead, and a screen reader hears where it now is ("Requests by agent"). Not on the page's first draw: a page opened
 * from the bar keeps focus on the bar. The window stays where the move scrolled it (Back: where it was left).
 */
function useHeadingTakesFocusWhenLayoutChanges(by: RequestsGrouping | null) {
  const shown = useRef(by)
  useEffect(() => {
    if (shown.current === by) return
    shown.current = by
    if (document.activeElement === null || document.activeElement === document.body) focusViewHeading({ preventScroll: true })
  }, [by])
}

/**
 * Requests (`?view=requests`): the list, or By agent. When the worker answered but could not read the saved work, that
 * comes first, with Try again (the home page's same alert).
 */
export function Requests() {
  useI18n()
  const { sourceHealth } = useWorkModel()
  const by = useStore((state) => state.view.requestsBy)
  useHeadingTakesFocusWhenLayoutChanges(by)
  return (
    <div className="space-y-5 md:space-y-6">
      {!sourceHealth.connected && <SourceReadAlert error={sourceHealth.error} />}
      {by === 'agent' ? <RequestsByAgent /> : <RequestsList />}
    </div>
  )
}
