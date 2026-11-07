import { useMemo, useRef, useState, type ReactNode } from 'react'
import { useReducedMotion } from 'motion/react'
import { ArrowRightIcon, ArrowUpDownIcon, ImageIcon, InboxIcon, PlugIcon, TriangleAlertIcon } from 'lucide-react'
import { Agent, AgentContent, AgentHeader } from '@/components/ai-elements/agent'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button, buttonVariants } from '@/components/ui/button'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { ActivePill, AgentIcon, ATTENTION_ORDER, FocusAreaChip, NextMove, ProgressMeter, RefreshButton, RefreshStatus, STATE_LABEL, STATE_SURFACE, StateBadge } from '@/components/bits'
import { PointerHighlight } from '@/components/aceternity/pointer-highlight'
import { TracingBeam } from '@/components/aceternity/tracing-beam'
import { AgentMark } from '@/components/brand'
import { FocusChangeBar, useFocusChanges } from '@/components/focus-changes'
import { FocusHeader, OtherHeader } from '@/components/focus-header'
import { RequestCard } from '@/components/request-card'
import { SplitFlapText } from '@/components/split-flap'
import { SaveButton } from '@/components/save-button'
import { useMatchesMedia } from '@/lib/use-media'
import { cn } from '@/lib/utils'
import { Req } from '@/spec/req'
import { needsYou, OTHER_FOCUS_AREA_ID, SAMPLE_RUNS, startedTimestamp, type Agent as WorkAgent, type LiveState, type Request } from '@/data'
import { type WorkFilter, type WorkListView, type WorkSort, deviceById, useStore, useWorkModel, useWorkspace } from '@/store'
import { useShallow } from 'zustand/react/shallow'
import type { BuildStory, RequestReadError } from '@/live/work-data-source'
import { resolveFocusAreaId } from '@/live/to-focus-model'

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
const FILTERS: { value: Filter; label: string; matches: (request: Request) => boolean; dot?: string }[] = [
  { value: 'all', label: 'All', matches: (request) => !request.closed },
  { value: 'needs-you', label: 'Needs you', matches: (request) => !request.closed && needsYou(request), dot: 'bg-attention-foreground' },
  { value: 'shipped', label: 'Shipped', matches: (request) => !request.closed && request.state === 'shipped', dot: 'bg-shipped-foreground' },
  { value: 'closed', label: 'Closed', matches: (request) => !!request.closed },
]
const SORTS: { value: SortKey; label: string }[] = [
  { value: 'attention', label: 'Needs you first' },
  { value: 'started', label: 'Newest' },
  { value: 'progress', label: 'Most progress' },
]
const titleOf = (request: Request) => request.title ?? request.resolvesTo?.title ?? 'New request, title being written'

/** Attention first by default (your move, then to check, then working, idle, shipped); newest first within a state. */
function sortRequests(requests: Request[], sort: SortKey) {
  const newest = (a: Request, b: Request) => startedTimestamp(b) - startedTimestamp(a)
  return [...requests].sort((a, b) =>
    sort === 'progress' ? (b.progress.percent ?? -1) - (a.progress.percent ?? -1) || newest(a, b)
      : sort === 'started' ? newest(a, b)
        : ATTENTION_ORDER.indexOf(a.state) - ATTENTION_ORDER.indexOf(b.state) || newest(a, b))
}

