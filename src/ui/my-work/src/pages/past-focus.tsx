import { t, useI18n, interpolate } from '@/lib/i18n'
// Past focus: areas you marked done, and what you asked for most, month by month (MonthByMonth, moved from the
// retired goals page). A month closing archives its asks; it doesn't mean they were done.
import { useLayoutEffect, useRef, useState } from 'react'
import { CheckIcon, ChevronDownIcon, ChevronRightIcon, CircleCheckIcon, RefreshCwIcon } from 'lucide-react'
import { Timeline } from '@/components/aceternity/timeline'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { ErrorDetails } from '@/components/error-details'
import { Quotes } from '@/components/focus-header'
import { clockDay } from '@/lib/display-time'
import { READING_MEASURE } from '@/lib/reading-measure'
import { cn } from '@/lib/utils'
import { timesLabel } from '@/lib/words'
import { Req } from '@/spec/req'
import type { PastPeriod } from '@/data'
import { useStore, useWorkModel } from '@/store'
import { resolveFocusAreaId } from '@/live/to-focus-model'

/**
 * Areas marked done (c-past-done-areas): always drawn. Each is a flat card with a green top edge, the day it was
 * marked done (when the worker sends it) and how many of its requests shipped; it still opens with its requests. With
 * none, one line says how to mark an area done. The foil GlareCard keeps its file (the setup checkout screen uses it);
 * its look is off here, so a done area reads like the rest of the app (c-aceternity-glare-card).
 */
