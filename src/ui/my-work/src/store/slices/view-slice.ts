// Where the person is (the URL holds it, so reload and Back/Forward work) and how they like to see My Work
// (persisted: index.ts names the fields).
import { OTHER_FOCUS_AREA_ID } from '../../data.ts'
import { resolveFocusAreaId } from '../../live/to-focus-model.ts'
import { usageReport } from '../../live/usage.ts'
import type { SliceCreator } from '../create-store.ts'
import type { OpenRequest, Page, Section, StoreEnvironment, ViewSlice, ViewState } from '../store-types.ts'

const SECTIONS: readonly Section[] = ['work', 'rules', 'suggested', 'past-focus']

interface Route { page: Page; section: Section; focusChoice: string | null; requestId: string | null; theme: boolean | null }

/** `?setup=1` is the installer handoff; `?view=` a page other than My Work; `?focus=` an area; `?request=` the open drawer. */
export function readRoute(url: URL): Route {
  const view = url.searchParams.get('view') as Section | null
  const section = view && SECTIONS.includes(view) ? view : 'work'
  return {
    page: url.searchParams.get('setup') === '1' ? 'setup' : 'app',
    section,
    focusChoice: section === 'work' ? url.searchParams.get('focus') || null : null,
    requestId: url.searchParams.get('request') || null,
    // `?theme=dark|light` starts the wireframe's theme switch; without it, the system preference does.
    theme: url.searchParams.get('theme') === 'dark' ? true : url.searchParams.get('theme') === 'light' ? false : null,
  }
}

/** The same URL with the route's params; every other param (`source`, `theme`) is kept. */
export function writeRoute(url: URL, view: Pick<ViewState, 'section' | 'focusChoice' | 'openRequest'>): URL {
  const next = new URL(url)
  const set = (name: string, value: string | null) => { if (value) next.searchParams.set(name, value); else next.searchParams.delete(name) }
  set('view', view.section === 'work' ? null : view.section)
  set('focus', view.section === 'work' ? view.focusChoice : null)
  set('request', view.openRequest?.id ?? null)
  return next
}

export const createViewSlice = (environment: StoreEnvironment): SliceCreator<ViewSlice> => (set, get) => {
  const route = readRoute(new URL(environment.href()))
  let openReported = false

  /** Shows the next place and records it in the URL. Showing another section is counted with the section it left. */
  const navigate = (change: Partial<Pick<ViewState, 'section' | 'focusChoice' | 'openRequest'>>, replace = false) => {
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
      workspace: { mode: 'home', team: false, connected: false },
      showSpec: false,
      dark: route.theme ?? environment.prefersDark,
      listView: 'cards',
      filter: 'all',
      sort: 'attention',
    },

    goToPage: (page) => navigate({ section: page, focusChoice: null }),
    goToFocus: (focusAreaId) => navigate({ section: 'work', focusChoice: focusAreaId, openRequest: null }),
    selectFocus: (selection) => {
      if (!selection) get().goToPage('work')
      else if (selection.kind === 'area') get().goToFocus(selection.focusAreaId)
      else navigate({ section: selection.kind, focusChoice: null })
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
      })
      if (environment.reportsUsage && next.section !== previous) environment.sendUsage(usageReport(next.section, previous))
      get().reconcileOpenRequest()
    },

    finishSetup: () => {
      const url = new URL(environment.href())
      url.searchParams.delete('setup')
      environment.writeUrl(url, true)
      environment.scrollToTop()
      if (environment.reportsUsage) environment.sendUsage(usageReport('work', 'setup'))
      set((state) => { state.view.page = 'app'; state.view.section = 'work' })
    },

    // One count for the page the viewer opened on. StrictMode runs effects twice in development; the flag keeps it to one.
    reportOpen: () => {
      if (!environment.reportsUsage || openReported) return
      openReported = true
      const { page, section } = get().view
      environment.sendUsage(usageReport(page === 'setup' ? 'setup' : section, null))
    },

    setWorkspace: (change) => set((state) => { Object.assign(state.view.workspace, change) }),
    setShowSpec: (showSpec) => set((state) => { state.view.showSpec = showSpec }),
    setDark: (dark) => set((state) => { state.view.dark = dark }),
    setListView: (listView) => set((state) => { state.view.listView = listView }),
    setFilter: (filter) => set((state) => { state.view.filter = filter }),
    setSort: (sort) => set((state) => { state.view.sort = sort }),
  }
}

/** The area My Work shows: an area merged away shows its target, a dismissed one every request. */
export function shownFocusAreaId(view: Pick<ViewState, 'section' | 'focusChoice'>, focusAreas: Parameters<typeof resolveFocusAreaId>[1]): string | null {
  if (view.section !== 'work') return null
  return view.focusChoice === OTHER_FOCUS_AREA_ID ? view.focusChoice : resolveFocusAreaId(view.focusChoice, focusAreas)
}
