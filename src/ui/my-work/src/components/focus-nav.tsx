// MY FOCUS: four kept areas in priority order (the owner's order wins), then Other, then "N suggested", each with how
// many requests in it need you. On the wide rail it is a nav section; on phones and the icon-only rail, a chip row.
// The rail's highlight is App's side-nav pill: one pill slides between focus areas, pages and Past focus.
// Rows and chips are Buttons (G14), so they share the Button's focus ring, pointer cursor and touch size
// (c-shell-focus-nav F focus-states, cursor-pointer); "All N" says how many areas the short list leaves out (rule 5).
import { useId, useMemo } from 'react'
import { ChevronRightIcon, Grid2X2Icon, HistoryIcon, SparklesIcon } from 'lucide-react'
import { interpolate, useI18n } from '@/lib/i18n'
import { ActivePill, NeedsYouPill } from '@/components/bits'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { Req } from '@/spec/req'
import { OTHER_FOCUS_AREA_ID } from '@/data'
import { useWorkModel } from '@/store'
import { focusNavActivity, focusNavAreas } from '@/live/focus-nav'
import { keptFocusAreas } from '@/live/focus-overview'

/** What the rail can select: My Work filtered to one area (or Other), the Suggested queue, or Past focus. */
/** App's page buttons use the same layoutId, so selecting anything in the rail slides the one pill there. */
export const SIDE_NAV_PILL = 'side-nav-active-pill'

export type FocusSelection = { kind: 'area'; focusAreaId: string } | { kind: 'suggested' } | { kind: 'past-focus' } | null

/** `moving`: a request in it is working right now, so the entry says "moving". */
interface FocusNavEntry { key: string; label: string; count: number; moving?: boolean; selection: Exclude<FocusSelection, null>; muted?: boolean }

/** The entries in rail order, and how many kept areas there are in all. Rail and chip row read the same list. */
function useFocusNavEntries(selected: FocusSelection): { focus: FocusNavEntry[]; pastFocus: FocusNavEntry; areaCount: number } {
  const { t } = useI18n()
  const { focusAreas, requests } = useWorkModel()
  const activity = useMemo(() => focusNavActivity(focusAreas, requests), [focusAreas, requests])
  const kept = focusNavAreas(focusAreas, selected?.kind === 'area' ? selected.focusAreaId : null)
  const suggested = focusAreas.filter((area) => area.status === 'suggested' && !area.mergedInto).length
  return {
    focus: [
      ...kept.map((area) => ({ key: area.id, label: area.name, count: activity.get(area.id)?.count ?? 0, moving: activity.get(area.id)?.moving, selection: { kind: 'area' as const, focusAreaId: area.id } })),
      { key: OTHER_FOCUS_AREA_ID, label: t('Other'), count: activity.get(OTHER_FOCUS_AREA_ID)?.count ?? 0, moving: activity.get(OTHER_FOCUS_AREA_ID)?.moving, selection: { kind: 'area', focusAreaId: OTHER_FOCUS_AREA_ID } },
      ...(suggested > 0 ? [{ key: 'suggested', label: interpolate(t('{count} suggested'), { count: suggested }), count: 0, selection: { kind: 'suggested' as const }, muted: true }] : []),
    ],
    pastFocus: { key: 'past-focus', label: t('Past focus'), count: 0, selection: { kind: 'past-focus' }, muted: true },
    areaCount: keptFocusAreas(focusAreas).length,
  }
}

const sameSelection = (a: FocusSelection, b: FocusSelection) => !!a && !!b && a.kind === b.kind && (a.kind !== 'area' || (b.kind === 'area' && a.focusAreaId === b.focusAreaId))

/** Work is moving in this area right now: a still dot and the word, so it never rests on colour (c-shell-focus-nav M). */
function MovingWord({ moving, className }: { moving?: boolean; className?: string }) {
  const { t } = useI18n()
  if (!moving) return null
  return (
    <span className={cn('inline-flex shrink-0 items-center gap-1 text-xs font-normal text-muted-foreground', className)}>
      <span aria-hidden="true" className="size-1.5 rounded-full bg-working-foreground" />{t('moving')}
    </span>
  )
}