function DoneAreas({ onOpenFocus }: { onOpenFocus: (focusAreaId: string) => void }) {
  const { locale } = useI18n()
  const { focusAreas, requests } = useWorkModel()
  const done = focusAreas.filter((area) => area.status === 'done' && !area.mergedInto)
  const shippedIn = (id: string) => requests.filter((request) => request.state === 'shipped' && resolveFocusAreaId(request.focusAreaId, focusAreas) === id).length
  return (
    <section aria-labelledby="done-areas-heading" className="space-y-2">
      <h2 id="done-areas-heading" className="flex items-baseline gap-2 text-base font-semibold">{t("Done areas")}<span className="mono-number text-sm font-normal text-muted-foreground">{done.length.toLocaleString(locale)}</span></h2>
      {done.length === 0 ? (
        <p className="flex items-start gap-2.5 rounded-xl border border-dashed border-control-edge px-4 py-3 text-sm text-muted-foreground">
          <CircleCheckIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          {t('No area is marked done yet. When an area is finished, mark it done from the “…” menu on its page, and it shows here.')}
        </p>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {done.map((area) => {
            // The day it was marked done (the row that marked it done: a later rename or goal edit does not move it,
            // my-focus.mjs), through the shared formatter (rule 9): "Oct 30", with the year when it is not this year's,
            // and the full stamp for screen readers (no tooltip inside a button).
            const day = area.doneAt ? clockDay(area.doneAt) : null
            return (
              <li key={area.id} className="flex">
                <Button variant="bare" onClick={() => onOpenFocus(area.id)} data-slot="done-area-card"
                  className="flex w-full flex-col items-stretch gap-2 rounded-xl border border-t-4 border-control-edge/55 border-t-shipped-foreground bg-card p-4 shadow-panel hover-enabled:bg-surface">
                  <span className="flex items-center gap-1.5 text-xs font-medium text-shipped-foreground">
                    <CheckIcon aria-hidden="true" className="size-3.5" />{t("Done")}
                    {day && <><span aria-hidden="true">·</span><time dateTime={area.doneAt ?? undefined} className="mono-number font-normal text-muted-foreground"><span aria-hidden="true">{day.short}</span><span className="sr-only">{day.full}</span></time></>}
                  </span>
                  <span className="text-base leading-snug font-semibold">{area.name}</span>
                  {area.goal && <span className="text-xs text-muted-foreground">{area.goal}</span>}
                  <span className="mt-auto flex items-center justify-between text-xs text-muted-foreground">
                    <span className="mono-number">{interpolate(t('{count} shipped'), { count: shippedIn(area.id).toLocaleString(locale) })}</span>
                    <ChevronRightIcon aria-hidden="true" className="size-4" />
                  </span>
                </Button>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

/**
 * A month's prompt count as a bar sized against the busiest month, with the number in tabular figures and thousands
 * separators (page-09 M1, F6). The bar is drawn for the eye; the number and its word are what a screen reader hears.
 */
function PromptBar({ count, busiest }: { count: number; busiest: number }) {
  const { locale } = useI18n()
  const shown = count.toLocaleString(locale)
  // At least 4% so a quiet month still shows a mark beside its number.
  const width = Math.max(4, Math.round((count / busiest) * 100))
  return (
    <span className="flex w-40 shrink-0 items-center gap-2">
      <span aria-hidden="true" className="h-2 w-24 shrink-0"><span className="block h-full rounded-sm bg-muted-foreground/80" style={{ width: `${width}%` }} /></span>
      <span aria-hidden="true" data-slot="month-prompt-count" className="mono-number text-xs text-foreground">{shown}</span>
      <span className="sr-only">{interpolate(t(count === 1 ? '{count} prompt' : '{count} prompts'), { count: shown })}</span>
    </span>
  )
}

// An opened month lists its first three asks; "Show all N" draws the rest (page-09 M2). Three keep an opened month
// to about one screen at 1440×900 with its summary.
const ASKS_SHOWN_FIRST = 3

/** One ask of a month: its rank, title, area chip and how often it was asked; its quote opens from the row (M3). */
function AskRow({ entry, rank }: { entry: PastPeriod['areas'][number]; rank: number }) {
  const times = entry.timesAsked === 1 ? t(timesLabel(1)) : interpolate(t('asked {times}×'), { times: entry.timesAsked })
  const row = (
    <>
      <span className="mono-number w-5 shrink-0 text-xs text-muted-foreground">{rank}</span>
      <span className="min-w-0 flex-1 basis-48 text-sm">{entry.title}</span>
      <Badge variant="outline" className="font-normal">{entry.label}</Badge>
      <span className="mono-number shrink-0 text-xs text-muted-foreground">{times}</span>
    </>
  )
  if (!entry.quote) return <li className="flex flex-wrap items-center gap-x-3 gap-y-1 px-1 py-2">{row}</li>
  return (
    <li>
      <Collapsible>
        <CollapsibleTrigger asChild>
          <Button variant="bare" className="group/ask flex w-full flex-wrap items-center gap-x-3 gap-y-1 rounded-md px-1 py-2 hover-enabled:bg-surface">
            {row}
            <ChevronDownIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground motion-safe:transition-transform group-data-[state=open]/ask:rotate-180" />
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent className="pb-2 pl-8"><Quotes quotes={[entry.quote]} /></CollapsibleContent>
      </Collapsible>
    </li>
  )
}

/**
 * One archived month (c-past-month): closed, one row with the prompt bar and the top ask; opened, its counts, a
 * three-line summary with "Read all" (32em: a real summary measured 77 characters a line at 34em, so 32em keeps it under 75), then the first asks as rows with their
 * area chip and "Show all N". The summary is the owner-goals run's own words, shown as written.
 */
function PastMonth({ period, busiest }: { period: PastPeriod; busiest: number }) {
  const { locale } = useI18n()
  const [open, setOpen] = useState(false)
  const [readAll, setReadAll] = useState(false)
  const [allAsks, setAllAsks] = useState(false)
  const [summaryClipped, setSummaryClipped] = useState(false)
  const summaryRef = useRef<HTMLParagraphElement>(null)
  const [top] = period.areas
  // "Read all" only when three lines do not hold the whole summary.
  useLayoutEffect(() => {
    const summary = summaryRef.current
    if (open && summary && !readAll) setSummaryClipped(summary.scrollHeight > summary.clientHeight + 1)
  }, [open, readAll, period.headline])
  const shownAsks = allAsks ? period.areas : period.areas.slice(0, ASKS_SHOWN_FIRST)
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild>
        <Button variant="bare" data-slot="month-row" className="group/month flex min-h-12 w-full flex-wrap items-center gap-x-3 gap-y-1 rounded-md py-2 text-sm hover-enabled:bg-surface">
          <PromptBar count={period.promptCount} busiest={busiest} />
          <span data-slot="month-top-ask" className="min-w-0 flex-1 basis-48 font-medium">{top?.title ?? t('No asks saved this month')}</span>
          <ChevronDownIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground motion-safe:transition-transform group-data-[state=open]/month:rotate-180" />
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-4 pt-1 pb-4">
        <p className="text-xs text-muted-foreground tabular">{interpolate(t('Archived · {count} prompts · {areas}'), { count: period.promptCount.toLocaleString(locale), areas: interpolate(t(period.areas.length === 1 ? '{count} area' : '{count} areas'), { count: period.areas.length }) })}</p>
        {period.headline && (
          <div className="space-y-1">
            <p className="section-label">{t('The month in short')}</p>
            <p ref={summaryRef} className={cn(READING_MEASURE, 'text-sm text-foreground/85', !readAll && 'line-clamp-3')}>{period.headline}</p>
            {(summaryClipped || readAll) && (
              <Button variant="link" size="xs" className="h-auto px-0" aria-expanded={readAll} onClick={() => setReadAll((all) => !all)}>{readAll ? t('Show less') : t('Read all')}</Button>
            )}
          </div>
        )}
        {period.areas.length > 0 && (
          <div className="space-y-1">
            <p className="section-label">{t('What you asked for most')}</p>
            <ol className="divide-y border-y">{shownAsks.map((entry, index) => <AskRow key={entry.title} entry={entry} rank={index + 1} />)}</ol>
            {period.areas.length > ASKS_SHOWN_FIRST && (
              <Button variant="link" size="xs" className="h-auto px-0" aria-expanded={allAsks} onClick={() => setAllAsks((all) => !all)}>
                {allAsks ? t('Show fewer') : interpolate(t('Show all {count}'), { count: period.areas.length })}
              </Button>
            )}
          </div>
        )}
        <p className="text-xs text-muted-foreground">{t("No request reviews cover this month, so it shows what you asked for, not what moved.")}</p>
      </CollapsibleContent>
    </Collapsible>
  )
}

/** How Month by month is ordered (c-aceternity-timeline M2). The one definition; its words are a Record. */
const MONTH_ORDERS = ['newest', 'busiest'] as const
type MonthOrder = (typeof MONTH_ORDERS)[number]
const isMonthOrder = (value: string): value is MonthOrder => MONTH_ORDERS.some((order) => order === value)
const MONTH_ORDER_WORDS: Record<MonthOrder, string> = { newest: 'Newest first', busiest: 'Busiest first' }

/**
 * Month by month: one timeline entry per saved owner-goals run (§4), newest first or busiest first, each one row on a
 * static hairline (c-aceternity-timeline). A month closing archives its asks; it doesn't mean they were done.
 */
function MonthByMonth({ onOpenFocus }: { onOpenFocus: (focusAreaId: string) => void }) {
  const { focusAreas, currentPeriod, pastPeriods } = useWorkModel()
  const [order, setOrder] = useState<MonthOrder>('newest')
  if (!currentPeriod) return null
  const busiest = Math.max(1, currentPeriod.promptCount, ...pastPeriods.map((period) => period.promptCount))
  const topArea = focusAreas.find((area) => area.status === 'kept' && !area.mergedInto)
  // Each month keeps its own open, "Read all" and "Show all" state when the order changes (quality M3): keyed by id.
  const current = {
    id: 'current-month',
    title: currentPeriod.label,
    current: true,
    promptCount: currentPeriod.promptCount,
    content: (
      // This month is still open: it names your first kept area today, not a saved month's top area.
      <Button variant="bare" disabled={!topArea} onClick={() => topArea && onOpenFocus(topArea.id)} data-slot="month-row"
        className="flex min-h-12 w-full flex-wrap items-center gap-x-3 gap-y-1 rounded-md py-2 text-sm hover-enabled:bg-surface">
        <PromptBar count={currentPeriod.promptCount} busiest={busiest} />
        <span className="min-w-0 flex-1 basis-48">
          <Badge variant="outline" className="mr-2 font-normal">{t('Current')}</Badge>
          {topArea ? <><span data-slot="month-top-ask" className="font-medium">{topArea.name}</span> <span className="text-xs text-muted-foreground">{t("· first in your focus today")}</span></> : t("No area kept yet")}
        </span>
        {topArea && <ChevronRightIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />}
      </Button>
    ),
  }
  const past = pastPeriods.map((period) => ({ id: period.id, title: period.label, current: false, promptCount: period.promptCount, content: <PastMonth period={period} busiest={busiest} /> }))
  const entries = order === 'newest' ? [current, ...past] : [current, ...past].sort((a, b) => b.promptCount - a.promptCount)
  const months = entries.length
  return (
    <section aria-labelledby="month-by-month-heading" className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-0.5">
          <h2 id="month-by-month-heading" className="flex items-baseline gap-2 text-base font-semibold">{t("Month by month")}<span className="mono-number text-sm font-normal text-muted-foreground">{interpolate(t(months === 1 ? '{count} month' : '{count} months'), { count: months })}</span></h2>
          <p className={cn(READING_MEASURE, 'text-sm text-muted-foreground')}>{t("What you asked for most, as each owner-goals run saved it. A month closing archives its asks; it doesn’t mean they were done.")}</p>
        </div>
        <ToggleGroup type="single" variant="outline" size="sm" spacing={1} aria-label={t('Order of the months')} value={order} onValueChange={(value) => { if (isMonthOrder(value)) setOrder(value) }}>
          {MONTH_ORDERS.map((choice) => <ToggleGroupItem key={choice} value={choice}>{t(MONTH_ORDER_WORDS[choice])}</ToggleGroupItem>)}
        </ToggleGroup>
      </div>
      <Timeline data={entries.map(({ id, title, content, current: isCurrent }) => ({ id, title, content, current: isCurrent }))} />
      <p className="text-xs text-muted-foreground">{t('Bar length is the number of prompts you typed that month.')}</p>
    </section>
  )
}

/**
 * The months could not be read (G17): plain words, the raw cause under Details, and Try again, which reads them again
 * only when pressed (no automatic retry).
 */
function MonthsReadFailure({ cause }: { cause: string }) {
  const [reading, setReading] = useState(false)
  const readAgain = () => { setReading(true); void useStore.getState().retryWorkRead().finally(() => setReading(false)) }
  return (
    <div data-slot="months-read-failed" className="flex w-full max-w-md flex-col items-center gap-3">
      <Button variant="outline" busy={reading} busyLabel={t('Reading…')} onClick={readAgain}><RefreshCwIcon />{t('Try again')}</Button>
      <div className="w-full text-left"><ErrorDetails cause={cause} /></div>
    </div>
  )
}

export function PastFocus({ onOpenFocus }: { onOpenFocus: (focusAreaId: string) => void }) {
  useI18n()
  const { currentPeriod, goalsReadError } = useWorkModel()
  return (
    <Req ids={['R16.7', 'R12.1']}>
      <div className="space-y-8">
        {/* The page's h1 is "Past focus" in the header bar (page-09 F7); this line says what the page holds. */}
        <p className="text-sm text-muted-foreground">{t("Areas you finished, and what you asked for in earlier months.")}</p>
        <DoneAreas onOpenFocus={onOpenFocus} />
        {currentPeriod ? <MonthByMonth onOpenFocus={onOpenFocus} /> : (
          <Empty className="border bg-card/60">
            <EmptyHeader>
              <EmptyTitle>{goalsReadError ? t("Can’t read your past months right now") : t("Nothing here yet")}</EmptyTitle>
              <EmptyDescription>
                {goalsReadError ? t('claude-mem could not read your saved months. It rewrites them on its next automatic refresh.') : t("claude-mem reads your recent prompts and fills this in automatically.")}
              </EmptyDescription>
            </EmptyHeader>
            {goalsReadError && <EmptyContent><MonthsReadFailure cause={goalsReadError} /></EmptyContent>}
          </Empty>
        )}
      </div>
    </Req>
  )
}
