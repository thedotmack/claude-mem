// Where the person is (the URL holds it, so reload and Back/Forward work) and how they like to see My Work
// (persisted: index.ts names the fields).
import { OTHER_FOCUS_AREA_ID } from '../../data.ts'
import { isThemeChoice, type ThemeChoice } from '../../lib/theme.ts'
import { resolveFocusAreaId } from '../../live/to-focus-model.ts'
import { usageReport } from '../../live/usage.ts'
import { WORK_VIEW_SECTIONS } from '../../../../../shared/work-view-pages.ts'
import type { MyWorkPlaceId } from '../../../../app-places.ts'
import type { SliceCreator } from '../create-store.ts'
import type { OpenRequest, Page, ScrollTarget, Section, StoreEnvironment, ViewSlice, ViewState } from '../store-types.ts'

interface Route { page: Page; section: Section; focusChoice: string | null; requestId: string | null; theme: ThemeChoice | null }

/** The part of the view an address names. */
export type RoutePlace = Pick<ViewState, 'section' | 'focusChoice' | 'openRequest'>

/** Addresses from before the bar: the two places on the home page that had their own address are pages now. */
const OLD_HOME_ANCHOR_PAGES: Record<string, Section> = { '#focus-areas': 'focus', '#all-requests': 'requests' }

/**
 * Where a move to a page scrolls. Requests and Focus areas open the home page at its board of every request and its
 * focus area board until the design pass gives them pages of their own (phases 5 and 7); every other page from its top.
 */
const PAGE_BOARD_ELEMENT: Partial<Record<Section, string>> = { requests: 'all-requests', focus: 'focus-areas' }
const pageScroll = (section: Section): ScrollTarget => {
  const elementId = PAGE_BOARD_ELEMENT[section]
  return elementId ? { to: 'element', elementId } : { to: 'top' }
}

/**
 * `?setup=1` is the installer handoff; `?view=` a page other than My Work; `?focus=` an area; `?request=` the open
 * request; `?theme=` the theme for this visit. `/#focus-areas` and `/#all-requests`, the home page's anchors before the
 * bar, read as `?view=focus` and `?view=requests`. A page's own details (a tab, a filter, Find's words) join the address
 * in the design pass phase that first reads them, each typed from its one definition.
 */
export function readRoute(url: URL): Route {
  const view = url.searchParams.get('view') as Section | null
  const oldAnchorPage = !view && !url.searchParams.get('focus') ? OLD_HOME_ANCHOR_PAGES[url.hash] ?? null : null
  const section = view && WORK_VIEW_SECTIONS.includes(view) ? view : oldAnchorPage ?? 'work'
  const focusChoice = section === 'work' ? url.searchParams.get('focus') || null : null
  const theme = url.searchParams.get('theme')
  return {
    page: url.searchParams.get('setup') === '1' ? 'setup' : 'app',
    section,
    focusChoice,
    requestId: url.searchParams.get('request') || null,
    // G8: `?theme=` wins over the saved choice for this visit only (view.themeForThisVisit; never saved).
    theme: isThemeChoice(theme) ? theme : null,
  }
}

/** The same URL with the route's params; every other param (`source`, `theme`) is kept, and an old home anchor dropped. */
export function writeRoute(url: URL, view: RoutePlace): URL {
  const next = new URL(url)
  const set = (name: string, value: string | null) => { if (value) next.searchParams.set(name, value); else next.searchParams.delete(name) }
  set('view', view.section === 'work' ? null : view.section)
  set('focus', view.section === 'work' ? view.focusChoice : null)
  set('request', view.openRequest?.id ?? null)
  next.hash = ''
  return next
}

/**
 * The bar's place each page sits under, which the bar marks. Until the design pass builds them (phases 4 and 7),
 * Workspace, Machine and sync, Find work and Build story open My Work's home page, so they mark My Work
 * (components/app-bar.tsx heads them My Work too).
 */
const PLACE_OF_SECTION: Record<Section, MyWorkPlaceId> = {
  work: 'work',
  focus: 'focus',
  suggested: 'focus',
  'past-focus': 'focus',
  'build-story': 'work',
  requests: 'requests',
  'review-stack': 'review-stack',
  rules: 'rules',
  workspace: 'work',
  machine: 'work',
  find: 'work',
}

/** The place the bar marks for this view: a focus area's page (and Other's) sits under Focus areas. */
export function activePlace(view: Pick<ViewState, 'section' | 'focusChoice'>): MyWorkPlaceId {
  if (view.section === 'work' && view.focusChoice) return 'focus'
  return PLACE_OF_SECTION[view.section]
}

