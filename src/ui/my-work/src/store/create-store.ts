// Binds the slices into the one My Work store, after MemeDeck's lib/store: immer for updates, devtools to watch
// them, persist for the display preferences only. The browser instance is index.ts; tests make their own.
import { enableMapSet, setAutoFreeze } from 'immer'
import { create, type StateCreator } from 'zustand'
import { createJSONStorage, devtools, persist } from 'zustand/middleware'
import { immer } from 'zustand/middleware/immer'
import { createFocusSlice } from './slices/focus-slice.ts'
import { createRulesSlice } from './slices/rules-slice.ts'
import { createViewSlice } from './slices/view-slice.ts'
import { createWorkSlice } from './slices/work-slice.ts'
import { savedFocusArrangement } from '../live/thread-groups.ts'
import { FOCUS_THREAD_VIEWS, WORK_FILTERS, WORK_LIST_VIEWS, type BoundStore, type StoreEnvironment, type ViewState, type WorkFilter } from './store-types.ts'

enableMapSet()
// The sample source edits its fixture objects in place (sample-source.ts), and those objects sit in the model.
// Immer would freeze them on the way in, so freezing stays off; slices still update only through set().
setAutoFreeze(false)

type Mutators = [['zustand/persist', unknown], ['zustand/devtools', never], ['zustand/immer', never]]
export type SliceCreator<Slice> = StateCreator<BoundStore, Mutators, [], Slice>

/** Bump when a persisted field changes meaning; older saved preferences are then dropped. */
const PREFERENCES_VERSION = 1
// The theme is not saved: it follows the system preference (or `?theme=`), as it always has.
type Preferences = Pick<ViewState, 'listView' | 'focusThreadView' | 'filter' | 'focusArrangement' | 'doneColumnOpen'>

/** The sortable List became the thread list (2026-11-11); a preference saved for it reads as Threads. A saved Cards is still Cards. */
const RETIRED_LIST_VIEW = 'list'
/** The board over every request became a view inside one focus (2026-11-12): a saved Board reads as the focus list, with the board inside each focus. */
const RETIRED_BOARD_VIEW = 'board'
/**
 * Done became its own bucket, hidden until asked for (2026-11-12). All showed every open request and reads as Open;
 * Shipped and Closed each showed a part of what Done now holds.
 */
const RETIRED_FILTERS: Record<string, WorkFilter> = { all: 'open', shipped: 'done', closed: 'done' }

/** Saved preferences are read back field by field; a value this version doesn't know is left at its default. */
function validPreferences(saved: unknown): Partial<Preferences> {
  const value = (saved ?? {}) as Record<string, unknown>
  const preferences: Partial<Preferences> = {}
  if (WORK_LIST_VIEWS.includes(value.listView as ViewState['listView'])) preferences.listView = value.listView as ViewState['listView']
  else if (value.listView === RETIRED_LIST_VIEW) preferences.listView = 'threads'
  else if (value.listView === RETIRED_BOARD_VIEW) Object.assign(preferences, { listView: 'threads', focusThreadView: 'board' })
  if (FOCUS_THREAD_VIEWS.includes(value.focusThreadView as ViewState['focusThreadView'])) preferences.focusThreadView = value.focusThreadView as ViewState['focusThreadView']
  if (WORK_FILTERS.includes(value.filter as WorkFilter)) preferences.filter = value.filter as WorkFilter
  else if (typeof value.filter === 'string' && Object.hasOwn(RETIRED_FILTERS, value.filter)) preferences.filter = RETIRED_FILTERS[value.filter]
  const focusArrangement = savedFocusArrangement(value.focusArrangement)
  if (focusArrangement) preferences.focusArrangement = focusArrangement
  if (typeof value.doneColumnOpen === 'boolean') preferences.doneColumnOpen = value.doneColumnOpen
  return preferences
}

export function createBoundStore(environment: StoreEnvironment) {
  return create<BoundStore>()(
    persist(
      devtools(
        immer((...a) => ({
          ...createWorkSlice(...a),
          ...createViewSlice(environment)(...a),
          ...createRulesSlice(...a),
          ...createFocusSlice(...a),
        })),
        // Zustand turns devtools off in production builds by itself.
        { name: 'claude-mem-my-work' },
      ),
      {
        name: 'claude-mem:my-work:preferences',
        version: PREFERENCES_VERSION,
        ...(environment.storage ? { storage: createJSONStorage(() => environment.storage!) } : {}),
        // Only how the person likes to see My Work is saved. Server records stay in memory.
        partialize: ({ view: { listView, focusThreadView, filter, focusArrangement, doneColumnOpen } }): Preferences => ({ listView, focusThreadView, filter, focusArrangement, doneColumnOpen }),
        merge: (saved, current) => {
          const view = { ...current.view, ...validPreferences(saved) }
          // The team view needs the team switch, which is not saved.
          if (view.listView === 'team') view.listView = 'threads'
          return { ...current, view }
        },
      },
    ),
  )
}