/** A chip's count: compact, for a row that scrolls sideways. */
function Count({ count, className }: { count: number; className?: string }) {
  const { t } = useI18n()
  if (count === 0) return null
  return <span className={cn('flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1 text-[11px] font-semibold text-primary-foreground tabular-nums', className)}>{count}<span className="sr-only"> {t('need you')}</span></span>
}

/**
 * One row of the wide rail. Selected, it takes the side-nav pill with its edge and orange bar (c-bits-active-pill).
 * c-shell-focus-nav Keep: rows 38–54px, as at HEAD. At the 17px root a one-line row is the 38.25px minimum and a
 * two-line one 51.6px (two 20.6px lines, 4.25px padding top and bottom, the Button's 1px edge).
 */
const RAIL_ROW_CLASS_NAME = 'relative flex w-full items-center gap-2 rounded-[10px] px-2 py-1 text-[0.88rem] leading-snug transition-colors md:not-pointer-coarse:min-h-9'

/**
 * "All N": every focus area on the home page's board, shown whole (`/#focus-areas`). Its name is its visible words, so
 * speech input finds it in every language (label in name); where it leads is its description, read after the name.
 */
function AllAreasButton({ count, onShowAllAreas, look }: { count: number; onShowAllAreas: () => void; look: 'rail' | 'chip' }) {
  const { t } = useI18n()
  const descriptionId = useId()
  const words = interpolate(t('All {count}'), { count })
  return (
    <>
      {look === 'rail' ? (
        // xs is 29.75px tall at the 17px root: at least the 24px plan rule 6 asks on desktop, and 44px on touch.
        <Button variant="link" size="xs" onClick={onShowAllAreas} aria-describedby={descriptionId} className="px-0 text-xs tabular">{words}</Button>
      ) : (
        <Button variant="bare" onClick={onShowAllAreas} aria-describedby={descriptionId} className={cn(CHIP_CLASS_NAME, 'bg-card tabular')}>
          {words}<ChevronRightIcon aria-hidden="true" className="size-3.5" />
        </Button>
      )}
      <span id={descriptionId} hidden>{interpolate(t('Show all {count} focus areas'), { count })}</span>
    </>
  )
}

/**
 * The wide rail's MY FOCUS section (lg and up). `onShowAllAreas`: where "All N" goes; without it the row has no "All N"
 * (callers from before 16.0.0, such as PR #6054's board, pass none).
 */
export function FocusRail({ selected, onSelect, onShowAllAreas }: { selected: FocusSelection; onSelect: (selection: FocusSelection) => void; onShowAllAreas?: () => void }) {
  const { t } = useI18n()
  const { focus, areaCount } = useFocusNavEntries(selected)
  return (
    <Req ids={['R16.1', 'R16.3']}>
      <div className="space-y-0.5">
        <div className="flex items-center justify-between gap-2 px-2 pb-1">
          <p className="section-label">{t('My focus')}</p>
          {onShowAllAreas && areaCount > 0 && <AllAreasButton count={areaCount} onShowAllAreas={onShowAllAreas} look="rail" />}
        </div>
        {focus.map((entry) => {
          const active = sameSelection(selected, entry.selection)
          return (
            <Button key={entry.key} variant="bare" onClick={() => onSelect(entry.selection)} aria-current={active ? 'page' : undefined}
              className={cn(RAIL_ROW_CLASS_NAME, active ? 'font-medium text-accent-foreground' : entry.muted ? 'text-muted-foreground hover:bg-card/70' : 'text-foreground/85 hover:bg-card/70')}>
              {active && <ActivePill layoutId={SIDE_NAV_PILL} look="rail" />}
              {entry.selection.kind === 'suggested' && <SparklesIcon className="relative size-3.5 shrink-0" />}
              <span className="relative min-w-0 flex-1 break-words">{entry.label}</span>
              <MovingWord moving={entry.moving} className="relative" />
              <NeedsYouPill count={entry.count} className="relative" />
            </Button>
          )
        })}
        <Button variant="bare" onClick={() => onSelect(null)} className={cn(RAIL_ROW_CLASS_NAME, 'text-xs text-muted-foreground hover:bg-card/70')}>
          <Grid2X2Icon aria-hidden="true" className="size-3.5 shrink-0" /><span>{t('Focus overview')}</span>
        </Button>
      </div>
    </Req>
  )
}

