// Runs one scroll ask from the store (view.scrollAsk) once its page has drawn: App.tsx calls it after each move.
import type { ScrollTarget } from '@/store'

/**
 * What a person does that ends the hold on a position: from then on the page is theirs to scroll. A click counts on its
 * own: assistive technology activates a control with a click and no press or key before it, and the hold then undid
 * whatever scrolled the page next (Review Stack's browser test, which presses that way: its swipe landed on the page
 * the hold had scrolled back, design pass Phase 6 fixes).
 */
const PERSON_INPUT = ['wheel', 'touchstart', 'pointerdown', 'keydown', 'click'] as const

/**
 * Scrolls to `target` and returns the stop. A new page goes to its top, Requests and Focus areas to their boards, and
 * an element asked for by id to that element, once the page has drawn it.
 * Back, Forward and a reload go to where the person left the page, and hold it there: the page can still change after
 * it first draws. A page that reads its data again on each visit (Review Stack) or whose code is still loading draws
 * short, so the window can only go part of the way; artwork and layout that settle a frame later change the height
 * above the position, and the browser's scroll anchoring then moves the window. Each change of the page's height puts
 * the window back at the position, until the person scrolls, presses or types, or the next move asks again (the stop).
 */
export function runScrollAsk(target: ScrollTarget): () => void {
  if (target.to === 'top') { window.scrollTo(0, 0); return () => {} }
  if (target.to === 'element') {
    const { elementId } = target
    const element = document.getElementById(elementId)
    if (element) { element.scrollIntoView({ block: 'start' }); return () => {} }
    // A page whose code is still loading (My Rules, for a rule Find work opened) draws the element later: it is
    // scrolled to once it is on the page, unless the person scrolls, presses or types first, or the next move asks.
    // A wait that ends with no such element says so: the id that was asked for is not on the page.
    let waiting = true
    const arrival = new MutationObserver(() => {
      const arrived = document.getElementById(elementId)
      if (!arrived) return
      stopObserving()
      arrived.scrollIntoView({ block: 'start' })
    })
    function stopObserving() {
      waiting = false
      arrival.disconnect()
      for (const type of PERSON_INPUT) window.removeEventListener(type, stopWaiting, true)
    }
    function stopWaiting() {
      if (!waiting) return
      stopObserving()
      console.warn(`[my-work] #${elementId} is not on the page`)
    }
    arrival.observe(document.body, { childList: true, subtree: true })
    for (const type of PERSON_INPUT) window.addEventListener(type, stopWaiting, { capture: true, passive: true })
    return stopWaiting
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
