// Where the person is (the URL holds it, so reload and Back/Forward work) and how they like to see My Work
// (persisted: index.ts names the fields).
import { OTHER_FOCUS_AREA_ID } from '../../data.ts'
import { isCardGroupId, type CardGroupId } from '../../live/card-groups.ts'
import { isThemeChoice, type ThemeChoice } from '../../lib/theme.ts'
import { requestsAreaChoices, type RequestsArea } from '../../live/requests-areas.ts'
import { resolveFocusAreaId } from '../../live/to-focus-model.ts'
import { usageReport } from '../../live/usage.ts'
import { WORK_VIEW_SECTIONS } from '../../../../../shared/work-view-pages.ts'
import type { MyWorkPlaceId } from '../../../../app-places.ts'
import type { SliceCreator } from '../create-store.ts'
import type { OpenRequest, Page, ScrollTarget, Section, StoreEnvironment, ViewSlice, ViewState } from '../store-types.ts'

/**
 * How Requests can group its rows instead of listing them (`?by=`): by agent, its only grouping (design pass Phase 5,
 * Codex D06). The one list: the route, the store and the page take it from here.
 */
export const REQUESTS_GROUPINGS = ['agent'] as const
export type RequestsGrouping = typeof REQUESTS_GROUPINGS[number]
const isRequestsGrouping = (value: string | null): value is RequestsGrouping => (REQUESTS_GROUPINGS as readonly (string | null)[]).includes(value)

/**
 * Requests' list details, in the address on its list only (design pass Phase 5; Phase 3: "Filters live in the URL so
 * Back restores them"): the status tab (`?status=`, a CARD_GROUPS id; none is All), the focus area (`?area=`, a
 * RequestsArea), the closed requests instead of the open ones (`?closed=1`) and the find box's words (`?q=`). Requests'
 * sort is not one: it is the saved display preference the old board shares (`view.sort`).
 */
type RequestsListDetails = Pick<ViewState, 'requestsStatus' | 'requestsArea' | 'requestsClosed' | 'requestsWords'>
const NO_REQUESTS_LIST_DETAILS: RequestsListDetails = { requestsStatus: null, requestsArea: null, requestsClosed: false, requestsWords: null }
type RequestsDetails = RequestsListDetails & Pick<ViewState, 'requestsBy'>
/** `?closed=` while the closed requests are shown; any other value reads as the open ones. */
const CLOSED_FLAG = '1'

/**
 * The one rule for Requests' details: none on any other page, and none of the list's beside a grouping (By agent has no
 * status tabs and no Filter and sort, so its address never names one).
 */
function requestsDetailsShown(section: Section, details: RequestsDetails): RequestsDetails {
  if (section !== 'requests') return { ...NO_REQUESTS_LIST_DETAILS, requestsBy: null }
  if (details.requestsBy !== null) return { ...NO_REQUESTS_LIST_DETAILS, requestsBy: details.requestsBy }
  const { requestsStatus, requestsArea, requestsClosed, requestsWords } = details
  return { requestsStatus, requestsArea, requestsClosed, requestsWords, requestsBy: null }
}

interface Route extends RequestsDetails {
  page: Page; section: Section; focusChoice: string | null; requestId: string | null; theme: ThemeChoice | null; findQuery: string | null
}

/** The part of the view an address names. */
export type RoutePlace = Pick<ViewState, 'section' | 'focusChoice' | 'openRequest' | 'findQuery'> & RequestsDetails

/** No page's own details: what a move to a page (the bar's places, a link between pages) starts with. */
export const NO_PAGE_DETAILS: Omit<RoutePlace, 'section' | 'openRequest'> = { focusChoice: null, findQuery: null, ...NO_REQUESTS_LIST_DETAILS, requestsBy: null }

/**
 * A move on Requests: `by` its grouping (none is the list); on the list a status tab (null is All), an area (null is
 * every area) and the closed requests or the open ones. Left out, a list detail stays as it is shown.
 */
export interface RequestsMove { by?: RequestsGrouping | null; status?: CardGroupId | null; area?: RequestsArea | null; closed?: boolean }

/**
 * Where a move on Requests goes. On its list, from its list, the details the move names replace the shown ones and the
 * others stay (a status tab keeps the area, the closed choice and the words). From another page or from By agent the
 * list opens with only what the move names, and By agent has none of the list's details.
 */
