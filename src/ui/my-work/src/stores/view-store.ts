/// <reference lib="dom" />
import { create } from 'zustand'
import type { Request } from '../data.ts'

export type Page = 'setup' | 'work' | 'goals' | 'rules'
export type WorkView = 'cards' | 'list' | 'agents' | 'team'
export type WorkFilter = 'all' | 'needs-you' | 'shipped' | 'closed'
export type WorkSort = 'attention' | 'started' | 'progress'
export const VIEW_STORAGE_KEY = 'claude-mem:my-work:view:v1'
type Preferences = { dark: boolean; view: WorkView; filter: WorkFilter; sort: WorkSort; team: boolean }
type Route = { page: Page; requestId: string | null; goalId: string | undefined }
type Selection = { id: string; fromLiveFeed: boolean | null; fallback: Request | null }
type Environment = {
  storage?: Pick<Storage, 'getItem' | 'setItem'>
  href?: () => string
  writeUrl?: (url: URL, replace: boolean) => void
  dark?: boolean
}

export function readViewRoute(url: URL): Route {
  const page = url.searchParams.get('page')
  const goalId = url.searchParams.get('goal') || undefined
  return {
    page: url.searchParams.get('setup') === '1' ? 'setup' : page === 'goals' || page === 'rules' || page === 'work' ? page : goalId ? 'goals' : 'work',
    requestId: url.searchParams.get('request') || null,
    goalId,
  }
}

export function writeViewRoute(url: URL, route: Route) {
  const next = new URL(url)
  next.searchParams.delete('setup')
  if (route.page === 'setup') next.searchParams.set('setup', '1')
  else next.searchParams.set('page', route.page)
  if (route.requestId) next.searchParams.set('request', route.requestId)
  else next.searchParams.delete('request')
  if (route.goalId) next.searchParams.set('goal', route.goalId)
  else next.searchParams.delete('goal')
  return next
}

function readPreferences(environment: Environment): Preferences {
  const defaults: Preferences = { dark: environment.dark ?? false, view: 'cards', filter: 'all', sort: 'attention', team: false }
  try {
    const saved = JSON.parse(environment.storage?.getItem(VIEW_STORAGE_KEY) ?? 'null')
    if (saved?.version !== 1 || !saved.preferences) return defaults
    const value = saved.preferences
    return {
      dark: typeof value.dark === 'boolean' ? value.dark : defaults.dark,
      view: ['cards', 'list', 'agents', 'team'].includes(value.view) ? value.view : defaults.view,
      filter: ['all', 'needs-you', 'shipped', 'closed'].includes(value.filter) ? value.filter : defaults.filter,
      sort: ['attention', 'started', 'progress'].includes(value.sort) ? value.sort : defaults.sort,
      team: typeof value.team === 'boolean' ? value.team : defaults.team,
    }
  } catch { return defaults }
}

interface ViewState extends Preferences {
  page: Page
  goalId: string | undefined
  selection: Selection | null
  showSpec: boolean
  sampleMode: 'home' | 'web'
  setDark: (dark: boolean) => void
  setView: (view: WorkView) => void
  setFilter: (filter: WorkFilter) => void
  setSort: (sort: WorkSort) => void
  setTeam: (team: boolean) => void
  setSampleMode: (mode: 'home' | 'web') => void
  setShowSpec: (show: boolean) => void
  goToPage: (page: Page, replace?: boolean) => void
  goToGoal: (id: string) => void
  openRequest: (request: Request, fromLiveFeed: boolean) => void
  closeRequest: () => void
  reconcileRequests: (requests: Request[], goalOnlyRequests: Request[]) => void
  syncUrl: () => void
}

