// A link to another place in My Work: a real address (it opens in a new tab, its link can be copied), and a plain
// press moves there in the page, without a reload. The bar's places, the brand, the focus area breadcrumb and the
// links between pages use it.
import type { MouseEvent } from 'react'
import { useStore, type Section } from '@/store'
import { writeRoute } from '@/store/slices/view-slice'

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
  return writeRoute(new URL(window.location.href), { section, focusChoice: null, openRequest: null, findQuery: null }).href
}
