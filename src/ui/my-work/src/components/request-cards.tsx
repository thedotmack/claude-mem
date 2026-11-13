// One focus's requests as cards (the Cards choice of the Threads / Board / Cards switch), in sections by what they
// need. The grid and its cells came from the Cards view My Work had before the thread list.
import { useState, type ReactNode } from 'react'
import { motion } from 'motion/react'
import { ChevronDownIcon } from 'lucide-react'
import { interpolate, useI18n } from '@/lib/i18n'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { Request } from '@/data'
import { cardGridEntries } from '@/live/card-groups'
import { RequestCard } from './request-card'

/** card-hover-effect, in place: a soft panel fades in behind the card the pointer is on. It never slides between cards. */
export function HoverCell({ children }: { children: ReactNode }) {
  return (
    <div className="group/hover-cell relative min-w-0">
      <span aria-hidden="true" className="pointer-events-none absolute -inset-2 block rounded-2xl bg-accent/70 opacity-0 transition-opacity duration-150 group-hover/hover-cell:opacity-100" />
      <div className="relative h-full">{children}</div>
    </div>
  )
}

/** A card glides to its new place when the order changes (a status moved, a new request arrived). Position only:
 * a card that grows or shrinks snaps, so text never stretches mid-animation. Off under reduced motion (MotionConfig). */
export const GLIDE = { type: 'spring', bounce: 0.15, duration: 0.55 } as const

function CardCell({ request, onOpen }: { request: Request; onOpen: (request: Request) => void }) {
  return (
    <motion.div layout="position" transition={GLIDE} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="min-w-0">
      <HoverCell>
        <RequestCard request={request} onOpen={() => onOpen(request)} />
      </HoverCell>
    </motion.div>
  )
}

/**
 * The cards sit under section headings in one grid, so a card whose status changes glides from one section to the
 * other. Cards keep their own height: a short card does not stretch to the tallest card in its row. `showDone` is
 * the Done filter: the person asked for those requests, so that section is not folded to its newest few.
 */
export function RequestCards({ requests, showDone, onOpen }: { requests: Request[]; showDone: boolean; onOpen: (request: Request) => void }) {
  const { t } = useI18n()
  const [unfolded, setUnfolded] = useState<Record<string, boolean>>({})
  return (
    <div className="grid grid-cols-1 items-start gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {cardGridEntries(requests, { done: showDone, ...unfolded }).map((entry) => entry.kind === 'card'
        ? <CardCell key={entry.key} request={entry.request} onOpen={onOpen} />
        : (
          <motion.div key={entry.key} layout="position" transition={GLIDE} className="col-span-full flex items-center gap-2.5 pt-2 first:pt-0">
            <span className={cn('size-2 rounded-full', entry.group.dot)} />
            <h3 className="text-sm font-semibold tracking-tight">{t(entry.group.label)}</h3>
            <span className="text-sm text-muted-foreground tabular-nums">{entry.count}</span>
            <span className="h-px flex-1 bg-border/70" />
            {entry.folds && (
              <Button variant="ghost" size="sm" className="h-11 text-xs text-muted-foreground md:h-7" aria-expanded={entry.open} onClick={() => setUnfolded((current) => ({ ...current, [entry.group.id]: !entry.open }))}>
                {entry.open ? t('Show fewer') : interpolate(t('Show all {count}'), { count: entry.count })}<ChevronDownIcon className={cn('transition-transform', entry.open && 'rotate-180')} />
              </Button>
            )}
          </motion.div>
        ))}
    </div>
  )
}
