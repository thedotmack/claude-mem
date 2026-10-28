// Swipe to decide on phones: My Rules suggestions and suggested focus areas. Right keeps, left turns down.
import { useMatchesMedia } from '@/lib/use-media'

// Phones are under Tailwind's sm breakpoint (640px), where the decision cards' buttons go full width too.
const PHONE_QUERY = '(max-width: 639px)'
export const useIsPhone = () => useMatchesMedia(PHONE_QUERY)

// A quarter of a 390px phone screen: a sideways wobble while scrolling doesn't decide, one thumb flick does.
const SWIPE_DECIDES_AT_PX = 96

/** The drag-release handler: a far enough flick right calls `onRight`, left calls `onLeft`; anything shorter does nothing. */
export const swipeToDecide = (onRight: () => void, onLeft: () => void) => ({ x }: { x: number }) => {
  if (x >= SWIPE_DECIDES_AT_PX) onRight()
  else if (x <= -SWIPE_DECIDES_AT_PX) onLeft()
}
