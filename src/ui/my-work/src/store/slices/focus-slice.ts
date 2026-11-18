// My Focus saves: one at a time, the last one kept for the saved note's Undo, and the last one that failed kept with the
// screen that made it (FailedFocusSave). Undo writes the changes that put things back (focus-changes.tsx works them out
// when the change is made).
import type { SliceCreator } from '../create-store.ts'
import type { FailedFocusSave, FocusSlice } from '../store-types.ts'
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
  /**
   * One save at a time; a save that fails is kept as the one failed save (FailedFocusSave), with why. `ifItFails` names
   * the save, read before it runs (an Undo's words are those of the change it undoes, which the Undo takes off the
   * history); null for a save with nothing to send, which cannot fail.
   */
  const oneAtATime = async (save: () => Promise<void>, ifItFails: () => Omit<FailedFocusSave, 'reason'> | null) => {
    if (get().focus.saving) return false
    const failure = ifItFails()
    set((state) => { state.focus.saving = true; state.focus.failed = null })
    try {
      await save()
      return true
    } catch (error) {
      if (!failure) throw error
      set((state) => { state.focus.failed = { ...failure, reason: messageOf(error) } })
      return false
    } finally {
      set((state) => { state.focus.saving = false })
    }
  }

  return {
    focus: { history: [], saving: false, failed: null },

    applyFocusChange: (change, record, { words, place }) => oneAtATime(async () => {
      const saved = await get().saveFocusChange(change)
      if (record) set((state) => { state.focus.history.push({ ...record, expectedVersions: undoVersions(record.undo, saved) }) })
    }, () => ({ attempt: { kind: 'change', change, record }, words, place })),

    forgetFailedFocusSave: (place) => {
      if (get().focus.failed?.place === place) set((state) => { state.focus.failed = null })
    },

    undoLastFocusChange: (place) => oneAtATime(async () => {
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
    }, () => {
      const last = get().focus.history.at(-1)
      return last?.undo ? { attempt: { kind: 'undo' }, words: last, place } : null
    }),
  }
}
