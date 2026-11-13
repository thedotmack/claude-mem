import { displayTime } from '@/lib/display-time'
import { t, useI18n, interpolate } from '@/lib/i18n'
import { useMemo, useRef, useState } from 'react'
import { motion } from 'motion/react'
import { InboxIcon, TriangleAlertIcon } from 'lucide-react'
import { Agent, AgentContent, AgentHeader } from '@/components/ai-elements/agent'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button, buttonVariants } from '@/components/ui/button'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { ActivePill, AgentIcon, ManualRefreshButton, NextMove, RefreshButton, RefreshStatus, StateBadge } from '@/components/bits'
import { TracingBeam } from '@/components/aceternity/tracing-beam'
import { AgentMark } from '@/components/brand'
import { FocusChangeBar, useFocusChanges } from '@/components/focus-changes'
import { FocusHeader, OtherHeader } from '@/components/focus-header'
import { PlanButton, PlanProposals } from '@/components/focus-plan'
import { FocusThreadViewSwitch, ThreadList } from '@/components/thread-list'
import { GLIDE, HoverCell } from '@/components/request-cards'
import { SaveButton } from '@/components/save-button'
import { cn } from '@/lib/utils'
import { Req } from '@/spec/req'
import { ATTENTION_ORDER, needsYou, OTHER_FOCUS_AREA_ID, SAMPLE_RUNS, type Agent as WorkAgent, type Request } from '@/data'
import { type WorkFilter, type WorkListView, deviceById, useStore, useWorkModel, useWorkspace } from '@/store'
import { WORK_FILTERS, WORK_LIST_VIEWS } from '@/store/store-types'
import { useShallow } from 'zustand/react/shallow'
import type { BuildStory, RequestReadError } from '@/live/work-data-source'
import { createFocusAreaResolver } from '@/live/to-focus-model'
import { FOCUS_ARRANGEMENTS, sortThreads, type FocusArrangement } from '@/live/thread-groups'
import { INITIATIVE_WORDS } from '@/live/initiative-words'
import { FILTER_MATCHES } from '@/live/work-filters'
import { FocusOverview } from '@/components/focus-overview'
import '@/components/focus-overview.css'

type View = WorkListView
/** The top level is the focuses, as lines that open onto their threads or as a card each. By agent and Team cut the requests by who, which only a team needs. */
const VIEW: Record<View, { label: string; teamOnly?: true; ofFocuses?: true }> = {
  threads: { label: 'Threads' },
  // A card per focus: with one focus open there is nothing to lay out, and that focus's own switch has its Cards.
  cards: { label: 'Cards', ofFocuses: true },
  agents: { label: 'By agent', teamOnly: true },
  team: { label: 'Team', teamOnly: true },
}
/** The focus list in the owner's order, or that order under the owner's own headings. */
const ARRANGEMENT: Record<FocusArrangement, string> = { priority: 'Priority', initiative: INITIATIVE_WORDS.name }
type Filter = WorkFilter
/** Open is everything that does not rest; Done (shipped, checked, closed) shows only when picked. */
const FILTER: Record<Filter, { label: string; dot?: string }> = {
  open: { label: 'Open work' },
  'needs-you': { label: 'Needs you', dot: 'bg-attention-foreground' },
  working: { label: 'Working', dot: 'bg-working-foreground motion-safe:animate-pulse' },
  done: { label: 'Done', dot: 'bg-shipped-foreground/50' },
}
const titleOf = (request: Request) => request.title ?? request.resolvesTo?.title ?? 'New request, title being written'

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
          <SheetTitle>{t("Build story")}</SheetTitle>
          <SheetDescription>{interpolate(t('From request-progress, reviewed from memory{writtenAt}.'), { writtenAt: story.writtenAt ? `, ${interpolate(t('written {date}'), { date: displayTime(story.writtenAt) })}` : '' })}</SheetDescription>
        </SheetHeader>
        <TracingBeam scrollContainer={scrollRef} className="pr-4 pb-6 pl-10">
        <div className="space-y-6">
          <Req ids={['R7.1']}>
            <p className="text-sm">{interpolate(t(shipped === 1 ? '{shipped} request shipped and {waiting} waiting on you.' : '{shipped} requests shipped and {waiting} waiting on you.'), { shipped: shipped, waiting: waiting })}</p>
          </Req>
          <Req ids={['R7.2']}>
            <div className="space-y-3">{story.paragraphs.map((paragraph, index) => <p key={index} className="text-sm text-muted-foreground">{paragraph}</p>)}</div>
          </Req>
          <Req ids={['R7.3']}>
            <div className="space-y-2">
              <h4 className="section-label">{t("What it learned about how you work")}</h4>
              {learned.length === 0 && <p className="text-sm text-muted-foreground">{t("No preferences learned yet.")}</p>}
              <ul className="space-y-2">
                {learned.map((rule) => (
                  <li key={rule.id} className="text-sm">
                    {rule.when ? interpolate(t('When {when}: {then}'), { when: rule.when, then: rule.then }) : rule.then}
                    {rule.status === 'suggested' && <span className="ml-1.5 text-xs text-muted-foreground">{t("· suggested, not approved yet")}</span>}
                  </li>
                ))}
              </ul>
              <Button variant="outline" className="h-11 md:h-9" onClick={onOpenRules}>{t("Review in My Rules")}</Button>
            </div>
          </Req>
        </div>
        </TracingBeam>
      </SheetContent>
    </Sheet>
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
          {t(AGENT_STATUS_LABEL[agent.status])}{agent.status === 'finished' && agent.finishedAt ? ` · ${displayTime(agent.finishedAt)}` : ''}
        </span>
        {agent.canMarkFinished && (
          <SaveButton className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'h-11 shrink-0 text-xs md:h-7')} disabled={saving} onClick={mark}>{t("Mark finished")}</SaveButton>
        )}
      </div>
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    </div>
  )
}

