// Where Tab goes next, for pieces that leave the page or are drawn away from the button that opened them (a portal at
// the end of the page): focus then moves where Tab would have gone, instead of falling to the page body (WCAG 2.4.3).

const CAN_TAKE_TAB = 'a[href], button, input, select, textarea, summary, [tabindex], [contenteditable="true"]'

/** The elements Tab stops on inside `root`, in page order: tabindex 0 or more, not disabled, not inert, drawn. */
export function tabStops(root: ParentNode = document): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(CAN_TAKE_TAB)].filter((element) =>
    element.tabIndex >= 0 && !element.matches(':disabled') && !element.closest('[inert]') && element.getClientRects().length > 0)
}

/** The first Tab stop after `element` in page order, outside it and outside `leaveOut`; null at the end of the page. */
export function tabStopAfter(element: Element, leaveOut?: Element): HTMLElement | null {
  return tabStops().find((stop) => !element.contains(stop) && !leaveOut?.contains(stop)
    && (element.compareDocumentPosition(stop) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0) ?? null
}
