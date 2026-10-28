// Past focus: areas you marked done, and what you asked for most, month by month (MonthByMonth, moved from the
// retired goals page). A month closing archives its asks; it doesn't mean they were done.
import { useState } from 'react'
import { CheckIcon, ChevronDownIcon, ChevronRightIcon } from 'lucide-react'
import { GlareCard } from '@/components/aceternity/glare-card'
import { Timeline } from '@/components/aceternity/timeline'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty'
import { RefreshButton, RefreshStatus } from '@/components/bits'
import { Quotes } from '@/components/focus-header'
import { cn } from '@/lib/utils'
import { plural, timesLabel } from '@/lib/words'
import { Req } from '@/spec/req'
import { SAMPLE_RUNS, useWorkModel, type PastPeriod } from '@/data'
import { resolveFocusAreaId } from '@/live/to-focus-model'

/**
 * Areas marked done, as a shelf of foil cards (GlareCard): a finished area is a win, not a list row. Each still
 * opens with its requests, and says how many of them shipped.
 */
function DoneAreas({ onOpenFocus }: { onOpenFocus: (focusAreaId: string) => void }) {
  const { focusAreas, requests } = useWorkModel()
  const done = focusAreas.filter((area) => area.status === 'done' && !area.mergedInto)
  if (done.length === 0) return null
  const shippedIn = (id: string) => requests.filter((request) => request.state === 'shipped' && resolveFocusAreaId(request.focusAreaId, focusAreas) === id).length
  return (
    <div className="space-y-2">
      <h2 className="text-base font-semibold">Done areas</h2>
      <ul className="flex flex-wrap gap-4">
        {done.map((area) => (
          <li key={area.id}>
            <button type="button" onClick={() => onOpenFocus(area.id)} className="done-area-glare block rounded-[18px] text-left focus-visible:outline-2 focus-visible:outline-ring">
              <GlareCard className="done-area-face">
                <span className="flex h-full flex-col justify-between gap-2 p-4">
                  <span className="flex items-center gap-1.5 text-xs font-medium text-shipped-foreground"><CheckIcon className="size-3.5" />Done</span>
                  <span className="space-y-1">
                    <span className="block text-[15px] leading-snug font-semibold">{area.name}</span>
                    {area.goal && <span className="line-clamp-2 block text-xs text-muted-foreground">{area.goal}</span>}
                  </span>
                  <span className="flex items-center justify-between text-xs text-muted-foreground"><span><span className="font-medium text-foreground tabular-nums">{shippedIn(area.id)}</span> shipped</span><ChevronRightIcon className="size-4" /></span>
                </span>
              </GlareCard>
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

/**
 * One archived month on the timeline. Closed, it reads like a line on the board: prompt count, the top area and the
 * headline's first lines; opening it shows the whole headline and every area with its quote.
 */
function PastMonth({ period }: { period: PastPeriod }) {
  const [open, setOpen] = useState(false)
  const [top] = period.areas
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="rounded-xl border bg-card shadow-panel">
      <CollapsibleTrigger className="group grid w-full grid-cols-[minmax(0,1fr)_1rem] items-start gap-3 p-4 text-left">
        <span className="min-w-0 space-y-1">
          <span className="block text-xs text-muted-foreground">Archived · {period.promptCount} prompts · {plural(period.areas.length, 'area')}</span>
          {top && <span className="block text-sm font-medium">{top.title}</span>}
          <span className={cn('block text-sm text-foreground/85', !open && 'line-clamp-2')}>{period.headline}</span>
        </span>
        <ChevronDownIcon className="mt-0.5 size-4 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-4 px-4 pb-4">
        <ol className="space-y-3">
          {period.areas.map((entry, index) => (
            <li key={entry.title} className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
              <span className="flex size-6 items-center justify-center rounded-md bg-muted text-xs text-muted-foreground tabular-nums">{index + 1}</span>
              <p className="text-sm font-medium">{entry.title}</p>
              <p className="col-start-2 text-xs text-muted-foreground">{entry.label} · {timesLabel(entry.timesAsked)}</p>
              {entry.quote && <div className="col-start-2"><Quotes quotes={[entry.quote]} /></div>}
            </li>
          ))}
        </ol>
        <p className="text-xs text-muted-foreground">No request reviews cover this month, so it shows what you asked for, not what moved.</p>
      </CollapsibleContent>
    </Collapsible>
  )
}

/**
 * Month by month: one timeline entry per saved owner-goals run (§4), newest first. The beam fills as you scroll
 * down the months. A month closing archives its asks; it doesn't mean they were done.
 */
function MonthByMonth({ onOpenFocus }: { onOpenFocus: (focusAreaId: string) => void }) {
  const { focusAreas, currentPeriod, pastPeriods } = useWorkModel()
  if (!currentPeriod) return null
  const topArea = focusAreas.find((area) => area.status === 'kept' && !area.mergedInto)
  const current = {
    title: currentPeriod.label,
    content: (
      // This month is still open: it names your first kept area today, not a saved month's top area.
      <button type="button" disabled={!topArea} onClick={() => topArea && onOpenFocus(topArea.id)} className="grid w-full grid-cols-[minmax(0,1fr)_1rem] items-center gap-3 rounded-xl border bg-card p-4 text-left shadow-panel enabled:hover:bg-surface-cool">
        <span className="flex min-w-0 flex-col gap-1">
          <span className="text-xs font-medium text-muted-foreground">Current · {currentPeriod.promptCount} prompts · open this month</span>
          <span className="text-sm font-medium">{topArea ? <>{topArea.name} <span className="text-xs font-normal text-muted-foreground">· first in your focus today</span></> : 'No area kept yet'}</span>
        </span>
        {topArea && <ChevronRightIcon className="size-4 text-muted-foreground" />}
      </button>
    ),
  }
  const past = pastPeriods.map((period) => ({ title: period.label, content: <PastMonth period={period} /> }))
  return (
    <div className="space-y-3">
      <div className="space-y-0.5">
        <h2 className="text-base font-semibold">Month by month</h2>
        <p className="text-sm text-muted-foreground">What you asked for most, as each owner-goals run saved it. A month closing archives its asks; it doesn’t mean they were done.</p>
      </div>
      <Timeline data={[current, ...past]} />
    </div>
  )
}

export function PastFocus({ onOpenFocus }: { onOpenFocus: (focusAreaId: string) => void }) {
  const { sourceKind, currentPeriod, goalsReadError, lastRuns, refresh, focusAreas } = useWorkModel()
  const hasDone = focusAreas.some((area) => area.status === 'done' && !area.mergedInto)
  return (
    <Req ids={['R16.7', 'R12.1']}>
      <div className="space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
          <div className="space-y-0.5">
            <h2 className="text-lg font-semibold tracking-tight">Past focus</h2>
            <p className="text-sm text-muted-foreground">Areas you finished, and what you asked for in earlier months.</p>
          </div>
          {sourceKind === 'sample' ? <RefreshButton run={SAMPLE_RUNS.goals} ids={['R14.10']} /> : <RefreshStatus refresh={refresh} run={lastRuns.goals} ids={['R14.10']} />}
        </div>
        <DoneAreas onOpenFocus={onOpenFocus} />
        {currentPeriod ? <MonthByMonth onOpenFocus={onOpenFocus} /> : !hasDone && (
          <Empty className="border bg-card/60">
            <EmptyHeader>
              <EmptyTitle>{goalsReadError ? 'Can’t read your past months right now' : 'Nothing here yet'}</EmptyTitle>
              <EmptyDescription>
                {goalsReadError ? <>{goalsReadError}. claude-mem rewrites them on its next automatic refresh.</> : <>claude-mem reads your recent prompts and fills this in automatically.</>}
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent><RefreshStatus refresh={refresh} run={null} ids={['R16.7']} /></EmptyContent>
          </Empty>
        )}
      </div>
    </Req>
  )
}
