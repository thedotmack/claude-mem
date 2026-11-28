// Runs one scroll ask from the store (view.scrollAsk) once its page has drawn: App.tsx calls it after each move.
import type { ScrollTarget } from '@/store'

/** What a person does that ends the hold on a position: from then on the page is theirs to scroll. */
const PERSON_INPUT = ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const

/**
 * Scrolls to `target` and returns the stop. A new page goes to its top, Requests and Focus areas to their boards.
 * Back, Forward and a reload go to where the person left the page, and hold it there: the page can still change after
 * it first draws. A page that reads its data again on each visit (Review Stack) or whose code is still loading draws
 * short, so the window can only go part of the way; artwork and layout that settle a frame later change the height
 * above the position, and the browser's scroll anchoring then moves the window. Each change of the page's height puts
 * the window back at the position, until the person scrolls, presses or types, or the next move asks again (the stop).
 */
export function runScrollAsk(target: ScrollTarget): () => void {
  if (target.to === 'top') { window.scrollTo(0, 0); return () => {} }
  if (target.to === 'element') {
    const element = document.getElementById(target.elementId)
    if (element) element.scrollIntoView({ block: 'start' })
    else console.warn(`[my-work] #${target.elementId} is not on the page`)
    return () => {}
  }
  const { y } = target
  window.scrollTo(0, y)
  // Within a pixel: a position can be fractional where the page's height is not.
  const hold = new ResizeObserver(() => { if (Math.abs(window.scrollY - y) > 1) window.scrollTo(0, y) })
  function stop() {
    hold.disconnect()
    for (const type of PERSON_INPUT) window.removeEventListener(type, stop, true)
  }
  hold.observe(document.body)
  for (const type of PERSON_INPUT) window.addEventListener(type, stop, { capture: true, passive: true })
  return stop
}