/** Each agent with its requests in this view, busiest first: most urgent request, then how many; idle agents last. */
function agentsByUrgency(agents: WorkAgent[], requests: Request[]) {
  const urgency = (theirs: Request[]) => theirs.length ? Math.min(...theirs.map((request) => ATTENTION_ORDER.indexOf(request.state))) : ATTENTION_ORDER.length
  return agents
    .map((agent, index) => ({ agent, index, theirs: requests.filter((request) => request.agentId === agent.id) }))
    .sort((a, b) => urgency(a.theirs) - urgency(b.theirs) || b.theirs.length - a.theirs.length || a.index - b.index)
}

/** One card per running agent: its mark, its role and machine, so two agents of one tool are told apart (§4, §13.2). */
function ByAgentView({ requests, onOpen }: { requests: Request[]; onOpen: (request: Request) => void }) {
  const { agents } = useWorkModel()
  return (
    <Req ids={['R4.3', 'R13.2', 'R13.4']}>
      {/* Masonry columns, so a short card never leaves a gap under a long one. Agents with work in this view come
          first, the one with the most urgent request on top; agents with nothing here go last. */}
      <div className="min-w-0 gap-4 md:columns-2 xl:columns-3">
        {agentsByUrgency(agents, requests).map(({ agent, theirs }) => {
          const device = deviceById(agent.deviceId)
          return (
            <motion.div key={agent.id} layout="position" transition={GLIDE} className="mb-4 break-inside-avoid">
            <HoverCell>
            <Agent className="min-w-0">
              <AgentHeader name={agent.name} role={agent.role} icon={<AgentMark tool={agent.tool} className="size-5" />}
                model={`${device.name} · ${device.syncedMinutesAgo === 0 ? t("this machine") : interpolate(t('synced {minutes} min ago'), { minutes: device.syncedMinutesAgo })}`} />
              <AgentContent className="space-y-0 px-2 pb-2">
                <SubagentStatus agent={agent} />
                {theirs.length === 0 && <p className="px-3 pb-3 text-sm text-muted-foreground">{t("Nothing on it in this view.")}</p>}
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
            </motion.div>
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
            <AlertTitle>{t("Possible collision (sample)")}</AlertTitle>
            <AlertDescription className="text-attention-foreground">{t("Alex and Priya both have agents changing the price forecast page.")}</AlertDescription>
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
        <AlertTitle className="line-clamp-none">{interpolate(t("Couldn't read this request: {reason}"), { reason: readError.reason })}</AlertTitle>
        <AlertDescription>
          {readError.title && <p>{readError.title}</p>}
          {readError.evidenceHref && <a href={readError.evidenceHref} target="_blank" rel="noreferrer" className="underline underline-offset-4 hover:text-foreground">{t("Open the prompt it came from")}</a>}
        </AlertDescription>
      </Alert>
    </Req>
  )
}

/**
 * My Work: the live inbox, a list of threads under their focus areas. With a focus area (or Other) selected, its
 * header comes first and only the requests in it show; requests not sorted yet ("Sorting…") show only under every request.
 */
export function MyWork({ focusAreaId, onOpen, onOpenFocus, onOpenRules }: { focusAreaId: string | null; onOpen: (request: Request) => void; onOpenFocus: (focusAreaId: string) => void; onOpenRules: () => void }) {
  useI18n()
  const { team } = useWorkspace()
  const { sourceKind, requests: allRequests, requestReadErrors: allReadErrors, unlinkedWorkCount, sourceHealth, buildStory, lastRuns, refresh, focusAreas } = useWorkModel()
  const area = focusAreaId && focusAreaId !== OTHER_FOCUS_AREA_ID ? focusAreas.find((entry) => entry.id === focusAreaId) ?? null : null
  const requests = useMemo(() => {
    if (!focusAreaId) return allRequests
    const resolveArea = createFocusAreaResolver(focusAreas)
    return allRequests.filter((request) => resolveArea(request.focusAreaId) === focusAreaId)
  }, [allRequests, focusAreas, focusAreaId])
  // A request that could not be read has no placement to file it under, so its error shows only under every request.
  const requestReadErrors = focusAreaId ? [] : allReadErrors
  const focusChanges = useFocusChanges()
  const sample = sourceKind === 'sample'
  // How the person likes to see My Work is saved across visits (store/create-store.ts).
  const { listView, focusThreadView, savedFilter, savedArrangement } = useStore(useShallow((state) => ({ listView: state.view.listView, focusThreadView: state.view.focusThreadView, savedFilter: state.view.filter, savedArrangement: state.view.focusArrangement })))
  const shownViews = WORK_LIST_VIEWS.filter((value) => (team || !VIEW[value].teamOnly) && !(focusAreaId && VIEW[value].ofFocuses))
  const view = shownViews.includes(listView) ? listView : 'threads'
  const { setListView: setView, setFilter, setFocusArrangement } = useStore.getState()
  const [storyOpen, setStoryOpen] = useState(false)
  const filter = savedFilter
  const matches = FILTER_MATCHES[filter]
  const visible = useMemo(() => sortThreads(requests.filter(matches)), [requests, matches])
  // Under Open, what rests is hidden but still counted: a focus line keeps its Done count, and a focus's board its folded Done column.
  const counted = filter === 'open' ? requests : visible
  // The focus list has a line for every kept area, with or without requests, so it is never replaced by an empty state.
  const listsFocuses = view === 'threads' && !focusAreaId && focusAreas.some((entry) => entry.status === 'kept' && !entry.mergedInto)
  // Offered wherever the focus list shows: the headings are the owner's to make, so none yet is where they start.
  const arrangeable = listsFocuses
  const arrangement = arrangeable ? savedArrangement : 'priority'

  return (
    <div className="space-y-4 md:space-y-5">
      {!sourceHealth.connected && (
        <Alert className="border-attention-border bg-attention text-attention-foreground">
          <TriangleAlertIcon />
          <AlertTitle>{t("Can't read local work right now")}</AlertTitle>
          {sourceHealth.error && <AlertDescription className="text-attention-foreground">{t(sourceHealth.error)}</AlertDescription>}
        </Alert>
      )}
      <FocusChangeBar changes={focusChanges} />
      {/* Every request in the area, closed ones too: the combined progress counts each reviewed request (D1's rule). */}
      {area ? <FocusHeader key={area.id} area={area} requests={requests} changes={focusChanges} />
        : focusAreaId === OTHER_FOCUS_AREA_ID && <OtherHeader requests={requests} />}

      <div className="flex flex-wrap items-center gap-2 md:gap-3">
        {/* Inside one focus the switch below is the choice; By agent and Team still cut that focus's requests for a team. */}
        {shownViews.length > 1 && <Req ids={['R19.1', 'R19.25', 'R4.3', 'R9.2']}>
          <ToggleGroup type="single" variant="outline" size="sm" spacing={1} value={view} onValueChange={(next) => next && setView(next as View)} aria-label={t("View")}>
            {shownViews.map((value) => (
              <ToggleGroupItem key={value} value={value} className="relative h-11 px-3.5 data-[state=on]:bg-transparent data-[state=on]:hover:bg-transparent md:h-8">
                {view === value && <ActivePill layoutId="view-toggle-active-pill" />}
                <span className="relative">{t(VIEW[value].label)}</span>
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </Req>}
        {/* Inside one focus its threads are rows or a board; in the list each opened focus has the same switch. */}
        {focusAreaId && view === 'threads' && <FocusThreadViewSwitch />}
        {arrangeable && (
          <Req ids={['R19.19']}>
            <ToggleGroup type="single" variant="outline" size="sm" spacing={1} value={arrangement} onValueChange={(next) => next && setFocusArrangement(next as FocusArrangement)} aria-label={t("Arrange by")}>
              {FOCUS_ARRANGEMENTS.map((value) => (
                <ToggleGroupItem key={value} value={value} className="relative h-11 px-3.5 data-[state=on]:bg-transparent data-[state=on]:hover:bg-transparent md:h-8">
                  {arrangement === value && <ActivePill layoutId="arrangement-toggle-active-pill" />}
                  <span className="relative">{t(ARRANGEMENT[value])}</span>
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </Req>
        )}
        <div className="order-last flex items-center gap-3 md:ml-auto">
          {!focusAreaId && <PlanButton focusAreaId={null} />}
          {sample ? <RefreshButton run={SAMPLE_RUNS.progress} ids={['R14.12']} /> : (
            <>
              {/* When and where it last ran is said only while it is running or has failed. */}
              {(refresh?.state === 'running' || refresh?.error) && <RefreshStatus refresh={refresh} run={lastRuns.progress} label="Last reviewed" ids={['R14.12']} />}
              {sourceKind === 'local' && <ManualRefreshButton ids={['R14.12']} running={refresh?.state === 'running'} />}
            </>
          )}
        </div>
        {/* Phone: the filters wrap to a second row instead of widening the page past the screen. */}
        <Req ids={['R19.21']}>
          <ToggleGroup type="single" variant="outline" size="sm" spacing={1} value={filter} onValueChange={(next) => next && setFilter(next as Filter)} aria-label={t("Filter")} className="w-full min-w-0 md:w-auto md:flex-nowrap">
            {WORK_FILTERS.map((value) => ({ value, ...FILTER[value] })).map(({ value, label, dot }) => (
              <ToggleGroupItem key={value} value={value} className="h-11 gap-1.5 px-3 md:h-8">
                {dot && <span className={cn('size-1.5 rounded-full', dot)} />}
                {t(label)}
                <span className="text-muted-foreground tabular-nums group-data-[state=on]/toggle:text-accent-foreground">{requests.filter(FILTER_MATCHES[value]).length}</span>
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </Req>
      </div>

      {!focusAreaId && <PlanProposals focusAreaId={null} changes={focusChanges} />}

      {view === 'cards' ? (
        <Req ids={['R19.25']}>
          <FocusOverview areas={focusAreas} requests={allRequests} shows={matches} incomplete={allReadErrors.length > 0} onOpenArea={onOpenFocus} onOpenRequest={onOpen} />
        </Req>
      ) : listsFocuses ? <ThreadList requests={counted} shows={matches} focusAreas={focusAreas} grouped arrangement={arrangement} showDone={filter === 'done'} onOpen={onOpen} onOpenFocus={onOpenFocus} /> : requests.length === 0 && requestReadErrors.length === 0 ? (
        <Req ids={['R12.1']}>
          <Empty className="border bg-card/60">
            <EmptyHeader>
              <EmptyMedia variant="icon"><InboxIcon /></EmptyMedia>
              <EmptyTitle>{focusAreaId ? t("No requests in this area yet.") : t("No requests recorded yet.")}</EmptyTitle>
              <EmptyDescription>{focusAreaId ? t("A refresh places new requests here, or move one here from its page.") : t("Ask an agent for something and it appears here.")}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        </Req>
      ) : (view === 'threads' && (!focusAreaId || focusThreadView === 'board') ? counted : visible).length === 0 && requestReadErrors.length === 0 ? (
        <Req ids={['R12.1']}>
          <Empty className="border bg-card/60">
            <EmptyHeader>
              <EmptyMedia variant="icon"><InboxIcon /></EmptyMedia>
              <EmptyTitle>{t("Nothing here")}</EmptyTitle>
              <EmptyDescription>{t("No requests match. New work shows up as soon as an agent writes it.")}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        </Req>
      ) : view === 'agents' ? <ByAgentView requests={visible} onOpen={onOpen} />
        : view === 'team' ? <TeamBoard requests={visible} onOpen={onOpen} />
          : <ThreadList requests={counted} shows={matches} focusAreas={focusAreas} grouped={!focusAreaId} arrangement={arrangement} showDone={filter === 'done'} onOpen={onOpen} onOpenFocus={onOpenFocus} />}
      {requestReadErrors.length > 0 && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {requestReadErrors.map((readError) => <RequestReadErrorCard key={readError.requestId} readError={readError} />)}
        </div>
      )}
      {unlinkedWorkCount > 0 && (
        <p className="text-xs text-muted-foreground">{interpolate(t(unlinkedWorkCount === 1 ? "{count} work record isn't linked to a request yet." : "{count} work records aren't linked to a request yet."), { count: unlinkedWorkCount })}</p>
      )}

      {/* Written by request-progress; with no story there is nothing to open. */}
      {buildStory && (
        <>
          <Req ids={['R7.1', 'R7.2']}>
            <Button variant="link" className="h-11 p-0 text-sm text-muted-foreground md:h-auto" onClick={() => setStoryOpen(true)}>{t("Read the build story")}</Button>
          </Req>
          <StorySheet open={storyOpen} story={buildStory} requests={requests} onClose={() => setStoryOpen(false)} onOpenRules={() => { setStoryOpen(false); onOpenRules() }} />
        </>
      )}
    </div>
  )
}
