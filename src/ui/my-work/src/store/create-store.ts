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
import type { BoundStore, StoreEnvironment, ViewState } from './store-types.ts'

enableMapSet()
// The sample source edits its fixture objects in place (sample-source.ts), and those objects sit in the model.
// Immer would freeze them on the way in, so freezing stays off; slices still update only through set().
setAutoFreeze(false)

type Mutators = [['zustand/persist', unknown], ['zustand/devtools', never], ['zustand/immer', never]]
export type SliceCreator<Slice> = StateCreator<BoundStore, Mutators, [], Slice>

/** Bump when a persisted field changes meaning; older saved preferences are then dropped. */
const PREFERENCES_VERSION = 1
// The theme is not saved: it follows the system preference (or `?theme=`), as it always has.
type Preferences = Pick<ViewState, 'listView' | 'filter' | 'sort'>

const LIST_VIEWS: readonly ViewState['listView'][] = ['cards', 'list', 'agents', 'team']
const FILTERS: readonly ViewState['filter'][] = ['all', 'needs-you', 'shipped', 'closed']
const SORTS: readonly ViewState['sort'][] = ['attention', 'started', 'progress']

/** Saved preferences are read back field by field; a value this version doesn't know is left at its default. */
function validPreferences(saved: unknown): Partial<Preferences> {
  const value = (saved ?? {}) as Record<string, unknown>
  const preferences: Partial<Preferences> = {}
  if (LIST_VIEWS.includes(value.listView as ViewState['listView'])) preferences.listView = value.listView as ViewState['listView']
  if (FILTERS.includes(value.filter as ViewState['filter'])) preferences.filter = value.filter as ViewState['filter']
  if (SORTS.includes(value.sort as ViewState['sort'])) preferences.sort = value.sort as ViewState['sort']
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
        partialize: ({ view: { listView, filter, sort } }): Preferences => ({ listView, filter, sort }),
        merge: (saved, current) => {
          const view = { ...current.view, ...validPreferences(saved) }
          // The team view needs the team switch, which is not saved.
          if (view.listView === 'team') view.listView = 'cards'
          return { ...current, view }
        },
      },
    ),
  )
}