/** One actionable sentence that leads the page (§12): what needs you is a link straight to it. */
function Summary({ requests, onOpen, onShowNeedsYou }: { requests: Request[]; onOpen: (request: Request) => void; onShowNeedsYou: () => void }) {
  const yourMove = requests.filter((request) => request.state === 'your-move')
  const toCheck = requests.filter((request) => request.state === 'needs-check')
  const working = requests.filter((request) => request.state === 'working').length
  const first = yourMove[0] ?? toCheck[0]
  const waiting = yourMove.length + toCheck.length
  const reduceMotion = useReducedMotion()
  return (
    <Req ids={['R12.2', 'R12.3', 'R1.1']}>
      <div className="space-y-0.5">
        <p className="flex flex-wrap items-center gap-x-2 text-[0.95rem] leading-snug md:text-base">
          {first ? (
            <>
              <span className="font-semibold">{waiting === 1 ? 'One thing needs you:' : `${waiting} need you. First:`}</span>
              <button type="button" onClick={() => onOpen(first)} className="inline-flex min-h-11 items-center gap-1 text-left font-semibold text-attention-foreground underline decoration-attention-border underline-offset-4 hover:decoration-current md:min-h-8">
                {reduceMotion ? first.next.text : <PointerHighlight rectangleClassName="rounded-sm border-attention-border" pointerClassName="text-attention-foreground">{first.next.text}</PointerHighlight>}<ArrowRightIcon className="size-4 shrink-0" />
              </button>
            </>
          ) : <span className="font-semibold">Nothing needs you right now.</span>}
        </p>
        <p className="flex flex-wrap items-center gap-x-1.5 text-sm text-muted-foreground">
          <span>{working} working{toCheck.length ? ` · ${toCheck.length} waiting for your check` : ''}</span>
          {waiting > 1 && <>·<button type="button" onClick={onShowNeedsYou} className="min-h-11 underline underline-offset-4 hover:text-foreground md:min-h-6">Show all {waiting}</button></>}
        </p>
      </div>
    </Req>
  )
}

/** The build story's recap, after the work: its first paragraph, plus the hero image and sync funnel in the sample (§7, §8). */
function TodayPanel({ story, onOpenStory }: { story: BuildStory; onOpenStory: () => void }) {
  const { mode, connected } = useWorkspace()
  // The daily recap image is not generated from real records yet, so live mode leaves its slot out.
  const sample = useWorkModel().sourceKind === 'sample'
  return (
    <div className={cn('grid gap-4 rounded-xl border bg-card/70 p-4 shadow-panel md:p-5', sample && 'sm:grid-cols-[132px_1fr]')}>
      {sample && (
        <Req ids={['R7.4']}>
          <div className="flex aspect-[3/1] items-center justify-center rounded-lg border border-dashed bg-surface text-muted-foreground sm:aspect-square"><ImageIcon className="size-5" /><span className="sr-only">Today's hero image (not generated in the wireframe)</span></div>
        </Req>
      )}
      <div className="min-w-0 space-y-3">
        <Req ids={['R7.1', 'R7.2']}>
          <div className="space-y-1">
            <p className="section-label">{story.writtenAt ? `Build story · ${story.writtenAt}` : 'Build story'}</p>
            <p className="text-sm">{story.recap}</p>
            <Button variant="link" className="h-11 p-0 text-sm text-accent-foreground md:h-auto" onClick={onOpenStory}>Read the build story</Button>
          </div>
        </Req>
        {sample && mode === 'home' && !connected && (
          <Req ids={['R8.2']}>
            <div className="flex flex-wrap items-center gap-2 border-t border-border/70 pt-3 text-sm">
              <PlugIcon className="size-4 text-muted-foreground" />
              <span className="mr-auto text-muted-foreground">See this on your phone, and in Claude.ai and ChatGPT.</span>
              <Button size="sm" variant="outline" className="h-11 md:h-8">Connect Claude.ai</Button>
              <Button size="sm" variant="outline" className="h-11 md:h-8">Connect ChatGPT</Button>
            </div>
          </Req>
        )}
      </div>
    </div>
  )
}

