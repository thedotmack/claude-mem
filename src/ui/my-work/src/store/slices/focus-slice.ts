// My Focus saves: one at a time, the last one kept for the saved note's Undo. Undo writes the changes that put
// things back (focus-changes.tsx works them out when the change is made).
import type { SliceCreator } from '../create-store.ts'
import type { FocusSlice } from '../store-types.ts'
import type { FocusChange } from '../../data.ts'
import type { WorkModel } from '../../live/work-data-source.ts'
import { FOCUS_CHANGED_MESSAGE, focusChangeVersion } from '../../../../../shared/focus-change-version.ts'

const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error)

/** Only the saved records an Undo would change, excluding clocks and activity in other areas. */
function undoVersions(undo: FocusChange[] | null, model: WorkModel): string[] | null {
  if (!undo?.length) return null
  const versions: string[] = []
  for (const step of undo) {
    const version = focusChangeVersion(step, model.focusAreas, model.requests)
    if (version === null) return null
    versions.push(version)
  }
  return versions
}

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
      const saved = await get().saveFocusChange(change)
      if (record) set((state) => { state.focus.history.push({ ...record, expectedVersions: undoVersions(record.undo, saved) }) })
    }),

    undoLastFocusChange: () => oneAtATime(async () => {
      const last = get().focus.history.at(-1)
      const undo = last?.undo
      if (!undo) return
      for (let index = 0; index < undo.length; index++) {
        const current = get().focus.history.at(-1)!
        const load = get().work.load
        const expected = current.expectedVersions
        const versions = load.state === 'loaded' ? undoVersions(current.undo, load.model) : null
        if (!expected?.length || !versions || expected.length !== versions.length || expected.some((version, i) => version !== versions[i])) {
          throw new Error(FOCUS_CHANGED_MESSAGE)
        }
        const saved = await get().saveFocusChange({ ...undo[index], expectedVersion: expected[0] })
        const remaining = undo.slice(index + 1)
        // A merge Undo can take two writes. If the second fails, keep only the unfinished step.
        if (remaining.length) set((state) => {
          const current = state.focus.history.at(-1)!
          current.undo = remaining
          current.expectedVersions = undoVersions(remaining, saved)
        })
      }
      set((state) => { state.focus.history.pop() })
    }),
  }
}