/** Only display preferences are stored. Server records and request fallbacks stay in memory. */
export function createViewStore(environment: Environment = {}) {
  const url = () => new URL(environment.href?.() ?? 'http://localhost/')
  const initial = readViewRoute(url())
  const preferences = readPreferences(environment)
  const theme = url().searchParams.get('theme')
  if (theme === 'dark' || theme === 'light') preferences.dark = theme === 'dark'
  if (!preferences.team && preferences.view === 'team') preferences.view = 'cards'
  const store = create<ViewState>()((set, get) => {
    const navigate = (route: Route, selection: Selection | null, replace = false) => {
      set({ page: route.page, goalId: route.goalId, selection })
      const next = writeViewRoute(url(), route)
      if (next.href !== url().href) environment.writeUrl?.(next, replace)
    }
    return {
      ...preferences, page: initial.page, goalId: initial.goalId,
      selection: initial.requestId ? { id: initial.requestId, fromLiveFeed: null, fallback: null } : null,
      sampleMode: 'home', showSpec: false,
      setDark: (dark) => {
        set({ dark })
        const current = url()
        if (current.searchParams.has('theme')) {
          current.searchParams.set('theme', dark ? 'dark' : 'light')
          environment.writeUrl?.(current, true)
        }
      },
      setView: (view) => set({ view: view === 'team' && !get().team ? 'cards' : view }),
      setFilter: (filter) => set({ filter }),
      setSort: (sort) => set({ sort }),
      setTeam: (team) => set({ team, ...(!team && get().view === 'team' ? { view: 'cards' as const } : {}) }),
      setSampleMode: (sampleMode) => set({ sampleMode }),
      setShowSpec: (showSpec) => set({ showSpec }),
      goToPage: (page, replace = false) => navigate({ page, goalId: undefined, requestId: null }, null, replace),
      goToGoal: (goalId) => navigate({ page: 'goals', goalId, requestId: null }, null),
      openRequest: (request, fromLiveFeed) => navigate({ page: get().page, goalId: get().goalId, requestId: request.id }, { id: request.id, fromLiveFeed, fallback: fromLiveFeed ? null : request }),
      closeRequest: () => navigate({ page: get().page, goalId: get().goalId, requestId: null }, null),
      reconcileRequests: (requests, goalOnlyRequests) => {
        const selection = get().selection
        if (!selection) return
        const live = requests.find((request) => request.id === selection.id)
        const goal = goalOnlyRequests.find((request) => request.id === selection.id)
        if (selection.fromLiveFeed === null && (live || goal)) {
          set({ selection: { id: selection.id, fromLiveFeed: !!live, fallback: live ? null : goal! } })
        } else if ((!live && selection.fromLiveFeed === true) || (!live && !goal && !selection.fallback)) {
          navigate({ page: get().page, goalId: get().goalId, requestId: null }, null, true)
        }
      },
      syncUrl: () => {
        const route = readViewRoute(url())
        set({ page: route.page, goalId: route.goalId, selection: route.requestId ? { id: route.requestId, fromLiveFeed: null, fallback: null } : null })
      },
    }
  })
  store.subscribe((state, previous) => {
    if (state.dark === previous.dark && state.view === previous.view && state.filter === previous.filter && state.sort === previous.sort && state.team === previous.team) return
    const { dark, view, filter, sort, team } = state
    try { environment.storage?.setItem(VIEW_STORAGE_KEY, JSON.stringify({ version: 1, preferences: { dark, view, filter, sort, team } })) } catch { /* Storage may be blocked or full; the current view still works. */ }
  })
  return store
}

function browserEnvironment(): Environment {
  if (typeof window === 'undefined') return {}
  let storage: Storage | undefined
  try { storage = window.localStorage } catch { /* Private or restricted browser. */ }
  return {
    storage, href: () => window.location.href,
    writeUrl: (url, replace) => window.history[replace ? 'replaceState' : 'pushState'](null, '', url),
    dark: window.matchMedia('(prefers-color-scheme: dark)').matches,
  }
}

export const useViewStore = createViewStore(browserEnvironment())

export function startViewNavigation() {
  const sync = () => useViewStore.getState().syncUrl()
  window.addEventListener('popstate', sync)
  window.addEventListener('hashchange', sync)
  return () => {
    window.removeEventListener('popstate', sync)
    window.removeEventListener('hashchange', sync)
  }
}
