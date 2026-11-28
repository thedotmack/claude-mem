// Long lists 50 rows at a time (decision G4), as the List, By agent, the Team columns and the Cards board's folded
// groups draw them (components/request-rows.tsx, pages/requests.tsx, pages/focus-area.tsx). No components here, so either board layout can
// import it (plan rule 12).
import { createContext, useContext, useEffect, useId, useRef, useState } from 'react'
import { TRIGGER_FOCUS_RING_CLASS_NAME } from '@/components/ui/interaction-behavior'
import { linePage } from '@/live/card-groups'
import { cn } from '@/lib/utils'

/**
 * The board's filter, sort and area (pages/focus-area.tsx FocusAreaPage and pages/requests.tsx provide it): when one changes, every paged list under it
 * goes back to its first page. Outside a board it is one value, so lists keep their pages.
 */
export const PagingResetContext = createContext('')

/**
 * The look of a row or card that takes focus from code (tabIndex -1: "Show 50 more" lands on it, Mark finished on a
 * subagent's status, Dismiss on the board's heading), so a keyboard user sees where focus went (G16, WCAG 2.4.7): the
 * shared trigger focus look (components/ui/interaction-behavior.ts), a 1px ring-colour edge and a 3px half ring.
 */
export const FOCUS_FROM_CODE_CLASS_NAME = cn('outline-none', TRIGGER_FOCUS_RING_CLASS_NAME)

/** What the keyboard can land on in a row: the row itself, or else a control inside it. */
const FOCUSABLE_IN_ROW = 'button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'
/** A row's own button where it has one (RequestRow, RequestLine), which comes after the agent's mark in the row. */
const ROW_TARGET = '[data-row-target], [data-request-line]'

/** Where focus goes in a row: the row when it takes focus itself (a table row, a card), else its own button. */
function rowFocusTarget(row: HTMLElement): HTMLElement | null {
  if (row.matches(FOCUSABLE_IN_ROW) || row.hasAttribute('tabindex')) return row
  return row.querySelector<HTMLElement>(ROW_TARGET) ?? row.querySelector<HTMLElement>(FOCUSABLE_IN_ROW)
}

/**
 * One list's rows 50 at a time (G4, live/card-groups.ts LINE_ROWS_PER_PAGE: UI UX Pro Max virtualize-lists draws at most
 * 50 at once), and where the keyboard lands after "Show 50 more": on the first row it added, so a keyboard user carries
 * on from there (on the last page the button itself is gone). The rows mark themselves `data-list-row` as children
 * of the element whose id is `listId`; rows of a list nested inside one of them (a card's open Subagents fold) are
 * that list's, not this one's. `startOpen` false is a folded group: no rows until it opens.
 */
export function usePagedRows(total: number, startOpen: boolean) {
  const resetKey = useContext(PagingResetContext)
  const [pages, setPages] = useState(startOpen ? 1 : 0)
  // A new filter, sort or area starts every list on its first page again, without remounting it (React's way to follow
  // a value while rendering), so the control just pressed keeps its focus.
  const [pagedFor, setPagedFor] = useState(resetKey)
  if (pagedFor !== resetKey) {
    setPagedFor(resetKey)
    setPages(startOpen ? 1 : 0)
  }
  const listId = useId()
  const focusRowAt = useRef<number | null>(null)
  const { shown, left } = linePage(total, pages)
  useEffect(() => {
    const index = focusRowAt.current
    if (index === null) return
    focusRowAt.current = null
    const row = document.getElementById(listId)?.querySelectorAll<HTMLElement>(':scope > [data-list-row]')[index]
    if (row) rowFocusTarget(row)?.focus()
  }, [shown, listId])
  return {
    listId, shown, left, open: pages > 0,
    setOpen: (open: boolean) => setPages(open ? 1 : 0),
    showMore: () => { focusRowAt.current = shown; setPages((current) => current + 1) },
  }
}
