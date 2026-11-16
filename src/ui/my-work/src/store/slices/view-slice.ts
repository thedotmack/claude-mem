// Where the person is (the URL holds it, so reload and Back/Forward work) and how they like to see My Work
// (persisted: index.ts names the fields).
import { OTHER_FOCUS_AREA_ID } from '../../data.ts'
import { isThemeChoice, type ThemeChoice } from '../../lib/theme.ts'
import { resolveFocusAreaId } from '../../live/to-focus-model.ts'
import { usageReport } from '../../live/usage.ts'
import type { SliceCreator } from '../create-store.ts'
import { homeAnchorFromHash, type HomeAnchor } from '../home-anchor.ts'
import type { OpenRequest, Page, Section, StoreEnvironment, ViewSlice, ViewState } from '../store-types.ts'

const SECTIONS: readonly Section[] = ['work', 'rules', 'suggested', 'past-focus']

interface Route {
  page: Page; section: Section; focusChoice: string | null; requestId: string | null; theme: ThemeChoice | null
  homeAnchor: HomeAnchor | null
}

/**
 * `?setup=1` is the installer handoff; `?view=` a page other than My Work; `?focus=` an area; `?request=` the open
 * drawer; `?theme=` the theme for this visit; `#all-requests` or `#focus-areas` a place on the home page.
 */
export function readRoute(url: URL): Route {
  const view = url.searchParams.get('view') as Section | null
  const section = view && SECTIONS.includes(view) ? view : 'work'
  const focusChoice = section === 'work' ? url.searchParams.get('focus') || null : null
  const theme = url.searchParams.get('theme')
  return {
    page: url.searchParams.get('setup') === '1' ? 'setup' : 'app',
    section,
    focusChoice,
    requestId: url.searchParams.get('request') || null,
    // G8: `?theme=` wins over the saved choice for this visit only (view.themeForThisVisit; never saved).
    theme: isThemeChoice(theme) ? theme : null,
    homeAnchor: section === 'work' && !focusChoice ? homeAnchorFromHash(url.hash) : null,
  }
}

/** The same URL with the route's params and home anchor; every other param (`source`, `theme`) is kept. */
export function writeRoute(url: URL, view: Pick<ViewState, 'section' | 'focusChoice' | 'openRequest' | 'homeAnchor'>): URL {
  const next = new URL(url)
  const set = (name: string, value: string | null) => { if (value) next.searchParams.set(name, value); else next.searchParams.delete(name) }
  set('view', view.section === 'work' ? null : view.section)
  set('focus', view.section === 'work' ? view.focusChoice : null)
  set('request', view.openRequest?.id ?? null)
  next.hash = view.section === 'work' && !view.focusChoice && view.homeAnchor ? view.homeAnchor : ''
  return next
}