/** Shipping velocity, the narrative, and the preferences it found (§7). Preferences are the same records My Rules shows. */
function StorySheet({ open, story, requests, onClose, onOpenRules }: { open: boolean; story: BuildStory; requests: Request[]; onClose: () => void; onOpenRules: () => void }) {
  const shipped = requests.filter((request) => request.state === 'shipped').length
  const waiting = requests.filter(needsYou).length
  const { rules } = useWorkModel()
  const learned = rules.filter((rule) => rule.source === 'request-progress' && (rule.status === 'on' || rule.status === 'suggested')).slice(0, 4)
  // The sheet scrolls, not the window, so the tracing beam follows the sheet's scroll.
  const scrollRef = useRef<HTMLDivElement>(null)
  return (
    <Sheet open={open} onOpenChange={(next) => { if (!next) onClose() }}>
      <SheetContent ref={scrollRef} className="overflow-y-auto data-[side=right]:w-full data-[side=right]:sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>Build story</SheetTitle>
          <SheetDescription>From request-progress, reviewed from memory{story.writtenAt ? `, written ${story.writtenAt}` : ''}.</SheetDescription>
        </SheetHeader>
        <TracingBeam scrollContainer={scrollRef} className="pr-4 pb-6 pl-10">
        <div className="space-y-6">
          <Req ids={['R7.1']}>
            <p className="text-sm">{shipped} request{shipped === 1 ? '' : 's'} shipped and {waiting} waiting on you.</p>
          </Req>
          <Req ids={['R7.2']}>
            <div className="space-y-3">{story.paragraphs.map((paragraph, index) => <p key={index} className="text-sm text-muted-foreground">{paragraph}</p>)}</div>
          </Req>
          <Req ids={['R7.3']}>
            <div className="space-y-2">
              <h4 className="section-label">What it learned about how you work</h4>
              {learned.length === 0 && <p className="text-sm text-muted-foreground">No preferences learned yet.</p>}
              <ul className="space-y-2">
                {learned.map((rule) => (
                  <li key={rule.id} className="text-sm">
                    {rule.when ? <>When {rule.when}: {rule.then}</> : rule.then}
                    {rule.status === 'suggested' && <span className="ml-1.5 text-xs text-muted-foreground">· suggested, not approved yet</span>}
                  </li>
                ))}
              </ul>
              <Button variant="outline" className="h-11 md:h-9" onClick={onOpenRules}>Review in My Rules</Button>
            </div>
          </Req>
        </div>
        </TracingBeam>
      </SheetContent>
    </Sheet>
  )
}

/** card-hover-effect, in place: a soft panel fades in behind the card the pointer is on. It never slides between cards. */
function HoverCell({ children }: { children: ReactNode }) {
  return (
    <div className="group/hover-cell relative min-w-0">
      <span aria-hidden="true" className="pointer-events-none absolute -inset-2 block rounded-2xl bg-accent/70 opacity-0 transition-opacity duration-150 group-hover/hover-cell:opacity-100" />
      <div className="relative h-full">{children}</div>
    </div>
  )
}

/**
 * The List is a departures board (decision 2, R4.4): each status is a line of split-flap tiles exactly as wide as its
 * label, colored by its state. It riffles in when the List opens and again when the status changes, then stops.
 */
function FlipStatus({ state }: { state: LiveState }) {
  return <SplitFlapText text={STATE_LABEL[state]} tileClassName={STATE_SURFACE[state]} />
}

// The List switches from stacked lines to the table at Tailwind's md breakpoint (768px); only one of them is built.
const TABLE_QUERY = '(min-width: 768px)'

