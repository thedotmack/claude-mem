// A link to another place in My Work: a real address (it opens in a new tab, its link can be copied), and a plain
// press moves there in the page, without a reload. The bar's places, the brand, the focus area breadcrumb and the
// links between pages use it.
import type { MouseEvent } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useStore, type Section } from '@/store'
import type { ViewState } from '@/store/store-types'
import { NO_PAGE_DETAILS, requestsPlace, writeRoute, type RequestsMove } from '@/store/slices/view-slice'

/** A press handler that moves in the page on a plain left click and leaves every other click to the browser. */
export function placeLinkPress(go: () => void) {
  return (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    event.preventDefault()
    go()
  }
}

/**
 * The address of a page in My Work, from the page's own address: its `source` is kept, and its `?theme=` while that
 * still sets this visit's theme. The link is drawn again when the visit's theme changes, since picking a theme in the
 * menu takes `?theme=` out of the address (view-slice setTheme); a link drawn before that would keep forcing the old one
 * on a new tab or a copied link.
 */
export function usePageHref(section: Section): string {
  useStore((state) => state.view.themeForThisVisit)
  return writeRoute(new URL(window.location.href), { section, openRequest: null, ...NO_PAGE_DETAILS }).href
}

/** The address of a focus area's page (`?focus=<id>`), from the page's own address as usePageHref keeps it. */
export function useFocusHref(focusAreaId: string): string {
  useStore((state) => state.view.themeForThisVisit)
  return writeRoute(new URL(window.location.href), { section: 'work', openRequest: null, ...NO_PAGE_DETAILS, focusChoice: focusAreaId }).href
}

/** The place shown, as an address names it (without the open request), and the visit's theme, which the address carries. */
const placeShown = ({ view }: { view: ViewState }) => ({
  section: view.section, focusChoice: view.focusChoice, findQuery: view.findQuery, requestsStatus: view.requestsStatus, requestsBy: view.requestsBy,
  requestsArea: view.requestsArea, requestsClosed: view.requestsClosed, requestsWords: view.requestsWords, themeForThisVisit: view.themeForThisVisit,
})

/**
 * The address a move on Requests goes to (pages/requests.tsx: a status tab, By agent, the list): on the list, the list's
 * other details as shown (store/slices/view-slice.ts requestsPlace).
 */
export function useRequestsHref(move: RequestsMove): string {
  const place = useStore(useShallow(placeShown))
  return writeRoute(new URL(window.location.href), { ...requestsPlace({ ...place, openRequest: null }, move), openRequest: null }).href
}

/**
 * The address of a request opened over the page shown (`?request=`, kept with the page's own details), for the rows
 * that are links to their request (components/request-rows.tsx RequestListRow).
 */
export function useRequestHref(): (requestId: string) => string {
  const place = useStore(useShallow(placeShown))
  return (requestId) => writeRoute(new URL(window.location.href), { ...place, openRequest: { id: requestId, fromLiveFeed: null, fallback: null } }).href
}
