// Swipe to decide on phones (c-aceternity-draggable-card): the DraggableCardBody, plus what the swipe will do while
// the finger is down: a coloured strip with the action's word and icon behind the card, and under it a line that
// fills toward the decide distance and then says "Let go to …". The card's own buttons do the same thing.
import { useState, type ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'
import { ArrowLeftRightIcon } from 'lucide-react'
import { DECIDE_DRAG_ELASTIC, DraggableCardBody } from '@/components/aceternity/draggable-card'
import { swipeDirection, swipeProgress, swipeToDecide, type DragOffset, type SwipeDirection } from '@/lib/swipe-to-decide'
import { usePrefersReducedMotion } from '@/lib/use-media'
import { cn } from '@/lib/utils'

/**
 * What a swipe one way does, in the caller's words: the strip's word ("Keep"), the line under the card before and
 * after the decide distance ("Swipe further to keep", "Let go to keep"), the icon, and the action its button runs.
 */
export interface SwipeAction { word: string; swipeFurther: string; letGo: string; icon: LucideIcon; onDecide: () => void }

/**
 * A decision card's button row below the md width, where the phone's bottom bar is pinned (D9: page-07 F7,
 * c-rules-suggestion-card F5, c-aceternity-draggable-card F7): it sticks 77px above the screen's bottom edge while its
 * card is on screen (the bar is 69px tall: 60px items, 8px padding and a 1px edge, App.tsx; plus 8px of air and the safe
 * area), on the card's own surface and edge to edge across the card's 16px padding, so content passing under it is
 * hidden. The row must be a direct child of the card's part below what is being decided (DECISION_CARD_BODY): a sticky
 * row never leaves its parent, so it travels that part's height and never covers the rule's sentence or the area's
 * name and goal above it (Phase 7 verify: at 390 it sat over the middle of the sentence).
 */
export const STICKY_ABOVE_BOTTOM_BAR = 'max-md:sticky max-md:bottom-[calc(77px+env(safe-area-inset-bottom))] max-md:z-10 max-md:-mx-4 max-md:w-auto max-md:bg-card max-md:px-4 max-md:pb-2'

/** The part of a decision card below what is being decided: the evidence, then the sticky button row (see above). */
export const DECISION_CARD_BODY = 'flex flex-col gap-2.5'

/** How each way looks: right keeps (the shipped green), left turns down (muted). Text on both strips is ≥4.5:1. */
const SWIPE_STRIP: Record<SwipeDirection, { strip: string; fill: string; side: string }> = {
  right: { strip: 'border-shipped-border bg-shipped text-shipped-foreground', fill: 'bg-shipped-foreground', side: 'justify-start' },
  left: { strip: 'border-control-edge bg-muted text-foreground', fill: 'bg-muted-foreground', side: 'justify-end' },
}

/** The line above the cards on phones: which way does what, and that the buttons do the same (M4, F5: readable). */
export function SwipeHint({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-center gap-2 text-sm text-muted-foreground">
      <ArrowLeftRightIcon aria-hidden="true" className="size-4 shrink-0" />
      {children}
    </p>
  )
}

export function SwipeToDecide({ right, left, disabled = false, children }: {
  right: SwipeAction; left: SwipeAction; disabled?: boolean; children: ReactNode
}) {
  // The finger's offset from where the drag started; 0 when no drag is under way. Only a mostly sideways drag has a
  // direction, so a scroll that starts on the card shows no strip (quality L2).
  const [offset, setOffset] = useState<DragOffset>({ x: 0, y: 0 })
  const direction = swipeDirection(offset)
  const action = direction ? { right, left }[direction] : null
  const progress = swipeProgress(offset.x)
  const Icon = action?.icon
  // How far the card gives way: it follows the finger at DECIDE_DRAG_ELASTIC, and the side it moves toward gives up the
  // same width, so the card narrows instead of sliding past the screen's edge and every button stays in view (M3). The
  // gap opens on the side the strip shows its word. Under reduced motion the card does not move (draggable-card.tsx),
  // so the side the strip shows its word gives up the width instead: the label is never under the card. Both read the
  // setting live from the same hook, so they agree even when it changes while the page is open.
  const reduceMotion = usePrefersReducedMotion()
  const cardShift = direction ? Math.abs(offset.x) * DECIDE_DRAG_ELASTIC : 0
  const stripWordSide = direction === 'right' ? 'left' : direction === 'left' ? 'right' : null
  const narrowedSide = stripWordSide === null ? null : reduceMotion ? stripWordSide : direction
  return (
    <div data-slot="swipe-to-decide">
      {/* overflow-x-clip: the strip and the moving card never widen the page (c-aceternity-draggable-card M3). */}
      <div className="relative overflow-x-clip rounded-xl" style={narrowedSide === 'right' ? { paddingRight: cardShift } : narrowedSide === 'left' ? { paddingLeft: cardShift } : undefined}>
        {direction && action && Icon && (
          <div aria-hidden="true" data-slot="swipe-strip" className={cn('absolute inset-0 flex items-center rounded-xl border px-3', SWIPE_STRIP[direction].strip, SWIPE_STRIP[direction].side)}>
            <span className="flex flex-col items-center gap-1 text-xs font-semibold"><Icon className="size-5" />{action.word}</span>
          </div>
        )}
        <DraggableCardBody dragAxis="x" disabled={disabled} onDragMove={setOffset}
          onDragRelease={swipeToDecide(right.onDecide, left.onDecide)}
          // overflow-visible: the card's button row sticks above the phone's bottom bar, which an overflow-hidden card stops.
          className="min-h-0 w-full overflow-visible rounded-xl bg-transparent p-0 shadow-none dark:bg-transparent">
          {children}
        </DraggableCardBody>
        {/* How far, over the top of the card so it shows however tall the card is: a line that fills toward the
            decide distance, then "Let go to …". Hidden from screen readers: a swipe is a pointer gesture, and the
            card's buttons say the same in words. */}
        {direction && action && (
          <div aria-hidden="true" data-slot="swipe-progress" className="pointer-events-none absolute inset-x-3 top-2 z-20 space-y-1 rounded-lg border border-control-edge bg-card/95 px-3 py-1.5 shadow-panel">
            <div className="h-1 overflow-hidden rounded-full bg-muted inset-ring inset-ring-control-edge">
              <div className={cn('h-full rounded-full', SWIPE_STRIP[direction].fill)} style={{ width: `${Math.round(progress * 100)}%` }} />
            </div>
            <p className="text-sm font-medium">{progress >= 1 ? action.letGo : action.swipeFurther}</p>
          </div>
        )}
      </div>
    </div>
  )
}