/** Past focus, at the bottom of the rail. */
export function PastFocusLink({ selected, onSelect }: { selected: FocusSelection; onSelect: (selection: FocusSelection) => void }) {
  const { t } = useI18n()
  const selection = { kind: 'past-focus' } as const
  const active = sameSelection(selected, selection)
  return (
    <Req ids={['R16.7']}>
      <Button variant="bare" onClick={() => onSelect(selection)} aria-current={active ? 'page' : undefined}
        className={cn(RAIL_ROW_CLASS_NAME, 'text-xs', active ? 'font-medium text-accent-foreground' : 'text-muted-foreground hover:bg-card/70')}>
        {active && <ActivePill layoutId={SIDE_NAV_PILL} look="rail" />}
        <HistoryIcon className="relative size-3.5" /><span className="relative">{t('Past focus')}</span>
      </Button>
    </Req>
  )
}

/**
 * One chip. Its own edge is the ≥3:1 control edge (G12); chosen, the edge turns the accent text colour and the pill
 * fills it, so the chosen chip has one edge, not two. 34px at the icon-only rail's 17px root; on a phone and on touch
 * the Button's own rule makes it 44px (plan rule 6: the primitive owns it).
 */
const CHIP_CLASS_NAME = 'relative inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border border-control-edge px-3.5 text-sm font-normal whitespace-nowrap'

/**
 * Phones and the icon-only rail: the same entries as a chip row above the cards. It scrolls sideways; the right edge
 * fades while more chips are off screen, and the row ends with "All N" (when `onShowAllAreas` is passed, as for
 * FocusRail) and room to scroll it clear of the fade.
 */
export function FocusChipRow({ selected, onSelect, onShowAllAreas }: { selected: FocusSelection; onSelect: (selection: FocusSelection) => void; onShowAllAreas?: () => void }) {
  const { t } = useI18n()
  const { focus, pastFocus, areaCount } = useFocusNavEntries(selected)
  return (
    <Req ids={['R16.1', 'R11.1']} className="lg:hidden">
      <nav aria-label={t('My focus')} className="relative -mx-4 flex gap-2 overflow-x-auto px-4 pb-1 [mask-image:linear-gradient(to_right,black_calc(100%-2.5rem),transparent)] after:shrink-0 after:basis-6 after:content-[''] md:mx-0 md:px-0 lg:hidden">
        <Button variant="bare" onClick={() => onSelect(null)} className={cn(CHIP_CLASS_NAME, 'bg-card')}>
          <Grid2X2Icon aria-hidden="true" className="size-3.5" />{t('Focus overview')}
        </Button>
        {[...focus, pastFocus].map((entry) => {
          const active = sameSelection(selected, entry.selection)
          return (
            <Button key={entry.key} variant="bare" onClick={() => onSelect(active ? null : entry.selection)} aria-pressed={active}
              className={cn(CHIP_CLASS_NAME, active ? 'border-accent-foreground font-medium text-accent-foreground' : entry.muted ? 'bg-card/60 text-muted-foreground' : 'bg-card')}>
              {active && <ActivePill layoutId="focus-chip-active-pill" />}
              {entry.selection.kind === 'suggested' && <SparklesIcon className="relative size-3.5" />}
              {entry.selection.kind === 'past-focus' && <HistoryIcon className="relative size-3.5" />}
              <span className="relative">{entry.label}</span>
              <MovingWord moving={entry.moving} className="relative" />
              <Count count={entry.count} className="relative h-4 min-w-4 text-[10px]" />
            </Button>
          )
        })}
        {onShowAllAreas && areaCount > 0 && <AllAreasButton count={areaCount} onShowAllAreas={onShowAllAreas} look="chip" />}
      </nav>
    </Req>
  )
}