export function requestsPlace(shown: RoutePlace, { by = null, status, area, closed }: RequestsMove): Omit<RoutePlace, 'openRequest'> {
  const kept = shown.section === 'requests' && shown.requestsBy === null ? shown : NO_REQUESTS_LIST_DETAILS
  return {
    section: 'requests', focusChoice: null, findQuery: null,
    ...requestsDetailsShown('requests', {
      requestsBy: by,
      requestsStatus: status === undefined ? kept.requestsStatus : status,
      requestsArea: area === undefined ? kept.requestsArea : area,
      requestsClosed: closed ?? kept.requestsClosed,
      requestsWords: kept.requestsWords,
    }),
  }
}

/** Addresses from before the bar: the two places on the home page that had their own address are pages now. */
const OLD_HOME_ANCHOR_PAGES: Record<string, Section> = { '#focus-areas': 'focus', '#all-requests': 'requests' }

/** Where a move to a page scrolls: every page opens from its top (Focus areas is a page of its own since Phase 6). */
const PAGE_TOP: ScrollTarget = { to: 'top' }

/**
 * `?setup=1` is the installer handoff; `?view=` a page other than My Work; `?focus=` an area; `?request=` the open
 * request; `?theme=` the theme for this visit; `?q=` the words typed in Find work, or in Requests' find box (empty, or
 * on any other page, they read as none). On Requests, `?by=` its grouping (REQUESTS_GROUPINGS), and on its list
 * `?status=`, `?area=` and `?closed=1` (RequestsListDetails); a value no list names reads as none, and an area no
 * request sits in reads as none once the work is read (reconcileRequestsDetails). `/#focus-areas` and
 * `/#all-requests`, the home page's anchors before the bar, read as `?view=focus` and `?view=requests`. A page's other
 * details (a tab, a filter) join the address in the design pass phase that first reads them, each typed from its one
 * definition.
 */
export function readRoute(url: URL): Route {
  const view = url.searchParams.get('view') as Section | null
  const oldAnchorPage = !view && !url.searchParams.get('focus') ? OLD_HOME_ANCHOR_PAGES[url.hash] ?? null : null
  const section = view && WORK_VIEW_SECTIONS.includes(view) ? view : oldAnchorPage ?? 'work'
  const focusChoice = section === 'work' ? url.searchParams.get('focus') || null : null
  const theme = url.searchParams.get('theme')
  const by = url.searchParams.get('by')
  const status = url.searchParams.get('status')
  return {
    page: url.searchParams.get('setup') === '1' ? 'setup' : 'app',
    section,
    focusChoice,
    requestId: url.searchParams.get('request') || null,
    // G8: `?theme=` wins over the saved choice for this visit only (view.themeForThisVisit; never saved).
    theme: isThemeChoice(theme) ? theme : null,
    findQuery: section === 'find' ? url.searchParams.get('q') || null : null,
    ...requestsDetailsShown(section, {
      requestsBy: isRequestsGrouping(by) ? by : null,
      requestsStatus: isCardGroupId(status) ? status : null,
      requestsArea: url.searchParams.get('area') || null,
      requestsClosed: url.searchParams.get('closed') === CLOSED_FLAG,
      requestsWords: url.searchParams.get('q') || null,
    }),
  }
}

/** The same URL with the route's params; every other param (`source`, `theme`) is kept, and an old home anchor dropped. */
export function writeRoute(url: URL, view: RoutePlace): URL {
  const next = new URL(url)
  const set = (name: string, value: string | null) => { if (value) next.searchParams.set(name, value); else next.searchParams.delete(name) }
  set('view', view.section === 'work' ? null : view.section)
  set('focus', view.section === 'work' ? view.focusChoice : null)
  const requests = requestsDetailsShown(view.section, view)
  set('status', requests.requestsStatus)
  set('by', requests.requestsBy)
  set('area', requests.requestsArea)
  set('closed', requests.requestsClosed ? CLOSED_FLAG : null)
  set('request', view.openRequest?.id ?? null)
  set('q', view.section === 'find' ? view.findQuery : requests.requestsWords)
  next.hash = ''
  return next
}

