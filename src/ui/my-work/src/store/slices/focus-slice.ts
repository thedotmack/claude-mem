// My Focus saves: one at a time, the last one kept for the saved note's Undo. Undo writes the changes that put
// things back (focus-changes.tsx works them out when the change is made).
import type { SliceCreator } from '../create-store.ts'
import type { FocusSlice } from '../store-types.ts'

const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error)

export const createFocusSlice: SliceCreator<FocusSlice> = (set, get) => {
  const oneAtATime = async (save: () => Promise<void>) => {
    if (get().focus.saving) return false
    set((state) => { state.focus.saving = true; state.focus.error = null })
    try {
      await save()
      return true
    } catch (error) {
      set((state) => { state.focus.error = messageOf(error) })
      return false
    } finally {
      set((state) => { state.focus.saving = false })
    }
  }

  return {
    focus: { history: [], saving: false, error: null },

    applyFocusChange: (change, record) => oneAtATime(async () => {
      await get().saveFocusChange(change)
      if (record) set((state) => { state.focus.history.push(record) })
    }),

    undoLastFocusChange: () => oneAtATime(async () => {
      const undo = get().focus.history.at(-1)?.undo
      if (!undo) return
      for (const step of undo) await get().saveFocusChange(step)
      set((state) => { state.focus.history.pop() })
    }),
  }
}
