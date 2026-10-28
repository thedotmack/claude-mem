// Past focus: areas you marked done, and what you asked for most, month by month (MonthByMonth, moved from the
// retired goals page). A month closing archives its asks; it doesn't mean they were done.
import { ChevronRightIcon } from 'lucide-react'
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty'
import { RefreshButton, RefreshStatus } from '@/components/bits'
import { Quotes } from '@/components/focus-header'
import { timesLabel } from '@/lib/words'
import { Req } from '@/spec/req'
import { SAMPLE_RUNS, useWorkModel } from '@/data'


/** Areas marked done. Each still opens with its requests. */
function DoneAreas({ onOpenFocus }: { onOpenFocus: (focusAreaId: string) => void }) {
  const done = useWorkModel().focusAreas.filter((area) => area.status === 'done' && !area.mergedInto)
  if (done.length === 0) return null
  return (
    <div className="space-y-2">
      <h2 className="text-base font-semibold">Done areas</h2>
      <div className="divide-y overflow-hidden rounded-xl border bg-card">
        {done.map((area) => (
          <button key={area.id} type="button" onClick={() => onOpenFocus(area.id)} className="grid min-h-14 w-full grid-cols-[minmax(0,1fr)_1rem] items-center gap-3 px-4 py-3 text-left hover:bg-surface-cool">
            <span className="min-w-0 space-y-0.5"><span className="block text-sm font-semibold">{area.name}</span>{area.goal && <span className="block truncate text-xs text-muted-foreground">{area.goal}</span>}</span>
            <ChevronRightIcon className="size-4 text-muted-foreground" />
          </button>
        ))}
      </div>
    </div>
  )
}

/** Month by month: one row per saved owner-goals run (§4). */
function MonthByMonth() {
  const { focusAreas, currentPeriod, pastPeriods } = useWorkModel()
  if (!currentPeriod) return null
  const topArea = focusAreas.find((area) => area.status === 'kept' && !area.mergedInto)
  return (
    <div className="space-y-3">
      <div className="space-y-0.5">
        <h2 className="text-base font-semibold">Month by month</h2>
        <p className="text-sm text-muted-foreground">What you asked for most, month by month, as each owner-goals run saved it. A month closing archives its asks; it doesn’t mean they were done.</p>
      </div>
      <div className="overflow-hidden rounded-xl border bg-card">
        <div className="hidden grid-cols-[12rem_minmax(0,1fr)_7rem] gap-3 border-b px-4 py-2 text-xs text-muted-foreground sm:grid">
          <span>Month</span><span>Top focus</span><span className="text-right">Your prompts</span>
        </div>
        <div className="grid min-h-16 w-full grid-cols-1 items-center gap-0.5 border-b px-4 py-3 sm:grid-cols-[12rem_minmax(0,1fr)_7rem] sm:gap-3">
          <span className="text-sm font-semibold whitespace-nowrap">{currentPeriod.label} <span className="ml-1 text-xs font-medium text-muted-foreground">Current</span></span>
          {/* This month is still open: its row names your first kept area today, not a saved month's top area. */}
          <span className="line-clamp-2 text-sm sm:truncate">{topArea ? <>{topArea.name} <span className="text-xs text-muted-foreground">· first in your focus today</span></> : 'No area kept yet'}</span>
          <span className="text-xs text-muted-foreground sm:text-right sm:text-sm">{currentPeriod.promptCount}<span className="sm:hidden"> prompts</span></span>
        </div>
        <Accordion type="single" collapsible>
          {pastPeriods.map((period) => (
            <AccordionItem key={period.id} value={period.id} className="px-4">
              <AccordionTrigger className="min-h-16 items-center gap-3 py-3 hover:no-underline">
                <span className="flex min-w-0 flex-1 flex-col gap-0.5 sm:grid sm:grid-cols-[12rem_minmax(0,1fr)_7rem] sm:items-center sm:gap-3">
                  <span className="text-sm font-semibold whitespace-nowrap">{period.label} <span className="ml-1 text-xs font-normal text-muted-foreground">Archived</span></span>
                  <span className="line-clamp-2 text-sm font-normal sm:truncate">{period.areas[0]?.title ?? 'No areas saved'}</span>
                  <span className="text-xs font-normal text-muted-foreground sm:text-right sm:text-sm">{period.promptCount}<span className="sm:hidden"> prompts · {period.areas.length} areas</span></span>
                </span>
              </AccordionTrigger>
              <AccordionContent className="space-y-4 pb-4 sm:pl-[12.75rem] [&_p:not(:last-child)]:mb-0">
                <p className="text-sm">{period.headline}</p>
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
              </AccordionContent>
            </AccordionItem>
          ))}
        </Accordion>
      </div>
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
        {currentPeriod ? <MonthByMonth /> : !hasDone && (
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
