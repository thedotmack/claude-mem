// Swipe to decide on phones: My Rules suggestions and suggested focus areas. Right keeps, left turns down.
import { useMatchesMedia } from '@/lib/use-media'

// Phones are under Tailwind's sm breakpoint (640px), where the decision cards' buttons go full width too.
const PHONE_QUERY = '(max-width: 639px)'
export const useIsPhone = () => useMatchesMedia(PHONE_QUERY)

// A quarter of a 390px phone screen: a sideways wobble while scrolling doesn't decide, one thumb flick does.
export const SWIPE_DECIDES_AT_PX = 96

/** How far a drag has gone from where it started: the finger's offset on each axis. */
export interface DragOffset { x: number; y: number }

/**
 * A drag that points more sideways than up or down (within 45° of horizontal). Only such a drag shows the strip and
 * decides; a scroll that starts on the card goes mostly up or down, so it shows nothing and decides nothing
 * (c-aceternity-draggable-card F6, quality L2).
 */
export const isSideways = ({ x, y }: DragOffset) => Math.abs(x) > Math.abs(y)

/** Which way a drag points, once it is mostly sideways: right keeps, left turns down. */
export type SwipeDirection = 'right' | 'left'
export const swipeDirection = (offset: DragOffset): SwipeDirection | null => !isSideways(offset) ? null : offset.x > 0 ? 'right' : 'left'
/** How far a drag is toward deciding, 0 to 1 (1: letting go decides). */
export const swipeProgress = (x: number) => Math.min(1, Math.abs(x) / SWIPE_DECIDES_AT_PX)

/**
 * The drag-release handler: a mostly sideways flick far enough right calls `onRight`, left calls `onLeft`; anything
 * shorter, or mostly up or down, does nothing.
 */
export const swipeToDecide = (onRight: () => void, onLeft: () => void) => (offset: DragOffset) => {
  if (!isSideways(offset)) return
  if (offset.x >= SWIPE_DECIDES_AT_PX) onRight()
  else if (offset.x <= -SWIPE_DECIDES_AT_PX) onLeft()
}