export const createViewSlice = (environment: StoreEnvironment): SliceCreator<ViewSlice> => (set, get) => {
  const route = readRoute(new URL(environment.href()))
  let openReported = false
  // Every ask for a home anchor gets a sequence number this store never used, so a new ask always differs from an old
  // one, even after the old one was cleared (an address opened with an anchor is ask 1).
  let homeAnchorAsks = route.homeAnchor ? 1 : 0

  /**
   * Shows the next place and records it in the URL. Showing another section is counted with the section it left. A
   * place that is not a home anchor clears the last anchor ask (`homeAnchorRequest: null` in `change`).
   */
  const navigate = (change: Partial<Pick<ViewState, 'section' | 'focusChoice' | 'openRequest' | 'homeAnchor' | 'homeAnchorRequest'>>, replace = false) => {
    const previous = get().view.section
    set((state) => { Object.assign(state.view, change) })
    const next = get().view.section
    if (environment.reportsUsage && next !== previous) environment.sendUsage(usageReport(next, previous))
    const current = new URL(environment.href())
    const url = writeRoute(current, get().view)
    if (url.href !== current.href) environment.writeUrl(url, replace)
  }

  const requestInFeed = (id: string) => {
    const load = get().work.load
    return load.state === 'loaded' ? load.model.requests.find((request) => request.id === id) ?? null : null
  }

  return {
    view: {
      page: route.page,
      section: route.section,
      focusChoice: route.focusChoice,
      openRequest: route.requestId ? { id: route.requestId, fromLiveFeed: null, fallback: null } : null,
      homeAnchor: route.homeAnchor,
      // An address opened with an anchor scrolls there once the home page draws.
      homeAnchorRequest: route.homeAnchor ? { anchor: route.homeAnchor, sequence: homeAnchorAsks } : null,
      workspace: { mode: 'home', team: false, connected: false },
      showSpec: false,
      // The saved choice replaces this when there is one (create-store.ts merge); `?theme=` sits beside it.
      theme: 'system',
      themeForThisVisit: route.theme,
      listView: 'cards',
      filter: 'all',
      sort: 'attention',
      focusArtwork: 'full',
    },

    goToPage: (page) => navigate({ section: page, focusChoice: null, homeAnchor: null, homeAnchorRequest: null }),
    goToFocus: (focusAreaId) => navigate({ section: 'work', focusChoice: focusAreaId, openRequest: null, homeAnchor: null, homeAnchorRequest: null }),
    goToHome: (anchor) => {
      if (!anchor) {
        navigate({ section: 'work', focusChoice: null, openRequest: null, homeAnchor: null, homeAnchorRequest: null })
        environment.scrollToTop()
        return
      }
      homeAnchorAsks += 1
      navigate({ section: 'work', focusChoice: null, openRequest: null, homeAnchor: anchor, homeAnchorRequest: { anchor, sequence: homeAnchorAsks } })
    },
    selectFocus: (selection) => {
      if (!selection) get().goToHome(null)
      else if (selection.kind === 'area') get().goToFocus(selection.focusAreaId)
      else navigate({ section: selection.kind, focusChoice: null, homeAnchor: null, homeAnchorRequest: null })
    },

    openRequestDrawer: (request) => {
      const open: OpenRequest = { id: request.id, fromLiveFeed: requestInFeed(request.id) !== null, fallback: request }
      navigate({ openRequest: open })
    },
    closeRequestDrawer: () => navigate({ openRequest: null }),

    // The drawer shows the current state of today's requests; older goal-only requests show as they were passed.
    // A request that leaves the live feed closes the drawer (its agent and device may have left the model with it),
    // and is forgotten, so the drawer never reopens by itself if that request later returns.
    reconcileOpenRequest: () => {
      const open = get().view.openRequest
      if (!open || get().work.load.state !== 'loaded') return
      const live = requestInFeed(open.id)
      if (live && open.fromLiveFeed !== true) set((state) => { state.view.openRequest = { ...open, fromLiveFeed: true } })
      else if (!live && open.fromLiveFeed !== false) navigate({ openRequest: null }, true)
    },

    showUrl: () => {
      const next = readRoute(new URL(environment.href()))
      const open = get().view.openRequest
      const previous = get().view.section
      set((state) => {
        state.view.section = next.section
        state.view.focusChoice = next.focusChoice
        state.view.openRequest = !next.requestId ? null : open?.id === next.requestId ? open : { id: next.requestId, fromLiveFeed: null, fallback: null }
        // Back and Forward restore the scroll position themselves, so this records the place without a jump.
        state.view.homeAnchor = next.homeAnchor
        // An anchor ask ends once Back or Forward leaves its place, so a board drawn later never acts on it.
        if (state.view.homeAnchorRequest?.anchor !== next.homeAnchor) state.view.homeAnchorRequest = null
      })
      if (environment.reportsUsage && next.section !== previous) environment.sendUsage(usageReport(next.section, previous))
      get().reconcileOpenRequest()
    },

    startSetup: () => {
      const url = new URL(environment.href())
      url.searchParams.set('setup', '1')
      environment.writeUrl(url, true)
      if (environment.reportsUsage) environment.sendUsage(usageReport('setup', get().view.section))
      set((state) => { state.view.page = 'setup' })
    },

    finishSetup: () => {
      const url = new URL(environment.href())
      url.searchParams.delete('setup')
      environment.writeUrl(url, true)
      environment.scrollToTop()
      if (environment.reportsUsage) environment.sendUsage(usageReport('work', 'setup'))
      set((state) => { state.view.page = 'app'; state.view.section = 'work' })
    },

    // One count for the page the viewer opened on. StrictMode runs effects twice in development; the flag keeps
    // that to one call on this store. The sender also drops a second open in the same document, because a rebuilt
    // store (a new closure, `openReported` false again) is what repeated `{event:'opened'}` for view=work while
    // switches stayed rare: the effect was `useEffect(reportOpen, [reportOpen])`, so a new action identity posted again.
    reportOpen: () => {
      if (!environment.reportsUsage || openReported) return
      openReported = true
      const { page, section } = get().view
      environment.sendUsage(usageReport(page === 'setup' ? 'setup' : section, null))
    },

    setWorkspace: (change) => set((state) => { Object.assign(state.view.workspace, change) }),
    setShowSpec: (showSpec) => set((state) => { state.view.showSpec = showSpec }),
    setTheme: (theme) => {
      set((state) => { state.view.theme = theme; state.view.themeForThisVisit = null })
      // `?theme=` only starts a visit (G8). A choice made in the menu is saved, so the address stops overriding it;
      // otherwise a reload would bring back the address's theme.
      const url = new URL(environment.href())
      if (!url.searchParams.has('theme')) return
      url.searchParams.delete('theme')
      environment.writeUrl(url, true)
    },
    setListView: (listView) => set((state) => { state.view.listView = listView }),
    setFilter: (filter) => set((state) => { state.view.filter = filter }),
    setSort: (sort) => set((state) => { state.view.sort = sort }),
    setFocusArtwork: (focusArtwork) => set((state) => { state.view.focusArtwork = focusArtwork }),
  }
}

/** The theme the page draws (G8 order): `?theme=` for this visit, else the saved choice (which defaults to the system). */
export function themeChoiceInUse(view: Pick<ViewState, 'theme' | 'themeForThisVisit'>): ThemeChoice {
  return view.themeForThisVisit ?? view.theme
}

/** The area My Work shows: an area merged away shows its target, a dismissed one every request. */
export function shownFocusAreaId(view: Pick<ViewState, 'section' | 'focusChoice'>, focusAreas: Parameters<typeof resolveFocusAreaId>[1]): string | null {
  if (view.section !== 'work') return null
  return view.focusChoice === OTHER_FOCUS_AREA_ID ? view.focusChoice : resolveFocusAreaId(view.focusChoice, focusAreas)
}
