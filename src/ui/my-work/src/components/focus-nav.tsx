// MY FOCUS: the kept areas in priority order (the owner's order wins), then Other, then "N suggested", each with how
// many requests in it need you. On the wide rail it is a nav section; on phones and the icon-only rail, a chip row.
// The rail's highlight is App's side-nav pill: one pill slides between focus areas, pages and Past focus.
import { HistoryIcon, SparklesIcon } from 'lucide-react'
import { ActivePill } from '@/components/bits'
import { cn } from '@/lib/utils'
import { Req } from '@/spec/req'
import { needsYou, OTHER_FOCUS_AREA_ID, useWorkModel } from '@/data'
import { resolveFocusAreaId } from '@/live/to-focus-model'

/** What the rail can select: My Work filtered to one area (or Other), the Suggested queue, or Past focus. */
/** App's page buttons use the same layoutId, so selecting anything in the rail slides the one pill there. */
export const SIDE_NAV_PILL = 'side-nav-active-pill'

export type FocusSelection = { kind: 'area'; focusAreaId: string } | { kind: 'suggested' } | { kind: 'past-focus' } | null

interface FocusNavEntry { key: string; label: string; count: number; selection: Exclude<FocusSelection, null>; muted?: boolean }

/** The entries in rail order. Rail and chip row read the same list. */
function useFocusNavEntries(): { focus: FocusNavEntry[]; pastFocus: FocusNavEntry } {
  const { focusAreas, requests } = useWorkModel()
  const needsYouIn = (id: string) => requests.filter((request) => needsYou(request) && resolveFocusAreaId(request.focusAreaId, focusAreas) === id).length
  const kept = focusAreas.filter((area) => area.status === 'kept' && !area.mergedInto)
  const suggested = focusAreas.filter((area) => area.status === 'suggested' && !area.mergedInto).length
  return {
    focus: [
      ...kept.map((area) => ({ key: area.id, label: area.name, count: needsYouIn(area.id), selection: { kind: 'area' as const, focusAreaId: area.id } })),
      { key: OTHER_FOCUS_AREA_ID, label: 'Other', count: needsYouIn(OTHER_FOCUS_AREA_ID), selection: { kind: 'area', focusAreaId: OTHER_FOCUS_AREA_ID } },
      ...(suggested > 0 ? [{ key: 'suggested', label: `${suggested} suggested`, count: 0, selection: { kind: 'suggested' as const }, muted: true }] : []),
    ],
    pastFocus: { key: 'past-focus', label: 'Past focus', count: 0, selection: { kind: 'past-focus' }, muted: true },
  }
}

const sameSelection = (a: FocusSelection, b: FocusSelection) => !!a && !!b && a.kind === b.kind && (a.kind !== 'area' || (b.kind === 'area' && a.focusAreaId === b.focusAreaId))

function Count({ count, className }: { count: number; className?: string }) {
  if (count === 0) return null
  return <span className={cn('flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1 text-[11px] font-semibold text-primary-foreground tabular-nums', className)}>{count}<span className="sr-only"> need you</span></span>
}

/** The wide rail's MY FOCUS section (lg and up). */
export function FocusRail({ selected, onSelect }: { selected: FocusSelection; onSelect: (selection: FocusSelection) => void }) {
  const { focus } = useFocusNavEntries()
  return (
    <Req ids={['R16.1', 'R16.3']}>
      <div className="space-y-0.5">
        <p className="section-label px-2 pb-1">My focus</p>
        {focus.map((entry) => (
          <button key={entry.key} type="button" onClick={() => onSelect(entry.selection)} aria-current={sameSelection(selected, entry.selection) ? 'page' : undefined}
            className={cn('relative flex min-h-9 w-full items-center gap-2 rounded-[10px] px-2 py-1.5 text-left text-[0.88rem] leading-snug transition-colors',
              sameSelection(selected, entry.selection) ? 'font-medium text-accent-foreground' : entry.muted ? 'text-muted-foreground hover:bg-card/70' : 'text-foreground/85 hover:bg-card/70')}>
            {sameSelection(selected, entry.selection) && <ActivePill layoutId={SIDE_NAV_PILL} />}
            {entry.selection.kind === 'suggested' && <SparklesIcon className="relative size-3.5 shrink-0" />}
            <span className="relative min-w-0 flex-1 break-words">{entry.label}</span>
            <Count count={entry.count} className="relative" />
          </button>
        ))}
      </div>
    </Req>
  )
}

/** Past focus, at the bottom of the rail. */
export function PastFocusLink({ selected, onSelect }: { selected: FocusSelection; onSelect: (selection: FocusSelection) => void }) {
  const { pastFocus } = useFocusNavEntries()
  const active = sameSelection(selected, pastFocus.selection)
  return (
    <Req ids={['R16.7']}>
      <button type="button" onClick={() => onSelect(pastFocus.selection)} aria-current={active ? 'page' : undefined}
        className={cn('relative flex min-h-9 w-full items-center gap-2 rounded-[10px] px-2 text-left text-xs transition-colors', active ? 'font-medium text-accent-foreground' : 'text-muted-foreground hover:bg-card/70')}>
        {active && <ActivePill layoutId={SIDE_NAV_PILL} />}
        <HistoryIcon className="relative size-3.5" /><span className="relative">Past focus</span>
      </button>
    </Req>
  )
}

/** Phones and the icon-only rail: the same entries as a chip row above the cards. It scrolls sideways; the right edge
 * fades while more chips are off screen, and the row ends with room to scroll the last chip clear of the fade. */
export function FocusChipRow({ selected, onSelect }: { selected: FocusSelection; onSelect: (selection: FocusSelection) => void }) {
  const { focus, pastFocus } = useFocusNavEntries()
  return (
    <Req ids={['R16.1', 'R11.1']} className="lg:hidden">
      <nav aria-label="My focus" className="relative -mx-4 flex gap-2 overflow-x-auto px-4 pb-1 [mask-image:linear-gradient(to_right,black_calc(100%-2.5rem),transparent)] after:shrink-0 after:basis-6 after:content-[''] md:mx-0 md:px-0 lg:hidden">
        {[...focus, pastFocus].map((entry) => {
          const active = sameSelection(selected, entry.selection)
          return (
            <button key={entry.key} type="button" onClick={() => onSelect(active ? null : entry.selection)} aria-pressed={active}
              className={cn('relative inline-flex h-11 shrink-0 items-center gap-1.5 rounded-full border px-3.5 text-sm whitespace-nowrap md:h-8',
                active ? 'border-accent-border font-medium text-accent-foreground' : entry.muted ? 'bg-card/60 text-muted-foreground' : 'bg-card')}>
              {active && <ActivePill layoutId="focus-chip-active-pill" />}
              {entry.selection.kind === 'suggested' && <SparklesIcon className="relative size-3.5" />}
              {entry.selection.kind === 'past-focus' && <HistoryIcon className="relative size-3.5" />}
              <span className="relative">{entry.label}</span>
              <Count count={entry.count} className="relative h-4 min-w-4 text-[10px]" />
            </button>
          )
        })}
      </nav>
    </Req>
  )
}