function ListView({ requests, sort, onSort, onOpen, onOpenFocus }: { requests: Request[]; sort: SortKey; onSort: (sort: SortKey) => void; onOpen: (request: Request) => void; onOpenFocus: (focusAreaId: string) => void }) {
  const { team } = useWorkspace()
  const wide = useMatchesMedia(TABLE_QUERY)
  const sortHead = (label: string, value: SortKey) => (
    <TableHead aria-sort={sort === value ? 'descending' : undefined}>
      <Button variant="ghost" size="sm" className="-ml-3 h-8 text-[0.82rem] font-medium text-muted-foreground" onClick={() => onSort(value)}>{label}<ArrowUpDownIcon className={sort === value ? '' : 'opacity-30'} /></Button>
    </TableHead>
  )
  return (
    <Req ids={['R4.2', 'R4.4', 'R2.1', 'R5.8', 'R11.1']}>
      {/* Phones: stacked rows, request then status then next step. */}
      {!wide && <ul className="divide-y rounded-xl border bg-card shadow-panel">
        {requests.map((request) => (
          <li key={request.id}>
            <button type="button" onClick={() => onOpen(request)} className="flex w-full flex-col gap-2 p-4 text-left focus-visible:outline-2 focus-visible:outline-ring">
              <span className="flex w-full items-start gap-2.5">
                <AgentIcon agentId={request.agentId} />
                <span className={cn('min-w-0 flex-1 pt-0.5 text-[0.95rem] leading-snug font-medium', !request.title && 'text-muted-foreground')}>{titleOf(request)}</span>
              </span>
              <span className="flex flex-col items-start gap-1.5 pl-[38px]">
                <FlipStatus state={request.state} />
                <NextMove next={request.next} />
              </span>
            </button>
          </li>
        ))}
      </ul>}

      {wide && <div className="overflow-hidden rounded-xl border bg-card shadow-panel">
        <Table>
          <TableHeader className="bg-surface/60">
            <TableRow>
              <TableHead className="w-10"><span className="sr-only">Agent</span></TableHead>
              <TableHead>Request</TableHead>
              {team && <TableHead>Asked by</TableHead>}
              {sortHead('Status', 'attention')}
              <TableHead>Next step</TableHead>
              {sortHead('Progress', 'progress')}
              {sortHead('Started', 'started')}
            </TableRow>
          </TableHeader>
          <TableBody>
            {requests.map((request) => (
              <TableRow key={request.id} className="cursor-pointer" onClick={() => onOpen(request)}>
                <TableCell className="align-top"><AgentIcon agentId={request.agentId} /></TableCell>
                <TableCell className="max-w-72 align-top whitespace-normal">
                  <button type="button" onClick={(event) => { event.stopPropagation(); onOpen(request) }} className={cn('rounded-sm text-left leading-snug font-medium hover:underline focus-visible:outline-2 focus-visible:outline-ring', !request.title && 'text-muted-foreground')}>{titleOf(request)}</button>
                  <div><FocusAreaChip focusAreaId={request.focusAreaId} onOpen={onOpenFocus} /></div>
                </TableCell>
                {team && <TableCell className="align-top text-sm">{request.askedBy}</TableCell>}
                <TableCell className="align-top"><FlipStatus state={request.state} /></TableCell>
                <TableCell className="max-w-64 align-top whitespace-normal"><NextMove next={request.next} /></TableCell>
                <TableCell className="w-32 align-top"><ProgressMeter request={request} compact /></TableCell>
                <TableCell className="align-top text-xs text-muted-foreground"><time dateTime={request.startedAtIso}>{request.startedAt}</time></TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>}
    </Req>
  )
}

const AGENT_STATUS_LABEL: Record<NonNullable<WorkAgent['status']>, string> = { working: 'Working', quiet: 'No recent step', finished: 'Finished' }

/**
 * A subagent's recorded state. Finished only on a recorded stop; a quiet subagent stays quiet, never guessed done.
 * One that finished before stops were recorded can be marked finished by the owner (saved as a work-state row).
 */
function SubagentStatus({ agent }: { agent: WorkAgent }) {
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (!agent.status) return null
  // Resolves false on failure so the button shows no check; the error line below says what went wrong.
  const mark = async () => {
    setSaving(true)
    setError(null)
    try {
      await useStore.getState().markAgentFinished(agent.id)
      return true
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
      return false
    } finally {
      setSaving(false)
    }
  }
  return (
    <div className="space-y-1 px-3 pb-2">
      <div className="flex min-h-9 items-center justify-between gap-2 text-xs">
        <span className={cn('text-muted-foreground', agent.status === 'finished' && 'text-shipped-foreground')}>
          {AGENT_STATUS_LABEL[agent.status]}{agent.status === 'finished' && agent.finishedAt ? ` · ${agent.finishedAt}` : ''}
        </span>
        {agent.canMarkFinished && (
          <SaveButton className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'h-11 shrink-0 text-xs md:h-7')} disabled={saving} onClick={mark}>
            Mark finished
          </SaveButton>
        )}
      </div>
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    </div>
  )
}

/** One card per running agent: its mark, its role and machine, so two agents of one tool are told apart (§4, §13.2). */
function ByAgentView({ requests, onOpen }: { requests: Request[]; onOpen: (request: Request) => void }) {
  const { agents } = useWorkModel()
  return (
    <Req ids={['R4.3', 'R13.2', 'R13.4']}>
      <div className="grid min-w-0 items-start gap-4 md:grid-cols-2 xl:grid-cols-3">
        {agents.map((agent) => {
          const device = deviceById(agent.deviceId)
          const theirs = requests.filter((request) => request.agentId === agent.id)
          return (
            <HoverCell key={agent.id}>
            <Agent className="min-w-0">
              <AgentHeader name={agent.name} role={agent.role} icon={<AgentMark tool={agent.tool} className="size-5" />}
                model={`${device.name} · ${device.syncedMinutesAgo === 0 ? 'this machine' : `synced ${device.syncedMinutesAgo} min ago`}`} />
              <AgentContent className="space-y-0 px-2 pb-2">
                <SubagentStatus agent={agent} />
                {theirs.length === 0 && <p className="px-3 pb-3 text-sm text-muted-foreground">Nothing on it in this view.</p>}
                {theirs.map((request) => (
                  <button key={request.id} type="button" onClick={() => onOpen(request)} className="flex w-full min-w-0 flex-col gap-1.5 rounded-lg px-3 py-2.5 text-left hover:bg-surface focus-visible:outline-2 focus-visible:outline-ring">
                    <span className="flex w-full min-w-0 items-start justify-between gap-2">
                      <span className={cn('min-w-0 text-sm leading-snug font-medium', !request.title && 'text-muted-foreground')}>{titleOf(request)}</span>
                      <StateBadge state={request.state} />
                    </span>
                    <NextMove next={request.next} className="text-xs" />
                  </button>
                ))}
              </AgentContent>
            </Agent>
            </HoverCell>
          )
        })}
      </div>
    </Req>
  )
}

/** TeamBrain on the same GUI: one column per person, with collisions called out (§9). */
function TeamBoard({ requests, onOpen }: { requests: Request[]; onOpen: (request: Request) => void }) {
  const { sourceKind, people } = useWorkModel()
  return (
    <Req ids={['R9.2', 'R9.1', 'R9.3']}>
      <div className="space-y-4">
        {sourceKind === 'sample' && (
          <Alert className="border-attention-border bg-attention text-attention-foreground">
            <TriangleAlertIcon />
            <AlertTitle>Possible collision (sample)</AlertTitle>
            <AlertDescription className="text-attention-foreground">Alex and Priya both have agents changing the price forecast page.</AlertDescription>
          </Alert>
        )}
        <div className="grid gap-4 md:grid-cols-3">
          {people.map((person) => (
            <div key={person} className="space-y-2.5 rounded-xl border bg-card/60 p-4 shadow-panel">
              <p className="section-label">{person}</p>
              {requests.filter((request) => request.askedBy === person).map((request) => (
                <button key={request.id} type="button" onClick={() => onOpen(request)} className="w-full space-y-2 rounded-lg border bg-card p-3 text-left hover:bg-surface">
                  <p className="text-sm leading-snug">{titleOf(request)}</p>
                  <div className="flex items-center justify-between gap-2"><AgentIcon agentId={request.agentId} /><StateBadge state={request.state} /></div>
                </button>
              ))}
            </div>
          ))}
        </div>
      </div>
    </Req>
  )
}

/** A request whose records disagree with the lifecycle rules: its own card, with the reason and its source (plan R3). */
function RequestReadErrorCard({ readError }: { readError: RequestReadError }) {
  return (
    <Req ids={['R12.1']}>
      <Alert className="h-full border-attention-border bg-card">
        <TriangleAlertIcon />
        <AlertTitle className="line-clamp-none">Couldn't read this request: {readError.reason}</AlertTitle>
        <AlertDescription>
          {readError.title && <p>{readError.title}</p>}
          {readError.evidenceHref && <a href={readError.evidenceHref} target="_blank" rel="noreferrer" className="underline underline-offset-4 hover:text-foreground">Open the prompt it came from</a>}
        </AlertDescription>
      </Alert>
    </Req>
  )
}

/**
 * My Work: the live inbox. With a focus area (or Other) selected, its header comes first and only the requests in it
 * show; requests not sorted yet ("Sorting…") show only under every request.
 */
export function MyWork({ focusAreaId, onOpen, onOpenFocus, onOpenRules }: { focusAreaId: string | null; onOpen: (request: Request) => void; onOpenFocus: (focusAreaId: string) => void; onOpenRules: () => void }) {
  const { team } = useWorkspace()
  const { sourceKind, requests: allRequests, requestReadErrors: allReadErrors, unlinkedWorkCount, sourceHealth, buildStory, lastRuns, refresh, focusAreas } = useWorkModel()
  const area = focusAreaId && focusAreaId !== OTHER_FOCUS_AREA_ID ? focusAreas.find((entry) => entry.id === focusAreaId) ?? null : null
  const requests = useMemo(() => focusAreaId ? allRequests.filter((request) => resolveFocusAreaId(request.focusAreaId, focusAreas) === focusAreaId) : allRequests, [allRequests, focusAreas, focusAreaId])
  // A request that could not be read has no placement to file it under, so its card shows only under every request.
  const requestReadErrors = focusAreaId ? [] : allReadErrors
  const focusChanges = useFocusChanges()
  const sample = sourceKind === 'sample'
  // How the person likes to see My Work is saved across visits (store/create-store.ts).
  const { listView: view, filter, sort } = useStore(useShallow((state) => ({ listView: state.view.listView, filter: state.view.filter, sort: state.view.sort })))
  const { setListView: setView, setFilter, setSort } = useStore.getState()
  const [storyOpen, setStoryOpen] = useState(false)
  const matches = FILTERS.find((entry) => entry.value === filter)!.matches
  const visible = useMemo(() => sortRequests(requests.filter(matches), sort), [requests, matches, sort])

  return (
    <div className="space-y-4 md:space-y-5">
      {!sourceHealth.connected && (
        <Alert className="border-attention-border bg-attention text-attention-foreground">
          <TriangleAlertIcon />
          <AlertTitle>Can't read local work right now</AlertTitle>
          {sourceHealth.error && <AlertDescription className="text-attention-foreground">{sourceHealth.error}</AlertDescription>}
        </Alert>
      )}
      <FocusChangeBar changes={focusChanges} />
      {/* Every request in the area, closed ones too: the combined progress counts each reviewed request (D1's rule). */}
      {area ? <FocusHeader key={area.id} area={area} requests={requests} changes={focusChanges} />
        : focusAreaId === OTHER_FOCUS_AREA_ID && <OtherHeader requests={requests} />}
      <Summary requests={requests.filter((request) => !request.closed)} onOpen={onOpen} onShowNeedsYou={() => setFilter('needs-you')} />

      <div className="flex flex-wrap items-center gap-2 md:gap-3">
        <Req ids={['R4.1', 'R4.2', 'R4.3', 'R9.2']}>
          <ToggleGroup type="single" variant="outline" size="sm" spacing={1} value={view} onValueChange={(next) => next && setView(next as View)} aria-label="View">
            {VIEWS.filter((entry) => entry.value !== 'team' || team).map(({ value, label }) => (
              <ToggleGroupItem key={value} value={value} className="relative h-11 px-3.5 data-[state=on]:bg-transparent data-[state=on]:hover:bg-transparent md:h-8">
                {view === value && <ActivePill layoutId="view-toggle-active-pill" />}
                <span className="relative">{label}</span>
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </Req>
        {/* Live mode shows the worker's automatic refresh, or the last review before its first run. No cost. */}
        {sample ? (
          <div className="order-last w-full md:ml-auto md:w-auto">
            <RefreshButton run={SAMPLE_RUNS.progress} ids={['R14.12']} />
          </div>
        ) : (refresh || lastRuns.progress) && (
          <div className="order-last w-full md:ml-auto md:w-auto">
            <RefreshStatus refresh={refresh} run={lastRuns.progress} label="Last reviewed" ids={['R14.12']} />
          </div>
        )}
        {/* Phone: the filters wrap to a second row instead of widening the page past the screen; the sort stays beside them. */}
        <div className="flex w-full items-start gap-1 md:w-auto md:items-center">
          <ToggleGroup type="single" variant="outline" size="sm" spacing={1} value={filter} onValueChange={(next) => next && setFilter(next as Filter)} aria-label="Filter" className="min-w-0 flex-1 md:flex-none md:flex-nowrap">
            {FILTERS.filter((entry) => entry.value !== 'closed' || filter === 'closed' || requests.some(entry.matches)).map(({ value, label, dot, matches: test }) => (
              <ToggleGroupItem key={value} value={value} className="h-11 gap-1.5 px-3 md:h-8">
                {dot && <span className={cn('size-1.5 rounded-full', dot)} />}
                {label}
                <span className="text-muted-foreground tabular-nums group-data-[state=on]/toggle:text-accent-foreground">{requests.filter(test).length}</span>
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          {view !== 'agents' && view !== 'team' && (
            <Select value={sort} onValueChange={(next) => setSort(next as SortKey)}>
              <SelectTrigger aria-label="Sort" className="h-11 border-transparent bg-transparent px-2.5 text-[0.82rem] text-muted-foreground shadow-none data-[size=default]:h-11 md:h-8 md:data-[size=default]:h-8 [&>svg:last-child]:hidden sm:[&>svg:last-child]:inline"><ArrowUpDownIcon className="size-4" /><span className="hidden sm:inline"><SelectValue /></span></SelectTrigger>
              <SelectContent>{SORTS.map(({ value, label }) => <SelectItem key={value} value={value}>{label}</SelectItem>)}</SelectContent>
            </Select>
          )}
        </div>
      </div>

      {requests.length === 0 && requestReadErrors.length === 0 ? (
        <Req ids={['R12.1']}>
          <Empty className="border bg-card/60">
            <EmptyHeader>
              <EmptyMedia variant="icon"><InboxIcon /></EmptyMedia>
              <EmptyTitle>{focusAreaId ? 'No requests in this area yet.' : 'No requests recorded yet.'}</EmptyTitle>
              <EmptyDescription>{focusAreaId ? 'A refresh places new requests here, or move one here from its page.' : 'Ask an agent for something and it appears here.'}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        </Req>
      ) : visible.length === 0 && requestReadErrors.length === 0 ? (
        <Req ids={['R12.1']}>
          <Empty className="border bg-card/60">
            <EmptyHeader>
              <EmptyMedia variant="icon"><InboxIcon /></EmptyMedia>
              <EmptyTitle>Nothing here</EmptyTitle>
              <EmptyDescription>No requests match. New work shows up as soon as an agent writes it.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        </Req>
      ) : view === 'cards' ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {visible.map((request) => (
            <HoverCell key={request.id}>
              <RequestCard request={request} onOpen={() => onOpen(request)} onOpenFocus={onOpenFocus} />
            </HoverCell>
          ))}
          {requestReadErrors.map((readError) => <RequestReadErrorCard key={readError.requestId} readError={readError} />)}
        </div>
      ) : view === 'list' ? <ListView requests={visible} sort={sort} onSort={setSort} onOpen={onOpen} onOpenFocus={onOpenFocus} />
        : view === 'agents' ? <ByAgentView requests={visible} onOpen={onOpen} />
          : <TeamBoard requests={visible} onOpen={onOpen} />}
      {view !== 'cards' && requestReadErrors.length > 0 && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {requestReadErrors.map((readError) => <RequestReadErrorCard key={readError.requestId} readError={readError} />)}
        </div>
      )}
      {unlinkedWorkCount > 0 && (
        <p className="text-xs text-muted-foreground">{unlinkedWorkCount} work record{unlinkedWorkCount === 1 ? " isn't" : "s aren't"} linked to a request yet.</p>
      )}

      {/* The recap and the build story are written by request-progress; with no story, both are hidden. */}
      {buildStory && (
        <>
          <TodayPanel story={buildStory} onOpenStory={() => setStoryOpen(true)} />
          <StorySheet open={storyOpen} story={buildStory} requests={requests} onClose={() => setStoryOpen(false)} onOpenRules={() => { setStoryOpen(false); onOpenRules() }} />
        </>
      )}
    </div>
  )
}