export const createViewSlice = (environment: StoreEnvironment): SliceCreator<ViewSlice> => (set, get) => {
  const route = readRoute(new URL(environment.href()))
  let openReported = false
  // Every scroll ask gets a sequence number this store never used, so a new ask always differs from an old one.
  let scrollAsks = 0
  const scrollAsk = (target: ScrollTarget) => ({ sequence: ++scrollAsks, target })
  // Where the page opens, once it has drawn (ask 1): where the person left this history entry scrolled, when they come
  // back to it by a reload or by Back from another site; else Requests' or Focus areas' board on the home page.
  const openedScrolledTo = environment.savedScrollY()
  const openingScroll: ScrollTarget | null = openedScrolledTo !== null ? { to: 'position', y: openedScrolledTo }
    : PAGE_BOARD_ELEMENT[route.section] ? pageScroll(route.section) : null

  /**
   * Shows the next place and records it in the URL. Showing another section is counted with the section it left. A move
   * with `scroll` asks the page to scroll there once it has drawn.
   */
  const navigate = (change: Partial<RoutePlace>, { replace = false, scroll }: { replace?: boolean; scroll?: ScrollTarget } = {}) => {
    const previous = get().view.section
    set((state) => {
      Object.assign(state.view, change)
      if (scroll) state.view.scrollAsk = scrollAsk(scroll)
    })
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
      scrollAsk: openingScroll ? scrollAsk(openingScroll) : null,
      workspace: { mode: 'home', team: false, connected: false },
      showSpec: false,
      // The saved choice replaces this when there is one (create-store.ts merge); `?theme=` sits beside it.
      theme: 'system',
      themeForThisVisit: route.theme,
      listView: 'cards',
      filter: 'all',
      sort: 'attention',
      // The home board opens as compact rows with a 56px picture (page-01, c-focus-overview); Full is one press away in
      // its Artwork control, and a saved choice wins.
      focusArtwork: 'compact',
    },

    goToPage: (page) => navigate({ section: page, focusChoice: null }, { scroll: pageScroll(page) }),
    goToFocus: (focusAreaId) => navigate({ section: 'work', focusChoice: focusAreaId, openRequest: null }, { scroll: { to: 'top' } }),

    openRequestDrawer: (request, options) => {
      const open: OpenRequest = { id: request.id, fromLiveFeed: requestInFeed(request.id) !== null, fallback: request, ...(options?.reply ? { replyAsked: true } : {}) }
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
      else if (!live && open.fromLiveFeed !== false) navigate({ openRequest: null }, { replace: true })
    },

    // An area's address whose area this work does not show (dismissed, or not in it) shows the home page, so the
    // address becomes the home page's too: the address, the h1 and the bar's marked place then agree. Runs on every
    // model and after Back or Forward; the drawer, if one is open, stays.
    reconcileFocusChoice: () => {
      const { section, focusChoice } = get().view
      const load = get().work.load
      if (load.state !== 'loaded' || focusChoice === null) return
      if (shownFocusAreaId({ section, focusChoice }, load.model.focusAreas) === null) navigate({ focusChoice: null }, { replace: true })
    },

    showUrl: () => {
      const next = readRoute(new URL(environment.href()))
      const savedScrollY = environment.savedScrollY()
      const open = get().view.openRequest
      const previous = get().view.section
      set((state) => {
        state.view.section = next.section
        state.view.focusChoice = next.focusChoice
        state.view.openRequest = !next.requestId ? null : open?.id === next.requestId ? open : { id: next.requestId, fromLiveFeed: null, fallback: null }
        // Back and Forward land where the person left that page, once it has drawn again (App.tsx, lib/scroll-ask.ts).
        if (savedScrollY !== null) state.view.scrollAsk = scrollAsk({ to: 'position', y: savedScrollY })
      })
      if (environment.reportsUsage && next.section !== previous) environment.sendUsage(usageReport(next.section, previous))
      get().reconcileOpenRequest()
      get().reconcileFocusChoice()
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
      // `?theme=` only starts a visit (G8). A choice made in the menu is saved, so the address stops overriding it;
      // otherwise a reload would bring back the address's theme. The address changes first: the places' links are
      // drawn again when the visit's theme changes (lib/place-link.ts), and they read the address as it is then.
      const url = new URL(environment.href())
      if (url.searchParams.has('theme')) {
        url.searchParams.delete('theme')
        environment.writeUrl(url, true)
      }
      set((state) => { state.view.theme = theme; state.view.themeForThisVisit = null })
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