/**
 * The bar's place each page sits under, which the bar marks. Workspace and Machine and sync sit under the bar's "…"
 * and Find work under its own Find work link, which mark themselves (components/app-bar.tsx), so no place is marked
 * there. Until the design pass builds it (Phase 7), Build story opens My Work's home page, so it marks My Work.
 */
const PLACE_OF_SECTION: Record<Section, MyWorkPlaceId | null> = {
  work: 'work',
  focus: 'focus',
  suggested: 'focus',
  'past-focus': 'focus',
  'build-story': 'work',
  requests: 'requests',
  'review-stack': 'review-stack',
  rules: 'rules',
  workspace: null,
  machine: null,
  find: null,
}

/** The place the bar marks for this view (none on a page reached from the bar's utilities): a focus area's page (and Other's) sits under Focus areas. */
export function activePlace(view: Pick<ViewState, 'section' | 'focusChoice'>): MyWorkPlaceId | null {
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
  // back to it by a reload or by Back from another site; else where the browser opens it, at its top.
  const openedScrolledTo = environment.savedScrollY()
  const openingScroll: ScrollTarget | null = openedScrolledTo !== null ? { to: 'position', y: openedScrolledTo } : null

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
      findQuery: route.findQuery,
      requestsStatus: route.requestsStatus,
      requestsBy: route.requestsBy,
      requestsArea: route.requestsArea,
      requestsClosed: route.requestsClosed,
      requestsWords: route.requestsWords,
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

    goToPage: (page, options) => navigate({ section: page, ...NO_PAGE_DETAILS },
      { scroll: options?.elementId ? { to: 'element', elementId: options.elementId } : PAGE_TOP }),
    goToFocus: (focusAreaId) => navigate({ section: 'work', ...NO_PAGE_DETAILS, focusChoice: focusAreaId, openRequest: null }, { scroll: { to: 'top' } }),
    // A status tab, an area or the closed choice is a new history entry (Back brings the last one back) and leaves the
    // window where it is: they sit at the list's top. Another page, or the list and By agent changing places, opens
    // from the top.
    showRequests: (move) => {
      const { section, requestsBy } = get().view
      const sameLayout = section === 'requests' && requestsBy === (move.by ?? null)
      navigate(requestsPlace(get().view, move), sameLayout ? {} : { scroll: { to: 'top' } })
    },
    // Each word typed replaces the address instead of adding a history entry: Back leaves Find work, not one letter.
    setFindQuery: (query) => navigate({ findQuery: query === '' ? null : query }, { replace: true }),
    // The same for Requests' find box, on its list.
    setRequestsWords: (words) => navigate({ requestsWords: words === '' ? null : words }, { replace: true }),

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

    // On Requests, once the work is read, an area no request sits in (merged away, dismissed, or never one) reads as
    // every area. Then an address that names what the page does not apply (a status beside By agent, a value no list
    // names, that area) is rewritten in place to the page's own, so the address never claims a filter that is off.
    // Runs on every model and after Back or Forward; a fragment (the skip link's) is kept.
    reconcileRequestsDetails: () => {
      const { section, requestsArea } = get().view
      if (section !== 'requests') return
      const load = get().work.load
      if (load.state === 'loaded' && requestsArea !== null && !requestsAreaChoices(load.model.requests, load.model.focusAreas).includes(requestsArea)) {
        set((state) => { state.view.requestsArea = null })
      }
      const current = new URL(environment.href())
      const written = writeRoute(current, get().view)
      if (written.search === current.search) return
      written.hash = current.hash
      environment.writeUrl(written, true)
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
        state.view.findQuery = next.findQuery
        state.view.requestsStatus = next.requestsStatus
        state.view.requestsBy = next.requestsBy
        state.view.requestsArea = next.requestsArea
        state.view.requestsClosed = next.requestsClosed
        state.view.requestsWords = next.requestsWords
        // Back and Forward land where the person left that page, once it has drawn again (App.tsx, lib/scroll-ask.ts).
        if (savedScrollY !== null) state.view.scrollAsk = scrollAsk({ to: 'position', y: savedScrollY })
      })
      if (environment.reportsUsage && next.section !== previous) environment.sendUsage(usageReport(next.section, previous))
      get().reconcileOpenRequest()
      get().reconcileFocusChoice()
      get().reconcileRequestsDetails()
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
